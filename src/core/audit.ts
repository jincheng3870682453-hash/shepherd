/**
 * 审计链：HMAC-SHA256 链式哈希（docs/001-glossary.md "审计链"、docs/002 §2）。
 *
 * 改任何一条历史事件即断链（后验 verify 可检出）。密钥在项目外（910 §4）。
 * core 允许 Node 的 hashing（对齐上游 core 依赖纪律：仅 Node crypto 的哈希原语，无 I/O）。
 */
import { createHmac } from 'node:crypto';
import { canonicalJson } from './canonical.ts';

export type AuditKey = string | Buffer;

const PREFIX = 'hmac:';

export function genesisHash(key: AuditKey): string {
  return PREFIX + createHmac('sha256', key).update('shepherd-genesis').digest('hex');
}

/** hash_n = HMAC(key, hash_{n-1} + '\n' + canonical(事件去掉 auditHash 后的规范化 JSON)) */
export function chainHash(prevHash: string, eventWithoutHash: object, key: AuditKey): string {
  return PREFIX + createHmac('sha256', key).update(prevHash + '\n' + canonicalJson(eventWithoutHash)).digest('hex');
}

/** 校验单个哈希格式（快速失败用，真正的完整性由 verifyChain 全链重算保证）。 */
export function looksLikeHash(value: string): boolean {
  return value.startsWith(PREFIX) && value.length === PREFIX.length + 64;
}
