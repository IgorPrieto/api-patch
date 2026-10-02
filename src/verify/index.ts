import { lstat, mkdtemp, readFile, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import ts from 'typescript';
import {
  SCHEMA_VERSION, sha256, stableId, validateDocument,
  type Evidence, type FilePatch, type RepairPlan, type VerificationReport,
  type VerificationResult, type VerifyOptions,
} from '../contracts/index.js';

const MAX_FILES = 100;
const MAX_FILE_BYTES = 5_000_000;
const MAX_OUTPUT_BYTES = 32_768;
const MAX_DIAGNOSTICS = 20;
type Level = VerificationResult['level'];

function result(planId: string, level: Level, status: VerificationResult['status'], started: number,
  properties: string[], evidence: Evidence[], reason?: string): VerificationResult {
  const identity = { planId, level, status, properties, evidence, ...(reason ? { reason } : {}) };
  return {
    id: stableId('verification', identity),
    level, status, properties, evidence, durationMs: Date.now() - started,
    environment: { node: process.version, typescript: ts.version, platform: process.platform },
    ...(reason ? { reason } : {}),
  };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Verification cancelled');
}

async function safeFile(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name) || name.includes('\\') || name.includes('\0') ||
      name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe patch path: ${name}`);
  }
  const target = resolve(root, name);
  if (!target.startsWith(root + sep)) throw new Error(`Patch path escapes repository: ${name}`);
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Symlink in patch path: ${name}`);
  }
  if (!(await lstat(target)).isFile()) throw new Error(`Patch target is not a file: ${name}`);
  return target;
}

function applyToText(source: string, patch: FilePatch): string {
  let previousEnd = -1;
  for (const edit of [...patch.edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length || edit.start <= previousEnd) {
      throw new Error(`Invalid or overlapping edit in ${patch.file}`);
    }
    if (source.slice(edit.start, edit.end) !== edit.oldText) {
      throw new Error(`Edit oldText mismatch in ${patch.file} at ${edit.start}`);
    }
    previousEnd = Math.max(edit.start, edit.end - 1);
  }
  let output = source;
  for (const edit of [...patch.edits].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
  }
  return output;
}

function reverseAppliedText(applied: string, patch: FilePatch): string {
  let delta = 0;
  const reverse = [];
  for (const edit of [...patch.edits].sort((a, b) => a.start - b.start)) {
    const start = edit.start + delta;
    const end = start + edit.newText.length;
    if (applied.slice(start, end) !== edit.newText) throw new Error(`Applied edit mismatch in ${patch.file} at ${start}`);
    reverse.push({ start, end, oldText: edit.newText, newText: edit.oldText, findingIds: [], reason: '' });
    delta += edit.newText.length - edit.oldText.length;
  }
  return applyToText(applied, { ...patch, edits: reverse });
}

/** TypeScript drops a leading BOM when reading files, so its positions are one code unit lower. */
const bomLength = (text: string): number => text.startsWith('\uFEFF') ? 1 : 0;

/** Maps a TypeScript position in the proposed copy to the baseline copy, or undefined inside edited text. */
function baselinePosition(position: number, patch: FilePatch, proposed: string, original: string): number | undefined {
  const offset = position + bomLength(proposed);
  let delta = 0;
  for (const edit of [...patch.edits].sort((a, b) => a.start - b.start)) {
    const start = edit.start + delta;
    if (offset < start) break;
    if (offset < start + edit.newText.length || (offset === start && !edit.newText.length)) return undefined;
    delta += edit.newText.length - (edit.end - edit.start);
  }
  const mapped = offset - delta - bomLength(original);
  return mapped >= 0 ? mapped : undefined;
}

function scriptKind(file: string): ts.ScriptKind | undefined {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.(ts|mts|cts)$/i.test(file)) return ts.ScriptKind.TS;
  if (/\.(js|mjs|cjs)$/i.test(file)) return ts.ScriptKind.JS;
  return undefined;
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  const position = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
  return `TS${diagnostic.code}${position ? ` ${diagnostic.file?.fileName}:${position.line + 1}:${position.character + 1}` : ''}: ${message}`;
}

