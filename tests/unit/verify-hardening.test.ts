import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SCHEMA_VERSION, sha256, type ExecutionAuthorization, type RepairPlan } from '../../src/contracts/index.js';
import { redactSecrets, verifyRepairPlan } from '../../src/verify/index.js';

const roots: string[] = [];
const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(current: string, oldText: string, newText: string): Promise<{ root: string; plan: RepairPlan }> {
  const root = await mkdtemp(join(tmpdir(), 'apipatch-verify-hardening-'));
  roots.push(root);
  await writeFile(join(root, 'client.ts'), current);
  const start = current.indexOf(oldText);
  return {
    root,
    plan: {
      schemaVersion: SCHEMA_VERSION, id: 'plan_hardening', reportId: 'report_test',
      migration: { schemaVersion: SCHEMA_VERSION, allowedOrigins: [], operations: [], renames: [], values: [] },
      applicationStatus: 'proposed',
      files: [{ file: 'client.ts', originalHash: sha256(current), edits: [{
        start, end: start + oldText.length, oldText, newText, findingIds: [], reason: 'Synthetic edit',
      }] }],
      resolvedFindingIds: [], partialFindingIds: [], pendingFindingIds: [],
      unifiedDiff: '', explanations: [], diagnostics: [],
    },
  };
}

/** An applied plan with no edits, so Level 5 is allowed to run the authorized command. */
async function appliedFixture(): Promise<{ root: string; plan: RepairPlan }> {
  const result = await fixture('export const a = 1;\n', '1', '1');
  result.plan.applicationStatus = 'applied';
  result.plan.files[0]!.edits = [];
  return result;
}

const sh = (root: string, script: string, extra: string[] = []): ExecutionAuthorization =>
  ({ command: 'sh', args: ['-c', script, ...extra], cwd: root, consent: true });

function gone(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return true; }
  // A killed process may linger briefly as a zombie until its new parent reaps it.
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') ?? false; } catch { return false; }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (gone(pid)) return true;
    await delay(50);
  }
  return false;
}

async function readPid(root: string): Promise<number> {
  const pid = Number((await readFile(join(root, 'grandchild.pid'), 'utf8')).trim());
  expect(Number.isInteger(pid) && pid > 1).toBe(true);
  strays.push(pid);
  return pid;
}

const posix = process.platform !== 'win32';

