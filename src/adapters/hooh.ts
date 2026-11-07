/**
 * HooH-MCP 客户端（adapters）—— 与 HooH 执行层的唯一边界（docs/ADR-004、docs/002 §5）。
 *
 * 协议（docs: ace/docs/MCP-SERVER.md）：
 *   stdio JSON-RPC，一行一条；initialize → tools/list → tools/call；
 *   拒绝是 result.isError:true 的**业务结果**（不是协议错误）；未知工具才 -32602；
 *   请求串行处理（对面一次跑一个工具）。
 *
 * Shepherd 侧语义：
 *   - 每次 tools/call 前后产 hooh.decided 事件入总线（审计铁律：外部裁决必须留痕）；
 *   - PERMISSION_REQUEST 文本 → 归类为 'asked'（headless 下无人应答 = fail-close 拒绝）；
 *   - 安全拒绝计数上浮（Watchdog 遥测 hoohDenyStreak 的数据源）。
 *
 * HooH 进程一行不改（ADR-004）。
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { BusLike } from '../apps/runner.ts';
import type { EventId } from '../core/events.ts';

export interface HoohMcpOptions {
  /** Python 可执行文件绝对路径（Windows 上 .cmd 启动器不可靠，用绝对路径——HooH 文档经验）。 */
  readonly pythonPath: string;
  /** ai_code.py 绝对路径。 */
  readonly serverScript: string;
  /** 项目根（HooH 的裁决边界 --project-root）。 */
  readonly projectRoot: string;
  /** 权限档：headless 默认 readonly（HooH 显式钉死，不替它放宽）。 */
  readonly permission?: 'readonly' | 'write' | 'full';
  /** 每次调用的超时（HooH 串行处理，慢工具会占住管道）。 */
  readonly callTimeoutMs?: number;
}

type PendingReq = { resolve: (r: JsonRpcResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

interface JsonRpcResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  isError?: boolean;
}

export type HoohDecision = 'allow' | 'deny' | 'sandboxed' | 'asked';

export class HoohMcpClient {
  private proc: ReturnType<typeof spawn> | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, PendingReq>();
  private readonly bus: BusLike;
  private readonly opts: HoohMcpOptions;
  private readonly emitter = new EventEmitter();
  private denyStreak = 0;
  private started = false;

  constructor(bus: BusLike, opts: HoohMcpOptions) {
    this.bus = bus;
    this.opts = opts;
  }

  /** 启动子进程并完成 initialize 握手。 */
  async start(): Promise<void> {
    if (this.started) return;
    const args = [
      this.opts.serverScript,
      '--mcp',
      '--project-root', this.opts.projectRoot,
      '--permission', this.opts.permission ?? 'readonly',
    ];
    this.proc = spawn(this.opts.pythonPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    this.proc.stdout!.setEncoding('utf-8');
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr!.setEncoding('utf-8');
    this.proc.stderr!.on('data', (chunk: string) => this.emitter.emit('stderr', chunk));
    this.proc.on('exit', code => {
      this.emitter.emit('exit', code);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`[hooh-mcp] 进程退出（code=${code}）`));
      }
      this.pending.clear();
      this.started = false;
    });
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'shepherd', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
    this.started = true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line === '') continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: JsonRpcResult; error?: { message: string } };
        if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (p !== undefined) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error !== undefined) p.reject(new Error(`[hooh-mcp] ${msg.error.message}`));
            else p.resolve(msg.result ?? {});
          }
        }
      } catch {
        this.emitter.emit('stderr', `[hooh-mcp] 非协议行: ${line.slice(0, 120)}`);
      }
    }
  }

  private request(method: string, params: unknown): Promise<JsonRpcResult> {
    return new Promise((resolve, reject) => {
      if (this.proc === null || !this.started && method !== 'initialize') {
        reject(new Error('[hooh-mcp] 未启动'));
        return;
      }
      const id = this.nextId++;
      const timeout = this.opts.callTimeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[hooh-mcp] 调用超时: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params?: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.emitter.on('exit', listener);
    return () => this.emitter.off('exit', listener);
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.emitter.on('stderr', listener);
    return () => this.emitter.off('stderr', listener);
  }

  /**
   * 调一个工具：裁决事件入总线（前后各一条：started 由调用方记，decided 在此）。
   * 返回值区分三类：allow（正常结果）、asked（PERMISSION_REQUEST=headless 拒绝）、
   * deny（其他 isError）。
   */
  async callTool(tool: string, args: Record<string, unknown>, causedBy: EventId): Promise<{ decision: HoohDecision; text: string }> {
    const r = await this.request('tools/call', { name: tool, arguments: args });
    const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
    let decision: HoohDecision;
    if (r.isError === true) {
      decision = text.includes('PERMISSION_REQUEST') ? 'asked' : 'deny';
    } else {
      decision = 'allow';
    }
    // 裁决留痕 + 拒绝连击计数（遥测）
    if (decision === 'allow') this.denyStreak = 0;
    else this.denyStreak++;
    const id = `hooh_${Date.now()}_${this.nextId++}`;
    this.bus.append(
      this.bus.child('hooh.decided', `hooh-mcp:${tool}`, { tool, decision, reason: text.slice(0, 200) }, id, causedBy),
    );
    return { decision, text };
  }

  /** 遥测读取（Watchdog 脊髓的 hooh_deny_streak 数据源）。 */
  currentDenyStreak(): number {
    return this.denyStreak;
  }

  async stop(): Promise<void> {
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.proc = null;
    this.started = false;
  }
}
