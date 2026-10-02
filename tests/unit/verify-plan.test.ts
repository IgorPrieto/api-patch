import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, sha256, type RepairPlan } from '../../src/contracts/index.js';
import { verifyRepairPlan } from '../../src/verify/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(current = 'export const number = 1;\n'): Promise<{ root: string; plan: RepairPlan }> {
  const root = await mkdtemp(join(tmpdir(), 'apipatch-verify-test-'));
  roots.push(root);
  await writeFile(join(root, 'client.ts'), current);
  return {
    root,
    plan: {
      schemaVersion: SCHEMA_VERSION, id: 'plan_test', reportId: 'report_test',
      migration: { schemaVersion: SCHEMA_VERSION, allowedOrigins: [], operations: [], renames: [], values: [] },
      applicationStatus: 'proposed',
      files: [{ file: 'client.ts', originalHash: sha256(current), edits: [{
        start: current.indexOf('1'), end: current.indexOf('1') + 1,
        oldText: '1', newText: '2', findingIds: [], reason: 'Synthetic edit',
      }] }],
      resolvedFindingIds: [], partialFindingIds: [], pendingFindingIds: [],
      unifiedDiff: '', explanations: [], diagnostics: [],
    },
  };
}

test('checks the proposed patch in isolation and keeps omitted levels explicit', async () => {
  const { root, plan } = await fixture();
  const before = await readFile(join(root, 'client.ts'), 'utf8');
  const report = await verifyRepairPlan(plan, { repository: root });
  expect(report.results.map(item => item.status)).toEqual(['passed', 'passed', 'passed', 'skipped', 'skipped']);
  expect(await readFile(join(root, 'client.ts'), 'utf8')).toBe(before);
});

test('rejects changed source hash and blocks dependent checks', async () => {
  const { root, plan } = await fixture();
  await writeFile(join(root, 'client.ts'), 'export const number = 9;\n');
  const report = await verifyRepairPlan(plan, { repository: root });
  expect(report.results.map(item => item.status)).toEqual(['failed', 'blocked', 'blocked', 'blocked', 'blocked']);
  expect(report.results[0]?.reason).toMatch(/hash mismatch/i);
});

test('reports syntax failure without claiming type-check success', async () => {
  const { root, plan } = await fixture();
  plan.files[0]!.edits[0]!.newText = ')';
  const report = await verifyRepairPlan(plan, { repository: root });
  expect(report.results[0]?.status).toBe('passed');
  expect(report.results[1]?.status).toBe('failed');
  expect(report.results[2]?.status).toBe('blocked');
});

test('recognizes an already applied patch from the original hash and reverse edit', async () => {
  const { root, plan } = await fixture();
  plan.applicationStatus = 'applied';
  await writeFile(join(root, 'client.ts'), 'export const number = 2;\n');
  const report = await verifyRepairPlan(plan, { repository: root });
  expect(report.results[0]?.status).toBe('passed');
  expect(await readFile(join(root, 'client.ts'), 'utf8')).toBe('export const number = 2;\n');
});

test('rejects an applied status when repository still contains original content', async () => {
  const { root, plan } = await fixture();
  plan.applicationStatus = 'applied';
  const report = await verifyRepairPlan(plan, { repository: root });
  expect(report.results[0]?.status).toBe('failed');
  expect(report.results[0]?.reason).toMatch(/still contains original/);
});

test('rejects a symlink patch target before reading it', async () => {
  const { root, plan } = await fixture();
  await symlink(join(root, 'client.ts'), join(root, 'link.ts'));
  plan.files[0]!.file = 'link.ts';
  const report = await verifyRepairPlan(plan, { repository: root });
  expect(report.results[0]?.status).toBe('failed');
  expect(report.results[0]?.reason).toMatch(/symlink/i);
});
