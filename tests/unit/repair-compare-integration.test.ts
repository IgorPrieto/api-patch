import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION, stableId, validateDocument, type RunReport } from '../../src/contracts/index.js';
import { loadApi } from '../../src/openapi/index.js';
import { compareApis } from '../../src/compare/index.js';
import { scanRepository } from '../../src/scan/index.js';
import { applyRepairPlan, loadMigration, planRepairs } from '../../src/repair/index.js';

const FIXTURE = path.resolve('tests/fixtures/repair-demo');
const HEALTH = stableId('operation', { method: 'get', route: '/health' });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('planRepairs with real T1/T2/T3 output', () => {
  it('repairs the supported cases end to end and keeps ambiguous or unlinked findings pending', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-repair-int-'));
    roots.push(root);
    await cp(path.join(FIXTURE, 'consumer'), root, { recursive: true });
    const old = await loadApi(path.join(FIXTURE, 'v1.yaml'));
    const next = await loadApi(path.join(FIXTURE, 'v2.yaml'));
    const changes = compareApis(old, next);
    const scan = await scanRepository({ repository: root, oldApi: old, newApi: next, changes });
    const report: RunReport = validateDocument('RunReport', {
      schemaVersion: SCHEMA_VERSION, id: 'report_integration', inputs: { old: { file: 'v1.yaml', digest: old.digest }, new: { file: 'v2.yaml', digest: next.digest }, repository: root },
      snapshots: { old, new: next }, changes, uses: scan.uses, findings: scan.findings, repairs: [], verification: [], limitations: scan.limitations, diagnostics: scan.diagnostics,
    });
    const migration = await loadMigration(path.join(FIXTURE, 'migration.yaml'));
    migration.values.push({ operationId: HEALTH, location: 'query', name: 'verbose', value: 'yes' });
    const plan = await planRepairs({ report, migration, repository: root });

    const byRule = (rule: string) => report.findings.filter(finding => report.changes.find(change => change.id === finding.changeId)?.rule === rule).map(finding => finding.id);
    const status = (id: string) => plan.resolvedFindingIds.includes(id) ? 'resolved' : plan.partialFindingIds.includes(id) ? 'partial' : 'pending';
    expect(byRule('operation.removed').length).toBe(2); // fetch + axios callers of GET /users/{id}
    expect(byRule('operation.removed').map(status)).toEqual(['resolved', 'resolved']);
    expect(byRule('parameter.added.required').map(status)).toEqual(['resolved']);
    expect(byRule('schema.composition.changed').map(status)).toEqual(['pending']);
    expect(byRule('schema.property.removed').every(id => status(id) === 'pending')).toBe(true);
    // Body findings link to mappings only through the structured fieldPath (displayName via rename, tenantId via value).
    expect(report.changes.filter(change => change.rule === 'schema.required.added').map(change => change.fieldPath).sort()).toEqual([['displayName'], ['tenantId']]);
    expect(byRule('schema.required.added').map(status)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']); // fetch + axios createUser callers

    const applied = await applyRepairPlan(plan, root);
    expect(applied.status).toBe('applied');
    const client = await readFile(path.join(root, 'client.ts'), 'utf8');
    expect(client).toContain('`${BASE}/members/${id}?lang=${locale}`');
    expect(client).toContain('user.displayName');
    expect(client).toContain("JSON.stringify({ displayName: name, tenantId: 'tenant-demo' })");
    const axiosClient = await readFile(path.join(root, 'axios-client.ts'), 'utf8');
    expect(axiosClient).toContain("api.get('/health?verbose=yes')");
    expect(axiosClient).toContain("api.get('/members/42', { params: { lang: 'es' } })");
    expect(axiosClient).toContain("    displayName: 'Ada',\n    tenantId: 'tenant-demo',\n");
    expect((await applyRepairPlan(plan, root)).diagnostics.every(d => d.code === 'REPAIR_ALREADY_APPLIED')).toBe(true);
  });
});