const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*?(?:token|passw(?:or)?d|pwd|secret|api[_-]?key|apikey|auth(?:orization)?|credentials?|cookie|session[_-]?id|private[_-]?key|access[_-]?key)s?`;
/** Values that carry diagnostic meaning rather than a secret; kept visible. */
const NON_SECRET_VALUE = /^(?:undefined|null|none|true|false|missing|empty|unset|string|number|boolean|bigint|symbol|object|any|unknown|never)$/i;
/** Skips values already redacted by an earlier rule (including "Bearer [REDACTED]"). */
const NOT_REDACTED = String.raw`(?!\[REDACTED\]|(?:bearer|basic|digest|token)\s+\[REDACTED\])`;
const keepOrRedact = (prefix: string, value: string): string =>
  NON_SECRET_VALUE.test(value) ? prefix + value : `${prefix}[REDACTED]`;

/** Redacts credentials from command output or arguments while leaving ordinary diagnostics readable. */
export function redactSecrets(text: string): string {
  return text
    // Authorization headers with any scheme: "Authorization: Basic abc", "authorization=Bearer x".
    .replace(/(\bauthorization\b["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?([^\s"',;]+)/gi,
      (_match, prefix: string, scheme: string | undefined, value: string) =>
        scheme ? `${prefix}${scheme} [REDACTED]` : keepOrRedact(prefix, value))
    // Bare bearer credentials; require a token-like value so prose such as "Bearer token missing" survives.
    .replace(/\b(bearer\s+)((?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{3,}|[A-Za-z]{20,})/gi, '$1[REDACTED]')
    // Quoted keys as in JSON or JS objects: "token": "x", 'api_key': 123.
    .replace(new RegExp(String.raw`((["'\`])${SECRET_KEY}\2\s*:\s*)(?:(["'\`])((?:\\.|(?!\3)[^\\])*)\3|${NOT_REDACTED}([^\s,}\]]+))`, 'gi'),
      (_match, prefix: string, _q: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) =>
        quote ? (NON_SECRET_VALUE.test(quoted ?? '') || quoted?.includes('[REDACTED]') ? _match : `${prefix}${quote}[REDACTED]${quote}`) : keepOrRedact(prefix, bare ?? ''))
    // Unquoted assignments: token=x, --api-key=x, ?access_token=x, password: x.
    .replace(new RegExp(String.raw`(\b${SECRET_KEY}\s*[:=]\s*)(["']?)${NOT_REDACTED}((?=[^\s"',;&}\]]*[A-Za-z0-9])[^\s"',;&}\]]+)\2`, 'gi'),
      (_match, prefix: string, quote: string, value: string) =>
        NON_SECRET_VALUE.test(value) ? _match : `${prefix}${quote}[REDACTED]${quote}`)
    // Secret-named CLI flags followed by a separate value: --token VALUE (not "--token <value>" help text).
    .replace(new RegExp(String.raw`((?:^|\s)--?${SECRET_KEY}[ \t]+)${NOT_REDACTED}(?![-<\[])([^\s"',;]+)`, 'gim'),
      (_match, prefix: string, value: string) => NON_SECRET_VALUE.test(value) ? _match : `${prefix}[REDACTED]`)
    // Credentials embedded in URLs: scheme://user:password@host.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi, '$1[REDACTED]@');
}

const SECRET_FLAG = new RegExp(String.raw`^--?${SECRET_KEY}$`, 'i');

/** Redacts secrets inside arguments and the value following a secret-named flag such as `--token VALUE`. */
function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => index > 0 && SECRET_FLAG.test(args[index - 1]!) ? '[REDACTED]' : redactSecrets(arg));
}

/** Secret argument values, so output that echoes them verbatim (in any shape) is redacted too. */
function argSecrets(args: readonly string[]): string[] {
  const values = args.flatMap((arg, index) => {
    if (index > 0 && SECRET_FLAG.test(args[index - 1]!)) return [arg];
    const assigned = new RegExp(String.raw`^--?${SECRET_KEY}=(.+)$`, 'i').exec(arg);
    return assigned ? [assigned[1]!] : [];
  });
  return values.filter(value => value.length >= 4 && !NON_SECRET_VALUE.test(value)).sort((a, b) => b.length - a.length);
}

