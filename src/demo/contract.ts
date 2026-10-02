import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { JsonValue } from '../contracts/index.js';
import { withDemoApi, type DemoApiVersion, type RecordedRequest } from './api.js';

/** One call of an exported consumer function and the value the demo API contract implies it must return. */
export interface ContractCase {
  id: string;
  exportName: string;
  args: JsonValue[];
  expected: JsonValue;
  /** Observable property checked by this case. */
  property: string;
  /** false: the change behind this case is outside the supported repairs; a failure here is pending review, not a repair failure. */
  supported: boolean;
  note?: string;
}
/** `blocked`: the consumer could not be executed (harness error, timeout), so nothing was checked. */
export type ContractStatus = 'passed' | 'failed' | 'blocked';
export interface ContractCaseResult {
  id: string; exportName: string; property: string; supported: boolean; note?: string;
  status: ContractStatus; expected: string; actual: string; requests: RecordedRequest[];
}
export interface ContractRun { api: DemoApiVersion; module: string; cases: ContractCaseResult[] }
export interface ContractOptions {
  /** Directory holding the consumer (for example a temporary repaired copy). */
  repository: string;
  /** Safe relative path of the ES module inside `repository`. */
  module: string;
  api: DemoApiVersion;
  cases?: readonly ContractCase[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const HARNESS = join(PACKAGE_ROOT, 'demo/harness/consumer-harness.mjs');
const MAX_OUTPUT_BYTES = 65_536;

/** Cases for demo/repository/client.js; expectations come from the v1 contract the consumer was written for. */
export const DEMO_CASES: readonly ContractCase[] = Object.freeze([
  { id: 'get-user', exportName: 'getUser', args: ['42', 'en'], expected: 'Ada Lovelace', supported: true,
    property: 'getUser reaches the user operation with its locale query and reads the user name from the response' },
  { id: 'create-user', exportName: 'createUser', args: ['Ada'], expected: 'user-42', supported: true,
    property: 'createUser sends a request body the API accepts and reads the created id' },
  { id: 'health', exportName: 'health', args: [], expected: true, supported: true,
    property: 'health keeps working across a compatible change (optional query, added response field)' },
  { id: 'preferences', exportName: 'preferences', args: [], expected: 'light', supported: false,
    property: 'preferences reads the theme from the preferences response',
    note: 'v2 response is an ambiguous oneOf (mode simple|advanced) with no explicit mapping; left pending for manual review' },
]);

function describe(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

async function consumerModule(repository: string, module: string): Promise<{ root: string; file: string }> {
  if (!module || isAbsolute(module) || module.includes('\\') || module.includes('\0')
      || module.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe consumer module path: ${module}`);
  const root = await realpath(repository);
  let cursor = root;
  for (const part of module.split('/')) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink in consumer module path: ${module}`);
  }
  if (!(await lstat(cursor)).isFile() || !cursor.startsWith(root + sep)) throw new Error(`Consumer module is not a file inside the repository: ${module}`);
  return { root, file: cursor };
}

type HarnessOutput = { outcome: 'returned'; value?: JsonValue; undefined?: true } | { outcome: 'threw' | 'harness-error'; message: string };

/** Executes one export in a separate Node process under the permission model, with an empty environment. */
function runHarness(root: string, file: string, base: string, item: ContractCase, timeoutMs: number, signal?: AbortSignal): Promise<HarnessOutput> {
  const permission = ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${HARNESS}`];
  // Node >= 25 also gates the network behind --allow-net; the harness confines fetch to the loopback base.
  if (process.allowedNodeEnvironmentFlags.has('--allow-net')) permission.push('--allow-net');
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, ['--no-warnings', ...permission, HARNESS, file, base, item.exportName, JSON.stringify(item.args)], {
      cwd: root, env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const collect = (target: 'out' | 'err') => (chunk: Buffer): void => {
      if (target === 'out' && stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
      if (target === 'err' && stderr.length < 2_048) stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    let reason: string | undefined;
    const kill = (why: string) => (): void => { reason ??= why; child.kill('SIGKILL'); };
    const timer = setTimeout(kill(`timed out after ${timeoutMs} ms`), timeoutMs);
    const abort = kill('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const done = (output: HarnessOutput): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolveRun(output); };
    child.on('error', error => done({ outcome: 'harness-error', message: `could not start consumer harness: ${error.message}` }));
    child.on('close', code => {
      if (reason) { done({ outcome: 'harness-error', message: `consumer harness ${reason}` }); return; }
      try { done(JSON.parse(stdout) as HarnessOutput); }
      catch { done({ outcome: 'harness-error', message: `consumer harness exited ${code ?? 'without code'} with unreadable output: ${stderr.trim().slice(0, 500)}` }); }
    });
  });
}

/**
 * Runs each case of `module` against an ephemeral synthetic API (`v1` or `v2`) on 127.0.0.1.
 * Each case gets its own process and the requests the API received while it ran.
 */
export async function runConsumerContract(options: ContractOptions): Promise<ContractRun> {
  const { root, file } = await consumerModule(options.repository, options.module);
  const cases = options.cases ?? DEMO_CASES;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 1), 60_000);
  return await withDemoApi(options.api, async api => {
    const results: ContractCaseResult[] = [];
    for (const item of cases) {
      if (options.signal?.aborted) throw new Error('Contract run cancelled');
      const first = api.requests.length;
      const output = await runHarness(root, file, api.base, item, timeoutMs, options.signal);
      const expected = describe(item.expected);
      const actual = output.outcome === 'returned' ? (output.undefined ? 'undefined' : describe(output.value))
        : output.outcome === 'threw' ? `threw: ${output.message}` : `not run: ${output.message}`;
      const status: ContractStatus = output.outcome === 'harness-error' ? 'blocked' : actual === expected ? 'passed' : 'failed';
      results.push({
        id: item.id, exportName: item.exportName, property: item.property, supported: item.supported,
        ...(item.note ? { note: item.note } : {}), status, expected, actual, requests: api.requests.slice(first),
      });
    }
    return { api: options.api, module: options.module, cases: results };
  });
}
