/**
 * 规范化 JSON：键排序递归、数组保序、跳过 undefined（与 JSON.stringify 语义一致）。
 * 唯一用途：审计链哈希的稳定序列化（docs/002-architecture.md §2）。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return JSON.stringify(null);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
}
