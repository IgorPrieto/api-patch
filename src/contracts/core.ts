import { createHash } from 'node:crypto';
export const SCHEMA_VERSION = '1.0' as const;
export class ContractError extends Error { readonly code = 'INVALID_CONTRACT'; constructor(public readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'ContractError'; } }
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new ContractError('$', 'expected acyclic JSON data');
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) result = '[' + Array.from(item, encode).join(',') + ']';
    else { if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ContractError('$', 'expected plain JSON object'); result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode((item as Record<string, unknown>)[key])).join(',') + '}'; }
    seen.delete(item); return result;
  }
  return encode(value);
}
export function stableId(namespace: string, value: unknown): string { return `${namespace}_${sha256(canonicalJson(value)).slice(0, 24)}`; }