describe.runIf(posix)('authorized command process control', () => {
  test('timeout kills the whole process group and does not wait for a grandchild holding the pipes', async () => {
    const { root, plan } = await appliedFixture();
    const started = Date.now();
    const report = await verifyRepairPlan(plan, {
      repository: root, timeoutMs: 1_000,
      authorization: sh(root, 'sleep 30 & echo $! > grandchild.pid; wait; echo done'),
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(report.results[4]).toMatchObject({ level: 5, status: 'blocked', reason: 'Timed out after 1000 ms' });
    expect(await waitGone(await readPid(root))).toBe(true);
  });

  test('abort kills the process group and reports cancellation', async () => {
    const { root, plan } = await appliedFixture();
    const controller = new AbortController();
    const started = Date.now();
    const pending = verifyRepairPlan(plan, {
      repository: root, timeoutMs: 60_000, signal: controller.signal,
      authorization: sh(root, 'sleep 30 & echo $! > grandchild.pid; wait'),
    });
    // Abort only once the command (and its grandchild) is actually running.
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await readFile(join(root, 'grandchild.pid'), 'utf8'); break; } catch { await delay(50); }
    }
    controller.abort();
    const report = await pending;
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(report.results[4]).toMatchObject({ status: 'blocked', reason: 'Cancelled' });
    expect(await waitGone(await readPid(root))).toBe(true);
  });

  test('a successful command that leaves a background grandchild returns promptly and cleans it up', async () => {
    const { root, plan } = await appliedFixture();
    const started = Date.now();
    const report = await verifyRepairPlan(plan, {
      repository: root, timeoutMs: 20_000,
      authorization: sh(root, 'sleep 30 & echo $! > grandchild.pid; echo ok'),
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(report.results[4]?.status).toBe('passed');
    expect(report.results[4]?.evidence[0]?.message).toMatch(/^Exit 0; output: ok/);
    expect(report.results[4]?.evidence.some(item => /background processes/.test(item.message))).toBe(true);
    expect(await waitGone(await readPid(root))).toBe(true);
  });

  const hasSetsid = posix && spawnSync('setsid', ['true']).status === 0;
  test.runIf(hasSetsid)('returns without waiting for a descendant that left the process group but kept the pipes', async () => {
    const { root, plan } = await appliedFixture();
    const started = Date.now();
    const report = await verifyRepairPlan(plan, {
      repository: root, timeoutMs: 20_000,
      authorization: sh(root, 'setsid sleep 30 & echo $! > grandchild.pid; echo ok'),
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(report.results[4]?.status).toBe('passed');
    // The escaped process is outside the group the verifier owns; the test cleans it up in afterEach.
    await readPid(root);
  });

  test('plain exit status and output are unchanged for a well-behaved command', async () => {
    const { root, plan } = await appliedFixture();
    const report = await verifyRepairPlan(plan, { repository: root, authorization: sh(root, 'echo failing >&2; exit 3') });
    expect(report.results[4]?.status).toBe('failed');
    expect(report.results[4]?.evidence).toEqual([{ kind: 'check', message: 'Exit 3; output: failing\n' }]);
  });

  test('a cancelled signal before Level 5 starts never launches the command', async () => {
    const { root, plan } = await appliedFixture();
    const controller = new AbortController();
    controller.abort();
    const report = await verifyRepairPlan(plan, { repository: root, signal: controller.signal, authorization: sh(root, 'touch ran') });
    expect(report.results[0]?.status).toBe('failed');
    await expect(readFile(join(root, 'ran'))).rejects.toThrow();
  });
});

describe('secret redaction', () => {
  test.runIf(posix)('redacts JSON, bearer and CLI secrets in evidence and recorded authorization', async () => {
    const { root, plan } = await appliedFixture();
    const report = await verifyRepairPlan(plan, {
      repository: root,
      authorization: sh(root, `echo '{"token": "s3cr3t-json", "password":"p4ss"}'; echo 'Bearer abc.def.ghi'; echo "$@"`,
        ['--api-key=CLI_SECRET', '--token', 'SEPARATE_SECRET', 'https://user:URL_SECRET@example.test/']),
    });
    const level5 = report.results[4]!;
    const serialized = JSON.stringify(level5);
    for (const secret of ['s3cr3t-json', 'p4ss', 'abc.def.ghi', 'CLI_SECRET', 'SEPARATE_SECRET', 'URL_SECRET']) {
      expect(serialized).not.toContain(secret);
    }
    expect(level5.status).toBe('passed');
    expect(level5.authorization).toMatchObject({ command: 'sh', consent: true, cwd: root });
    expect(level5.authorization?.args.slice(2)).toEqual(['--api-key=[REDACTED]', '--token', '[REDACTED]', 'https://user:[REDACTED]@example.test/']);
    expect(level5.evidence[0]?.message).toContain('"token": "[REDACTED]"');
    expect(level5.evidence[0]?.message).toContain('Bearer [REDACTED]');
  });

  test('covers header, assignment and quoted forms', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOi.payload.sig')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactSecrets('authorization=Basic dXNlcjpwYXNz')).toBe('authorization=Basic [REDACTED]');
    expect(redactSecrets(`{"authorization":"Bearer abc123"}`)).toBe(`{"authorization":"Bearer [REDACTED]"}`);
    expect(redactSecrets(`{ 'api_key': 'k-123', "clientSecret": 42 }`)).toBe(`{ 'api_key': '[REDACTED]', "clientSecret": [REDACTED] }`);
    expect(redactSecrets('GET /x?access_token=abc&page=2')).toBe('GET /x?access_token=[REDACTED]&page=2');
    expect(redactSecrets('PASSWORD=hunter2 npm test')).toBe('PASSWORD=[REDACTED] npm test');
    expect(redactSecrets('Set-Cookie: session_id=xyz')).toContain('[REDACTED]');
    expect(redactSecrets('run --token abc123 --verbose')).toBe('run --token [REDACTED] --verbose');
  });

  test('keeps ordinary diagnostics readable', () => {
    const diagnostics = [
      "SyntaxError: Unexpected token '}'",
      'Unexpected token: }',
      "TS2322: Type '{ token: string; }' is not assignable to type 'Auth'.",
      'Bearer token missing from request',
      'expected token: undefined to equal "abc"',
      '  ✓ tests/auth.test.ts (3 tests) 12ms',
      '  --token <value>  API token used for requests',
    ];
    for (const line of diagnostics) expect(redactSecrets(line)).toBe(line);
  });
});

describe('Level 3 baseline comparison', () => {
  test('a pre-existing error after a length-changing edit is not blamed on the patch', async () => {
    const current = 'export const url = "/users";\nexport const n: number = "x";\n';
    const { root, plan } = await fixture(current, '"/users"', '"/members/v2"');
    const report = await verifyRepairPlan(plan, { repository: root });
    expect(report.results[2]?.status).toBe('blocked');
    expect(report.results[2]?.evidence).toEqual([]);
    expect(report.results[2]?.reason).toMatch(/0 new unresolved reference\(s\); 1 pre-existing error/);
  });

  test('a new error is still reported next to a shifted pre-existing one', async () => {
    const current = 'export const url: string = "/users";\nexport const n: number = "x";\n';
    const { root, plan } = await fixture(current, '"/users"', '12345678');
    const report = await verifyRepairPlan(plan, { repository: root });
    expect(report.results[2]?.status).toBe('failed');
    expect(report.results[2]?.evidence).toHaveLength(1);
    expect(report.results[2]?.evidence[0]?.message).toMatch(/^TS2322 .*client\.ts:1:/);
  });
});

describe('byte order mark', () => {
  const current = '﻿export const url = "/users";\nexport const n: number = "x";\n';

  test('BOM-prefixed source keeps hashes and scan offsets consistent', async () => {
    const { root, plan } = await fixture(current, '"/users"', '"/members"');
    expect(plan.files[0]!.edits[0]!.start).toBe(20);
    const report = await verifyRepairPlan(plan, { repository: root });
    expect(report.results.slice(0, 3).map(item => item.status)).toEqual(['passed', 'passed', 'blocked']);
    expect(report.results[2]?.evidence).toEqual([]);
    expect(await readFile(join(root, 'client.ts'), 'utf8')).toBe(current);
  });

  test('an applied BOM-prefixed patch is recognized through the reverse edit', async () => {
    const { root, plan } = await fixture(current, '"/users"', '"/members"');
    plan.applicationStatus = 'applied';
    await writeFile(join(root, 'client.ts'), current.replace('"/users"', '"/members"'));
    const report = await verifyRepairPlan(plan, { repository: root });
    expect(report.results[0]?.status).toBe('passed');
    expect(report.results[2]?.evidence).toEqual([]);
  });
});
