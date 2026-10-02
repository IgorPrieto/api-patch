import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEMO_PATHS, runFullDemo, type DemoResult } from '../../src/demo/runner.js';
import { runConsumerContract } from '../../src/demo/contract.js';

const run = (result: DemoResult, name: keyof DemoResult['runs'], id: string) => result.runs[name].cases.find(item => item.id === id)!;

describe('synthetic demo end to end', { timeout: 30_000 }, () => {
  it('breaks on v2, repairs a temporary copy with an explicit migration and turns supported cases green', async () => {
    const before = await readFile(path.join(DEMO_PATHS.repository, 'client.js'), 'utf8');
    const result = await runFullDemo({ keepWorkspace: true });
    try {
      expect(result.checks.filter(check => !check.passed)).toEqual([]);
      expect(result.ok).toBe(true);

      // v1 green, v2 concrete failures observed both by the consumer and by the API.
      expect(result.runs.originalV1.cases.map(item => item.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
      expect(run(result, 'originalV2', 'get-user')).toMatchObject({ status: 'failed', actual: 'threw: getUser HTTP 404' });
      expect(run(result, 'originalV2', 'get-user').requests).toEqual([{ method: 'GET', path: '/users/42', query: '?locale=en', status: 404, error: 'unknown route' }]);
      expect(run(result, 'originalV2', 'create-user').requests[0]).toMatchObject({ body: { name: 'Ada' }, status: 400, error: 'missing displayName, tenantId' });

      // Real findings from compare + scan; the plan must not be empty.
      const rules = (outcome: string) => result.findings.filter(item => item.outcome === outcome).map(item => `${item.operation} ${item.rule}`).sort();
      expect(rules('resolved')).toEqual(['GET /users/{id} operation.removed', 'POST /users schema.required.added', 'POST /users schema.required.added']);
      expect(rules('pending')).toEqual(['GET /preferences schema.composition.changed', 'POST /users schema.property.removed']);
      expect(result.findings.some(item => item.operation === 'GET /health')).toBe(false);
      expect(result.report.changes.filter(change => change.path === '/health').map(change => change.classification)).toEqual(['compatible', 'compatible']);
      expect(result.plan.files.flatMap(file => file.edits).length).toBeGreaterThanOrEqual(4);
      expect(result.application.status).toBe('applied');

      // The copy holds the repair; the original is untouched.
      const repaired = await readFile(path.join(result.repairedCopy, 'client.js'), 'utf8');
      expect(repaired).toContain('fetch(`/members/${id}?lang=${locale}`)');
      expect(repaired).toContain('return user.displayName;');
      expect(repaired).toContain("body: JSON.stringify({ displayName: name, tenantId: 'tenant-demo' })");
      expect(await readFile(path.join(DEMO_PATHS.repository, 'client.js'), 'utf8')).toBe(before);

      // Repaired copy against v2: supported cases green, ambiguous case still failing and not claimed.
      expect(run(result, 'repairedV2', 'get-user')).toMatchObject({ status: 'passed', actual: '"Ada Lovelace"' });
      expect(run(result, 'repairedV2', 'get-user').requests[0]).toMatchObject({ path: '/members/42', query: '?lang=en', status: 200 });
      expect(run(result, 'repairedV2', 'create-user')).toMatchObject({ status: 'passed', actual: '"user-42"' });
      expect(run(result, 'repairedV2', 'health').status).toBe('passed');
      expect(run(result, 'repairedV2', 'preferences')).toMatchObject({ supported: false, status: 'failed', actual: 'undefined' });

      // verifyRepairPlan results are reported as returned; level 4 is not requested by default.
      expect(result.verification.results.find(item => item.level === 1)?.status).toBe('passed');
      expect(result.verification.results.find(item => item.level === 2)?.status).toBe('passed');
      expect(result.verification.results.find(item => item.level === 4)?.status).toBe('skipped');
      expect(result.verification.results.some(item => item.status === 'failed')).toBe(false);
      expect(result.checks.some(check => check.name.includes('level 4'))).toBe(false);
    } finally {
      await rm(path.dirname(result.repairedCopy), { recursive: true, force: true });
    }
  });

  it('with the level 4 option, asserts the verifier level-4 result only because it really passed', async () => {
    const result = await runFullDemo({ verifyLevel4: true });
    expect(result.checks.filter(check => !check.passed)).toEqual([]);
    const level4 = result.verification.results.find(item => item.level === 4)!;
    expect(level4.status).toBe('passed');
    expect(level4.properties).toHaveLength(3);
    expect(level4.evidence.map(item => item.message)).toContainEqual(expect.stringMatching(/^\[passed\] get-user .*GET \/members\/42\?lang=en → 200/));
    expect(result.checks.find(check => check.name === 'verify: level 4 synthetic contract passed')).toMatchObject({ passed: true });
    expect(result.report.verification.find(item => item.level === 4)?.status).toBe('passed');
    // The verifier's level 4 agrees with the independent repaired-copy run on every supported case.
    for (const item of result.runs.repairedV2.cases.filter(entry => entry.supported)) {
      expect(level4.evidence.some(evidence => evidence.message.startsWith(`[${item.status}] ${item.id} `))).toBe(true);
    }
  });

  it('reports a failing contract when the consumer is not repaired, and blocks unsafe module paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-demo-contract-'));
    try {
      await cp(DEMO_PATHS.repository, root, { recursive: true });
      // A half repair (route only) must still fail on v2: the query rename is required.
      const source = await readFile(path.join(root, 'client.js'), 'utf8');
      await writeFile(path.join(root, 'client.js'), source.replace('/users/${id}', '/members/${id}'));
      const contract = await runConsumerContract({ repository: root, module: 'client.js', api: 'v2' });
      const getUser = contract.cases.find(item => item.id === 'get-user')!;
      expect(getUser).toMatchObject({ status: 'failed', actual: 'threw: getUser HTTP 400' });
      expect(getUser.requests[0]).toMatchObject({ path: '/members/42', error: 'missing lang' });
      await expect(runConsumerContract({ repository: root, module: '../client.js', api: 'v2' })).rejects.toThrow(/Unsafe/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks a consumer that cannot run as blocked, never passed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-demo-blocked-'));
    try {
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
      // Writing is outside the harness permissions; the module itself must not be able to run side effects.
      await writeFile(path.join(root, 'client.js'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('pwned', 'x');\nexport const health = async () => true;\n");
      const contract = await runConsumerContract({ repository: root, module: 'client.js', api: 'v1', cases: [
        { id: 'health', exportName: 'health', args: [], expected: true, property: 'health', supported: true },
      ] });
      expect(contract.cases[0]).toMatchObject({ status: 'blocked' });
      expect(contract.cases[0]!.actual).toMatch(/^not run: /);
      await expect(readFile(path.join(root, 'pwned'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