/** Kills spawned process groups if the host process exits while a command is still running. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function killGroup(pid: number | undefined): boolean {
  // Never signal pid 0/1 or negative: process.kill(-0) would target this process's own group.
  if (process.platform === 'win32' || pid === undefined || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { return false; }
}
function groupAlive(pid: number | undefined): boolean {
  if (process.platform === 'win32' || pid === undefined || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function trackGroup(pid: number | undefined): void {
  if (pid === undefined || process.platform === 'win32') return;
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { for (const group of liveGroups) killGroup(group); });
  }
}

const EXIT_GRACE_MS = 250;
const KILL_GRACE_MS = 2_000;
const absolutePathEntries = (): string => (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter);

async function runAuthorized(planId: string, options: VerifyOptions, started: number): Promise<VerificationResult> {
  const auth = options.authorization;
  if (!auth) return result(planId, 5, 'skipped', started, [], [], 'No explicit command authorization supplied');
  const root = await realpath(options.repository);
  let cwd: string;
  try { cwd = await realpath(auth.cwd); }
  catch { return result(planId, 5, 'blocked', started, [], [], 'Authorized cwd does not exist'); }
  if (auth.consent !== true || !auth.command || !Array.isArray(auth.args) ||
      auth.args.some(arg => typeof arg !== 'string') || (cwd !== root && !cwd.startsWith(root + sep))) {
    return result(planId, 5, 'blocked', started, [], [], 'Authorization is invalid or cwd lies outside repository');
  }
  const recorded = { ...auth, command: redactSecrets(auth.command), args: redactArgs(auth.args) };
  const secrets = argSecrets(auth.args);
  if (options.signal?.aborted) return { ...result(planId, 5, 'blocked', started, [], [], 'Cancelled'), authorization: recorded };
  const timeout = Math.min(Math.max(options.timeoutMs ?? 30_000, 1), 120_000);
  return await new Promise<VerificationResult>(resolveResult => {
    // A separate process group (POSIX) lets timeout, abort and cleanup reach grandchildren too.
    const child = spawn(auth.command, auth.args, {
      cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
      env: { PATH: absolutePathEntries(), HOME: tmpdir(), CI: '1', NODE_ENV: 'test' },
    });
    trackGroup(child.pid);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let exited = false;
    let lingering = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer): void => {
      const remaining = MAX_OUTPUT_BYTES - size;
      if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); size += Math.min(chunk.length, remaining); }
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const terminate = (): void => {
      if (!killGroup(child.pid)) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const finish = (failure?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener('abort', abort);
      // Leftover group members would otherwise survive as orphans; the pgid cannot be reused while they exist.
      if (groupAlive(child.pid)) { lingering = true; terminate(); }
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (failure !== undefined) {
        resolveResult({ ...result(planId, 5, 'blocked', started, [], [], redactSecrets(failure)), authorization: recorded });
        return;
      }
      const output = redactSecrets(secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'),
        new TextDecoder('utf-8').decode(Buffer.concat(chunks))));
      const status = cancelled || timedOut ? 'blocked' : exitCode === 0 ? 'passed' : 'failed';
      const evidence: Evidence[] = [{ kind: 'check', message: `Exit ${exitCode ?? exitSignal ?? 'none'}; output: ${output}${truncated ? ' [truncated]' : ''}` }];
      if (lingering) evidence.push({ kind: 'check', message: 'Terminated background processes left running by the authorized command' });
      resolveResult({ ...result(planId, 5, status, started, ['Authorized command exit status'], evidence,
        timedOut ? `Timed out after ${timeout} ms` : cancelled ? 'Cancelled' : undefined), authorization: recorded });
    };
    const stop = (): void => {
      terminate();
      // Do not wait on descendants that escaped the group and still hold the pipes.
      clearTimeout(grace);
      grace = setTimeout(() => finish(), exited ? EXIT_GRACE_MS : KILL_GRACE_MS);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const abort = (): void => { cancelled = true; stop(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => finish(`Could not start authorized command: ${error.message}`));
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (groupAlive(child.pid)) { lingering = true; terminate(); }
      clearTimeout(grace);
      grace = setTimeout(() => finish(), EXIT_GRACE_MS);
    });
    child.on('close', () => finish());
  });
}

/** Verifies patch integrity and transformed code without modifying the repository. */
export async function verifyRepairPlan(plan: RepairPlan, options: VerifyOptions): Promise<VerificationReport> {
  const results: VerificationResult[] = [];
  const limitations: string[] = [];
  const started = Date.now();
  let root: string;
  const transformed = new Map<string, string>();
  const originals = new Map<string, string>();
  try {
    checkAbort(options.signal);
    validateDocument('RepairPlan', plan);
    root = await realpath(options.repository);
    if (!(await lstat(root)).isDirectory()) throw new Error('Repository is not a directory');
    if (plan.files.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} patched files`);
    const seen = new Set<string>();
    for (const patch of plan.files) {
      checkAbort(options.signal);
      if (seen.has(patch.file)) throw new Error(`Duplicate patch path: ${patch.file}`);
      seen.add(patch.file);
      const path = await safeFile(root, patch.file);
      const bytes = await readFile(path);
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`Patch target exceeds ${MAX_FILE_BYTES} bytes: ${patch.file}`);
      // Keep U+FEFF: scan offsets and hashes are computed on the undecoded BOM character.
      const current = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      let original = current;
      let proposed: string;
      if (sha256(bytes) === patch.originalHash) {
        if (plan.applicationStatus === 'applied' && patch.edits.length) {
          throw new Error(`Plan says applied but repository still contains original file: ${patch.file}`);
        }
        proposed = applyToText(original, patch);
      } else if (plan.applicationStatus === 'applied') {
        original = reverseAppliedText(current, patch);
        if (sha256(original) !== patch.originalHash) throw new Error(`Original hash mismatch: ${patch.file}`);
        proposed = applyToText(original, patch);
        if (proposed !== current) throw new Error(`Applied content mismatch: ${patch.file}`);
      } else throw new Error(`Original hash mismatch: ${patch.file}`);
      originals.set(patch.file, original);
      transformed.set(patch.file, proposed);
    }
    results.push(result(plan.id, 1, 'passed', started,
      ['Plan structure', 'Safe relative paths', 'File hashes', 'Non-overlapping edits', 'Edit contents'],
      [{ kind: 'check', message: `Validated ${plan.files.length} patched file(s) against repository content` }]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push(result(plan.id ?? 'invalid', 1, 'failed', started, [], [{ kind: 'check', message }], message));
    for (const level of [2, 3, 4, 5] as const) results.push(result(plan.id ?? 'invalid', level, 'blocked', Date.now(), [], [], 'Level 1 failed'));
    return { schemaVersion: SCHEMA_VERSION, planId: plan.id ?? 'invalid', results, limitations: [message] };
  }

  const temp = await mkdtemp(join(tmpdir(), 'apipatch-verify-'));
  try {
    const patchesByFile = new Map(plan.files.map(patch => [patch.file, patch]));
    const parseStarted = Date.now();
    const syntaxErrors: string[] = [];
    const candidates: string[] = [];
    const baselineCandidates: string[] = [];
    for (const [file, content] of transformed) {
      const target = resolve(temp, 'proposed', file);
      const baseline = resolve(temp, 'baseline', file);
      await mkdir(dirname(target), { recursive: true });
      await mkdir(dirname(baseline), { recursive: true });
      await writeFile(target, content, 'utf8');
      await writeFile(baseline, originals.get(file)!, 'utf8');
      const kind = scriptKind(file);
      if (kind === undefined) continue;
      candidates.push(target);
      baselineCandidates.push(baseline);
      const parsed = ts.createSourceFile(target, content, ts.ScriptTarget.ES2022, true, kind);
      const parseDiagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
      syntaxErrors.push(...parseDiagnostics.slice(0, MAX_DIAGNOSTICS).map(describeDiagnostic));
    }
    results.push(result(plan.id, 2, syntaxErrors.length ? 'failed' : candidates.length ? 'passed' : 'skipped',
      parseStarted, candidates.length ? ['Transformed JavaScript/TypeScript syntax in isolated copy'] : [],
      syntaxErrors.map(message => ({ kind: 'check', message })),
      candidates.length ? (syntaxErrors.length ? `${syntaxErrors.length} syntax error(s)` : undefined) : 'No JavaScript/TypeScript patched files'));

    const typeStarted = Date.now();
    if (syntaxErrors.length || !candidates.length) {
      results.push(result(plan.id, 3, 'blocked', typeStarted, [], [], 'No syntactically valid transformed source to type-check'));
    } else {
      const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
        allowJs: true, checkJs: true, noResolve: true, skipLibCheck: true,
        types: [], strict: true, jsx: ts.JsxEmit.Preserve,
      };
      const program = ts.createProgram(candidates, compilerOptions);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      const baselineProgram = ts.createProgram(baselineCandidates, compilerOptions);
      const baselineErrors = ts.getPreEmitDiagnostics(baselineProgram)
        .filter(item => item.category === ts.DiagnosticCategory.Error);
      const fileOf = (item: ts.Diagnostic, copy: 'baseline' | 'proposed'): string =>
        item.file ? relative(resolve(temp, copy), item.file.fileName).split(sep).join('/') : '';
      const key = (item: ts.Diagnostic, file: string, start: number | undefined): string =>
        `${item.code}:${file}:${start ?? ''}:${ts.flattenDiagnosticMessageText(item.messageText, ' ')}`;
      const baselineSet = new Set(baselineErrors.map(item => key(item, fileOf(item, 'baseline'), item.start)));
      // Proposed positions are mapped back through the edits so a length-changing patch does not
      // turn pre-existing errors after it into "new" ones. Errors inside replaced text stay new.
      const isPreExisting = (item: ts.Diagnostic): boolean => {
        const file = fileOf(item, 'proposed');
        if (item.start === undefined) return baselineSet.has(key(item, file, undefined));
        const patch = patchesByFile.get(file);
        const start = patch ? baselinePosition(item.start, patch, transformed.get(file)!, originals.get(file)!) : item.start;
        return start !== undefined && baselineSet.has(key(item, file, start));
      };
      const errors = diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error && !isPreExisting(item));
      const unresolved = errors.filter(item => [2307, 2688, 6053].includes(item.code));
      const other = errors.filter(item => ![2307, 2688, 6053].includes(item.code));
      const status = other.length ? 'failed' : unresolved.length || baselineErrors.length ? 'blocked' : 'passed';
      const messages = errors.slice(0, MAX_DIAGNOSTICS).map(describeDiagnostic);
      results.push(result(plan.id, 3, status, typeStarted,
        ['TypeScript 6 compiler API, isolated patched files, no repository tsconfig or plugins',
          'New diagnostics compared with original source'],
        messages.map(message => ({ kind: 'check', message })),
        unresolved.length || baselineErrors.length
          ? `${unresolved.length} new unresolved reference(s); ${baselineErrors.length} pre-existing error(s); isolated check incomplete`
          : undefined));
      if (unresolved.length || baselineErrors.length) limitations.push('Level 3 cannot certify types with unresolved or pre-existing errors in isolated patched files.');
    }

    const contractStarted = Date.now();
    if (!options.contract) {
      results.push(result(plan.id, 4, 'skipped', contractStarted, [], [],
        'Level 4 not requested; it runs only with the explicit synthetic-demo contract option'));
      limitations.push('Level 4 requires the explicit synthetic-demo contract option; no consumer integration was executed.');
    } else if (options.contract.kind !== 'synthetic-demo') {
      results.push(result(plan.id, 4, 'blocked', contractStarted, [], [], 'Unsupported contract kind; only synthetic-demo is available'));
      limitations.push('Level 4 supports only the packaged synthetic demo contract; no consumer integration was executed.');
    } else if (syntaxErrors.length) {
      results.push(result(plan.id, 4, 'blocked', contractStarted, [], [], 'Transformed source has syntax errors; contract not executed'));
      limitations.push('Level 4 synthetic demo contract was not executed because level 2 failed.');
    } else {
      // Loaded only on explicit opt-in so ordinary verification never pulls in the demo runner.
      const { verifySyntheticDemoContract } = await import('./demo-contract.js');
      const level = await verifySyntheticDemoContract(plan, transformed, originals, join(temp, 'contract'),
        { timeoutMs: options.timeoutMs, signal: options.signal });
      results.push(result(plan.id, 4, level.status, contractStarted, level.properties, level.evidence, level.reason));
      limitations.push(level.limitation);
    }
    const testStarted = Date.now();
    if (options.authorization && plan.applicationStatus !== 'applied') {
      results.push(result(plan.id, 5, 'blocked', testStarted, [], [],
        'Authorized repository command requires a plan applied to the repository; proposed edits exist only in the isolated copy'));
    } else results.push(await runAuthorized(plan.id, options, testStarted));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return { schemaVersion: SCHEMA_VERSION, planId: plan.id, results, limitations };
}
