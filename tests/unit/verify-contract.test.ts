import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, sha256, stableId, validateDocument, type MigrationConfig, type RepairPlan, type RunReport, type VerifyOptions } from '../../src/contracts/index.js';
import { loadApi } from '../../src/openapi/index.js';
import { compareApis } from '../../src/compare/index.js';
import { scanRepository } from '../../src/scan/index.js';
import { applyRepairPlan, loadMigration, planRepairs } from '../../src/repair/index.js';
import { verifyRepairPlan } from '../../src/verify/index.js';
import { DEMO_PATHS } from '../../src/demo/runner.js';

const CONTRACT: VerifyOptions['contract'] = { kind: 'synthetic-demo' };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function copyDemo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'apipatch-verify-contract-'));
  roots.push(root);
  await cp(DEMO_PATHS.repository, root, { recursive: true });
  return root;
}

/** Plans the demo repair for `repository` the same way the demo does, optionally with a modified migration. */
async function demoPlan(repository = DEMO_PATHS.repository, migrate: (m: MigrationConfig) => MigrationConfig = m => m): Promise<RepairPlan> {
  const [oldApi, newApi] = await Promise.all([loadApi(DEMO_PATHS.v1), loadApi(DEMO_PATHS.v2)]);
  const changes = compareApis(oldApi, newApi);
  const scan = await scanRepository({ repository, oldApi, newApi, changes });
  const report: RunReport = validateDocument('RunReport', {
    schemaVersion: SCHEMA_VERSION, id: stableId('report', { test: repository }),
    inputs: { old: { file: 'v1.yaml', digest: oldApi.digest }, new: { file: 'v2.yaml', digest: newApi.digest } },
    snapshots: { old: oldApi, new: newApi }, changes, uses: scan.uses, findings: scan.findings,
    repairs: [], verification: [], limitations: [], diagnostics: [],
  });
  return planRepairs({ report, migration: migrate(await loadMigration(DEMO_PATHS.migration)), repository });
}

const level4 = (report: Awaited<ReturnType<typeof verifyRepairPlan>>) => report.results.find(item => item.level === 4)!;

describe('verifyRepairPlan level 4 (synthetic demo contract)', () => {
  it('stays skipped unless the contract option is given explicitly', async () => {
    const report = await verifyRepairPlan(await demoPlan(), { repository: DEMO_PATHS.repository });
    expect(level4(report)).toMatchObject({ status: 'skipped', properties: [], evidence: [] });
    expect(level4(report).reason).toMatch(/not requested/);
  });

  it('passes on the proposed demo plan and enumerates cases and observed requests', async () => {
    const before = await readFile(join(DEMO_PATHS.repository, 'client.js'), 'utf8');
    const report = await verifyRepairPlan(await demoPlan(), { repository: DEMO_PATHS.repository, contract: CONTRACT });
    const result = level4(report);
    expect(result.status).toBe('passed');
    expect(result.properties.map(item => item.split(':')[0])).toEqual(['get-user', 'create-user', 'health']);
    const messages = result.evidence.map(item => item.message);
    expect(messages[0]).toMatch(/matches demo\/repository\/client\.js; 4\/4 edit\(s\) taken from the APIPatch-proposed demo plan; executed from a temporary proposed copy/);
    expect(messages).toContainEqual(expect.stringMatching(/^\[passed\] get-user .*requests: GET \/members\/42\?lang=en → 200$/));
    expect(messages).toContainEqual(expect.stringMatching(/^\[passed\] create-user .*requests: POST \/users → 201$/));
    expect(messages).toContainEqual(expect.stringMatching(/^\[pending, unsupported; observed failed\] preferences /));
    expect(result.reason).toMatch(/3\/3 supported .* preferences pending/);
    expect(report.limitations).toContainEqual(expect.stringMatching(/Level 4 executed only the synthetic demo contract/));
    expect(await readFile(join(DEMO_PATHS.repository, 'client.js'), 'utf8')).toBe(before);
  });

  it('runs on a plan already applied to a copy without touching that copy', async () => {
    const root = await copyDemo();
    const plan = await demoPlan(root);
    expect((await applyRepairPlan(plan, root)).status).toBe('applied');
    const applied = await readFile(join(root, 'client.js'), 'utf8');
    const report = await verifyRepairPlan({ ...plan, applicationStatus: 'applied' }, { repository: root, contract: CONTRACT });
    expect(level4(report).status).toBe('passed');
    expect(level4(report).evidence[0]?.message).toMatch(/temporary applied copy/);
    expect(await readFile(join(root, 'client.js'), 'utf8')).toBe(applied);
  });

  it('refuses to execute a module whose source is not the packaged demo client', async () => {
    const root = await copyDemo();
    const source = await readFile(join(root, 'client.js'), 'utf8');
    // Same shape, so the scanner and planner still produce edits, but extra repository code.
    await writeFile(join(root, 'client.js'), `${source}\nexport const injected = globalThis.process?.exit?.(7);\n`);
    const plan = await demoPlan(root);
    expect(plan.files[0]?.edits.length).toBeGreaterThan(0);
    const report = await verifyRepairPlan(plan, { repository: root, contract: CONTRACT });
    expect(report.results[0]?.status).toBe('passed');
    expect(level4(report)).toMatchObject({ status: 'blocked', properties: [], evidence: [] });
    expect(level4(report).reason).toMatch(/not the packaged demo\/repository\/client\.js/);
  });

  it('refuses edits that APIPatch did not propose for the demo and plans touching other files', async () => {
    const plan = await demoPlan();
    const edit = plan.files[0]!.edits[0]!;
    const tampered: RepairPlan = structuredClone(plan);
    tampered.files[0]!.edits[0] = { ...edit, newText: `${edit.newText}\${globalThis.process.exit(3)}` };
    const report = await verifyRepairPlan(tampered, { repository: DEMO_PATHS.repository, contract: CONTRACT });
    expect(report.results[0]?.status).toBe('passed');
    expect(level4(report)).toMatchObject({ status: 'blocked', evidence: [] });
    expect(level4(report).reason).toMatch(/1 edit\(s\) are not part of the APIPatch-proposed demo plan/);

    const packageHash = sha256(await readFile(join(DEMO_PATHS.repository, 'package.json')));
    const twoFiles: RepairPlan = { ...plan, files: [...plan.files, { file: 'package.json', originalHash: packageHash, edits: [] }] };
    expect((await verifyRepairPlan(twoFiles, { repository: DEMO_PATHS.repository })).results[0]?.status).toBe('passed');
    const other = await verifyRepairPlan(twoFiles, { repository: DEMO_PATHS.repository, contract: CONTRACT });
    expect(level4(other).status).toBe('blocked');
    expect(level4(other).reason).toMatch(/exactly the demo module client\.js/);
  });

  it('fails concretely when the migration omits the response rename', async () => {
    const plan = await demoPlan(DEMO_PATHS.repository, m => ({ ...m, renames: m.renames.filter(item => item.from !== 'fullName') }));
    expect(plan.files[0]!.edits.length).toBe(3);
    const report = await verifyRepairPlan(plan, { repository: DEMO_PATHS.repository, contract: CONTRACT });
    const result = level4(report);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/^1\/3 supported contract case\(s\) failed: get-user \(undefined\)/);
    const messages = result.evidence.map(item => item.message);
    expect(messages[0]).toMatch(/3\/4 edit\(s\) taken from the APIPatch-proposed demo plan/);
    expect(messages).toContainEqual(expect.stringMatching(/^\[failed\] get-user .*actual undefined; requests: GET \/members\/42\?lang=en → 200$/));
    expect(messages).toContainEqual(expect.stringMatching(/^\[passed\] create-user /));
  });

  it('reports a harness that cannot run the consumer as blocked, never passed', async () => {
    const report = await verifyRepairPlan(await demoPlan(), { repository: DEMO_PATHS.repository, contract: CONTRACT, timeoutMs: 1 });
    expect(level4(report).status).toBe('blocked');
    expect(level4(report).reason).toMatch(/could not run get-user, create-user, health, preferences/);
    expect(level4(report).evidence.slice(1).every(item => item.message.includes('not run: consumer harness timed out'))).toBe(true);
  });

  it('blocks unknown contract kinds', async () => {
    const report = await verifyRepairPlan(await demoPlan(), { repository: DEMO_PATHS.repository, contract: { kind: 'other' } as unknown as VerifyOptions['contract'] });
    expect(level4(report)).toMatchObject({ status: 'blocked', evidence: [] });
  });
});
