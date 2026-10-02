import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {
  SCHEMA_VERSION, sha256, stableId, validateDocument,
  type ApiChange, type ApiSnapshot, type MigrationConfig, type RepairPlan, type RunReport,
} from '../../src/contracts/index.js';
import { loadApi } from '../../src/openapi/index.js';
import { scanRepository } from '../../src/scan/index.js';
import { applyRepairPlan, loadMigration, parseMigration, planRepairs, RepairError } from '../../src/repair/index.js';

const FIXTURE = path.resolve('tests/fixtures/repair-demo');
const GET_USER = stableId('operation', { method: 'get', route: '/users/{id}' });
const GET_MEMBER = stableId('operation', { method: 'get', route: '/members/{id}' });
const CREATE_USER = stableId('operation', { method: 'post', route: '/users' });
const HEALTH = stableId('operation', { method: 'get', route: '/health' });
const PREFERENCES = stableId('operation', { method: 'get', route: '/preferences' });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function tempDir(prefix = 'apipatch-repair-'): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root; }

let snapshots: { old: ApiSnapshot; new: ApiSnapshot } | undefined;
async function apis() {
  snapshots ??= { old: await loadApi(path.join(FIXTURE, 'v1.yaml')), new: await loadApi(path.join(FIXTURE, 'v2.yaml')) };
  return snapshots;
}

/** Synthetic changes shaped like T2 output: operation id, location and pointers into the snapshots. */
function changes(old: ApiSnapshot, next: ApiSnapshot): ApiChange[] {
  const file = (snapshot: ApiSnapshot) => snapshot.documents[0]!.file;
  const change = (partial: Omit<ApiChange, 'id' | 'evidence' | 'explanation'> & { explanation?: string }): ApiChange =>
    ({ id: stableId('change', partial), explanation: partial.explanation ?? partial.rule, evidence: [], ...partial });
  return [
    change({ operationId: GET_USER, method: 'get', path: '/users/{id}', location: 'path', rule: 'operation-removed', direction: 'operation', classification: 'breaking', before: { file: file(old), pointer: '/paths/~1users~1{id}/get' } }),
    change({ operationId: CREATE_USER, method: 'post', path: '/users', location: 'request', rule: 'request-property-removed', direction: 'request', classification: 'breaking', before: { file: file(old), pointer: '/paths/~1users/post/requestBody/content/application~1json/schema/properties/name' } }),
    change({ operationId: CREATE_USER, method: 'post', path: '/users', location: 'request', rule: 'request-required-added', direction: 'request', classification: 'breaking', after: { file: file(next), pointer: '/paths/~1users/post/requestBody/content/application~1json/schema/properties/tenantId' } }),
    change({ operationId: HEALTH, method: 'get', path: '/health', location: 'query', rule: 'required-parameter-added', direction: 'request', classification: 'breaking', after: { file: file(next), pointer: '/paths/~1health/get/parameters/0' } }),
    change({ operationId: PREFERENCES, method: 'get', path: '/preferences', location: 'response', rule: 'response-composition', direction: 'response', classification: 'ambiguous', after: { file: file(next), pointer: '/paths/~1preferences/get/responses/200/content/application~1json/schema/oneOf' } }),
  ];
}

async function consumer(files: Record<string, string> = {}): Promise<string> {
  const root = await tempDir();
  await cp(path.join(FIXTURE, 'consumer'), root, { recursive: true });
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}

async function report(root: string, extra: { changes?: ApiChange[] } = {}): Promise<RunReport> {
  const { old, new: next } = await apis();
  const list = extra.changes ?? changes(old, next);
  const scan = await scanRepository({ repository: root, oldApi: old, newApi: next, changes: list });
  return validateDocument('RunReport', {
    schemaVersion: SCHEMA_VERSION, id: stableId('report', { root, old: old.digest, next: next.digest }),
    inputs: { old: { file: 'v1.yaml', digest: old.digest }, new: { file: 'v2.yaml', digest: next.digest }, repository: root },
    snapshots: { old, new: next }, changes: list, uses: scan.uses, findings: scan.findings,
    repairs: [], verification: [], limitations: scan.limitations, diagnostics: scan.diagnostics,
  });
}

const migration = () => loadMigration(path.join(FIXTURE, 'migration.yaml'));
const read = (root: string, file: string) => readFile(path.join(root, file), 'utf8');
const parses = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).statements.length > 0
  && !ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { noEmit: true } }).diagnostics?.length;
function findingFor(r: RunReport, file: string, operationId: string, rule?: string) {
  const use = r.uses.find(item => item.file === file && item.operationIds.includes(operationId));
  return r.findings.filter(item => item.useId === use?.id && (!rule || r.changes.find(change => change.id === item.changeId)?.rule === rule));
}

describe('planRepairs', () => {
  it('plans route, query, response and request repairs from explicit mappings and leaves ambiguity pending', async () => {
    const root = await consumer();
    const r = await report(root);
    const before = await read(root, 'client.ts');
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });

    expect(validateDocument('RepairPlan', plan)).toBe(plan);
    expect(plan.applicationStatus).toBe('proposed');
    expect(await read(root, 'client.ts')).toBe(before); // preview never writes
    const client = plan.files.find(file => file.file === 'client.ts')!;
    expect(client.originalHash).toBe(sha256(before));
    expect(client.edits.map(edit => [edit.oldText, edit.newText])).toEqual([
      ['/users/${id}', '/members/${id}'],
      ['locale', 'lang'],
      ['fullName', 'displayName'],
      ['name', "displayName: name, tenantId: 'tenant-demo'"],
    ]);
    expect(plan.unifiedDiff).toContain('diff --git a/client.ts b/client.ts');
    expect(plan.unifiedDiff).toContain('-  const response = await fetch(`${BASE}/users/${id}?locale=${locale}`);');
    expect(plan.unifiedDiff).toContain('+  const response = await fetch(`${BASE}/members/${id}?lang=${locale}`);');
    expect(plan.unifiedDiff).toContain("+    body: JSON.stringify({ displayName: name, tenantId: 'tenant-demo' }),");

    const [routeFinding] = findingFor(r, 'client.ts', GET_USER);
    const createFindings = findingFor(r, 'client.ts', CREATE_USER);
    const [ambiguous] = findingFor(r, 'client.ts', PREFERENCES);
    expect(plan.resolvedFindingIds).toEqual(expect.arrayContaining([routeFinding!.id, ...createFindings.map(f => f.id)]));
    expect(plan.pendingFindingIds).toContain(ambiguous!.id);
    expect(plan.explanations.find(line => line.includes(ambiguous!.id))).toMatch(/pending — ambiguous change requires manual review/);
    expect(client.edits[0]!.findingIds).toEqual([routeFinding!.id]);
    expect(plan.explanations.some(line => line.includes('explicit operation mapping'))).toBe(true);
  });

  it('leaves a moved route partial when the destination requires a query rename the migration lacks', async () => {
    const root = await consumer();
    const r = await report(root);
    const base = await migration();
    const plan = await planRepairs({ report: r, migration: { ...base, renames: base.renames.filter(item => item.from !== 'locale') }, repository: root });
    const [routeFinding] = findingFor(r, 'client.ts', GET_USER);
    expect(plan.resolvedFindingIds).not.toContain(routeFinding!.id);
    expect(plan.partialFindingIds).toContain(routeFinding!.id);
    expect(plan.explanations.find(line => line.includes(routeFinding!.id))).toMatch(/destination requires query field lang and no applied explicit mapping provides it/);
    // Explicit mappings are still proposed, and each one names the operation mapping that authorized it.
    const edits = plan.files.find(file => file.file === 'client.ts')!.edits;
    expect(edits.map(edit => edit.oldText)).toContain('/users/${id}');
    expect(edits.find(edit => edit.oldText === 'fullName')).toMatchObject({ findingIds: [routeFinding!.id], reason: expect.stringMatching(/authorized by operation mapping/) });
    expect(edits.some(edit => edit.oldText === 'locale')).toBe(false);
  });

  it('does not credit an explicit mapping to an unrelated finding of the same call', async () => {
    const root = await consumer();
    const { old, new: next } = await apis();
    // Drop the tenantId change: the tenantId value mapping no longer has a finding to justify it.
    const r = await report(root, { changes: changes(old, next).filter(change => !change.after?.pointer.endsWith('/tenantId')) });
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });
    const createFindings = findingFor(r, 'client.ts', CREATE_USER);
    expect(createFindings).toHaveLength(1);
    const edits = plan.files.find(file => file.file === 'client.ts')!.edits;
    expect(edits.some(edit => edit.newText.includes('tenantId'))).toBe(false);
    expect(edits.find(edit => edit.oldText === 'name')).toMatchObject({ newText: 'displayName: name', findingIds: [createFindings[0]!.id] });
    expect(plan.explanations.some(line => /^Migration-only mapping .* not applied: .*tenantId/.test(line))).toBe(true);
  });

  it('is deterministic for the same report and migration', async () => {
    const root = await consumer();
    const r = await report(root);
    const a = await planRepairs({ report: r, migration: await migration(), repository: root });
    const b = await planRepairs({ report: r, migration: await migration(), repository: root });
    expect(b).toEqual(a);
  });

  it('repairs axios params, bodies and response.data accesses and inserts declared query values', async () => {
    const root = await consumer();
    const r = await report(root);
    const m = await migration();
    m.values.push({ operationId: HEALTH, location: 'query', name: 'verbose', value: 'yes' });
    const plan = await planRepairs({ report: r, migration: m, repository: root });
    const axiosPatch = plan.files.find(file => file.file === 'axios-client.ts')!;
    expect(axiosPatch.edits.map(edit => [edit.oldText, edit.newText])).toEqual([
      ['/users/42', '/members/42'],
      ['locale', 'lang'],
      ['fullName', 'displayName'],
      ['', '?verbose=yes'],
      ['name', 'displayName'],
      ['', ",\n    tenantId: 'tenant-demo'"],
    ]);
    expect(plan.resolvedFindingIds).toEqual(expect.arrayContaining(findingFor(r, 'axios-client.ts', HEALTH).map(f => f.id)));
  });

  it('keeps findings pending without an explicit operation mapping, never matching by name similarity', async () => {
    const root = await consumer();
    const r = await report(root);
    const m = await migration();
    m.operations = []; m.renames = m.renames.filter(item => item.operationId !== GET_MEMBER);
    const plan = await planRepairs({ report: r, migration: m, repository: root });
    const [routeFinding] = findingFor(r, 'client.ts', GET_USER);
    expect(plan.pendingFindingIds).toContain(routeFinding!.id);
    expect(plan.files.flatMap(file => file.edits).some(edit => edit.newText.includes('members'))).toBe(false);
    expect(plan.explanations.find(line => line.includes(routeFinding!.id))).toMatch(/no explicit operation mapping/);
  });

  it('never edits a call matched only by a low-confidence path hint', async () => {
    const root = await consumer();
    const r = await report(root);
    const use = r.uses.find(item => item.file === 'client.ts' && item.operationIds.includes(GET_USER))!;
    use.resolution = 'unresolved';
    use.confidence = 'low';
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });
    const [finding] = findingFor(r, 'client.ts', GET_USER);
    expect(plan.pendingFindingIds).toContain(finding!.id);
    expect(plan.explanations.find(line => line.includes(finding!.id))).toMatch(/unresolved or low confidence/);
    expect(plan.files.flatMap(file => file.edits).some(edit => edit.findingIds.includes(finding!.id))).toBe(false);
  });

  it('leaves dynamic, shared, spread and disallowed-origin calls pending', async () => {
    const root = await consumer({
      'client.ts': `const BASE = 'http://127.0.0.1:4010';\nconst URL_CONST = BASE + '/users/7?locale=es';\nexport const a = () => fetch(URL_CONST);\nconst payload = { name: 'x' };\nexport const b = () => fetch(\`\${BASE}/users\`, { method: 'POST', body: JSON.stringify(payload) });\nexport const c = (extra: object) => fetch(\`\${BASE}/users\`, { method: 'POST', body: JSON.stringify({ ...extra, name: 'y' }) });\nexport const d = () => fetch('http://elsewhere.test/users/1?locale=es');\n`,
      'axios-client.ts': '',
    });
    const r = await report(root);
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });
    expect(plan.files).toEqual([]);
    expect(plan.unifiedDiff).toBe('');
    expect(plan.resolvedFindingIds).toEqual([]);
    const text = plan.explanations.join('\n');
    expect(text).toMatch(/URL is not an inline string or template literal/);
    expect(text).toMatch(/object is declared outside the call|not an inline object literal/);
    expect(text).toMatch(/spread\/computed members/);
  });

  it('marks response renames partial when the response object escapes', async () => {
    const root = await consumer({
      'client.ts': `const BASE = 'http://127.0.0.1:4010';\nexport async function getUser(id: string) {\n  const response = await fetch(\`\${BASE}/users/\${id}?locale=es\`);\n  const user = await response.json();\n  console.log(user);\n  return user.fullName;\n}\n`,
      'axios-client.ts': '',
    });
    const r = await report(root);
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });
    const [routeFinding] = findingFor(r, 'client.ts', GET_USER);
    expect(plan.partialFindingIds).toEqual([routeFinding!.id]);
    expect(plan.explanations.find(line => line.includes(routeFinding!.id))).toMatch(/other reads of fullName may remain/);
    expect(plan.files[0]!.edits.map(edit => edit.newText)).toEqual(['/members/${id}', 'lang', 'displayName']);
  });

  it('links body changes only through structured fieldPath and keeps root or nested paths pending', async () => {
    const root = await consumer();
    const { old, new: next } = await apis();
    const base = changes(old, next);
    const media = { file: next.documents[0]!.file, pointer: '/paths/~1users/post/requestBody/content/application~1json' };
    const variant = (rule: string, fieldPath: string[]) => ({ ...base[2]!, id: `change_${rule}`, rule, before: media, after: media, fieldPath });
    const list = [variant('flat', ['tenantId']), variant('nested', ['tenantId', 'code']), variant('root', [])];
    const r = await report(root, { changes: list });
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });
    const reason = (changeId: string) => plan.explanations.find(line => line.includes(r.findings.find(f => f.changeId === changeId)!.id))!;
    expect(reason('change_flat')).toMatch(/resolved — Add required request field tenantId/);
    expect(reason('change_nested')).toMatch(/pending — nested field tenantId\.code is outside the supported repair scope/);
    expect(reason('change_root')).toMatch(/pending — change affects the whole body schema/);
  });

  it('refuses stale files changed after analysis', async () => {
    const root = await consumer();
    const r = await report(root);
    await writeFile(path.join(root, 'client.ts'), (await read(root, 'client.ts')) + '\n// edited later\n');
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });
    expect(plan.files.map(file => file.file)).toEqual(['axios-client.ts']);
    expect(plan.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REPAIR_STALE_FILE', file: 'client.ts' })]));
  });

  it('refuses to plan through symlinked files', async () => {
    const outside = await tempDir('apipatch-outside-');
    const root = await consumer();
    const r = await report(root);
    await cp(path.join(root, 'client.ts'), path.join(outside, 'client.ts'));
    await rm(path.join(root, 'client.ts'));
    await symlink(path.join(outside, 'client.ts'), path.join(root, 'client.ts'));
    const plan = await planRepairs({ report: r, migration: await migration(), repository: root });
    expect(plan.files.map(file => file.file)).toEqual(['axios-client.ts']);
    expect(plan.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REPAIR_SYMLINK', file: 'client.ts' })]));
  });
});

describe('migration validation', () => {
  it('parses YAML/JSON and reports precise structural errors', async () => {
    expect(parseMigration(JSON.stringify(await migration()))).toEqual(await migration());
    expect(() => parseMigration('schemaVersion: "1.0"\nschemaVersion: "1.0"\n')).toThrow(RepairError);
    expect(() => parseMigration("schemaVersion: '1.0'\nallowedOrigins: []\noperations: []\nrenames: []\nvalues: []\nextra: 1\n", 'm.yaml')).toThrow(/m\.yaml#\$\.extra: unknown property/);
    expect(() => parseMigration("schemaVersion: '1.0'\nallowedOrigins: ['http://h/x']\noperations: []\nrenames: []\nvalues: []\n")).toThrow(/invalid allowed origin/);
  });

  it('rejects unknown operations, missing destination fields, contradictions and invalid values', async () => {
    const root = await consumer();
    const r = await report(root);
    const base = await migration();
    const attempt = (change: (m: MigrationConfig) => void) => { const m = structuredClone(base); change(m); return planRepairs({ report: r, migration: m, repository: root }); };
    await expect(attempt(m => { m.operations[0]!.to = 'getMember'; })).rejects.toThrow(/unknown destination operation getMember/);
    await expect(attempt(m => { m.operations[0]!.from = GET_MEMBER; })).rejects.toThrow(/unknown source operation/);
    await expect(attempt(m => { m.renames[0]!.to = 'language'; })).rejects.toThrow(/query field language does not exist in destination/);
    await expect(attempt(m => { m.renames[2]!.from = 'nombre'; })).rejects.toThrow(/request field nombre does not exist in source/);
    await expect(attempt(m => { m.renames.push({ operationId: CREATE_USER, location: 'request', from: 'displayName', to: 'tenantId' }); })).rejects.toThrow(/contradictory|chained/);
    await expect(attempt(m => { m.values.push({ operationId: CREATE_USER, location: 'request', name: 'displayName', value: 'x' }); })).rejects.toThrow(/both renamed and given a fixed value/);
    await expect(attempt(m => { m.values.push({ operationId: HEALTH, location: 'query', name: 'verbose', value: 'maybe' }); })).rejects.toThrow(/does not satisfy/);
    await expect(attempt(m => { m.renames.push({ operationId: PREFERENCES, location: 'response', from: 'mode', to: 'kind' }); })).rejects.toThrow(/cannot be verified|does not exist/);
  });
});

describe('applyRepairPlan', () => {
  async function planned(files?: Record<string, string>) {
    const root = await consumer(files);
    const plan = await planRepairs({ report: await report(root), migration: await migration(), repository: root });
    return { root, plan };
  }

  it('applies explicitly, produces parseable code and is idempotent on repeated application', async () => {
    const { root, plan } = await planned();
    const first = await applyRepairPlan(plan, root);
    expect(first).toMatchObject({ planId: plan.id, status: 'applied', files: ['axios-client.ts', 'client.ts'] });
    const after = await read(root, 'client.ts');
    expect(after).toContain('fetch(`${BASE}/members/${id}?lang=${locale}`)');
    expect(after).toContain('return user.displayName;');
    expect(after).toContain("JSON.stringify({ displayName: name, tenantId: 'tenant-demo' })");
    expect(after).toContain('// Comments and formatting around repaired calls must survive.');
    expect(parses('client.ts', after)).toBe(true);

    const second = await applyRepairPlan(plan, root);
    expect(second.status).toBe('applied');
    expect(second.diagnostics.map(d => d.code)).toEqual(['REPAIR_ALREADY_APPLIED', 'REPAIR_ALREADY_APPLIED']);
    expect(await read(root, 'client.ts')).toBe(after);
    expect(after.match(/members/g)).toHaveLength(1);
  });

  it('reports a conflict and writes nothing when any file changed after analysis', async () => {
    const { root, plan } = await planned();
    const axiosBefore = await read(root, 'axios-client.ts');
    const changed = (await read(root, 'client.ts')).replace('getUser', 'getUserRenamedByHuman');
    await writeFile(path.join(root, 'client.ts'), changed);
    const result = await applyRepairPlan(plan, root);
    expect(result).toMatchObject({ status: 'conflict', files: ['client.ts'] });
    expect(result.diagnostics[0]).toMatchObject({ code: 'REPAIR_CONFLICT', file: 'client.ts' });
    expect(await read(root, 'client.ts')).toBe(changed);
    expect(await read(root, 'axios-client.ts')).toBe(axiosBefore); // validated before any write
  });

  it('rolls back already replaced files when a later replacement fails', async () => {
    const { root, plan } = await planned();
    const before = { a: await read(root, 'axios-client.ts'), c: await read(root, 'client.ts') };
    const result = await applyRepairPlan(plan, root, { beforeReplace: file => { if (file === 'client.ts') throw new Error('disk full (simulated)'); } });
    expect(result.status).toBe('conflict');
    expect(result.diagnostics.map(d => d.code)).toEqual(['REPAIR_WRITE_FAILED', 'REPAIR_ROLLED_BACK']);
    expect(await read(root, 'axios-client.ts')).toBe(before.a);
    expect(await read(root, 'client.ts')).toBe(before.c);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not overwrite a change made between validation and replacement', async () => {
    const { root, plan } = await planned();
    const before = await read(root, 'axios-client.ts');
    const result = await applyRepairPlan(plan, root, { beforeReplace: async file => { if (file === 'client.ts') await writeFile(path.join(root, file), '// concurrent edit\n'); } });
    expect(result.status).toBe('conflict');
    expect(result.diagnostics[0]).toMatchObject({ code: 'REPAIR_CONFLICT', file: 'client.ts' });
    expect(await read(root, 'client.ts')).toBe('// concurrent edit\n');
    expect(await read(root, 'axios-client.ts')).toBe(before);
  });

  it('rejects path escapes, symlinks and tampered plans', async () => {
    const { root, plan } = await planned();
    const escaped = structuredClone(plan); escaped.files[0]!.file = '../outside.ts';
    await expect(applyRepairPlan(escaped, root)).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    const absolute = structuredClone(plan); absolute.files[0]!.file = '/etc/passwd';
    await expect(applyRepairPlan(absolute, root)).rejects.toMatchObject({ code: 'INVALID_PLAN' });

    const tampered = structuredClone(plan); tampered.files[1]!.edits[0]!.newText = '/admin/${id}';
    await expect(applyRepairPlan(tampered, root)).rejects.toMatchObject({ code: 'PLAN_TAMPERED' });
    const resigned: RepairPlan = structuredClone(tampered);
    resigned.id = stableId('repair', { reportId: resigned.reportId, migration: resigned.migration, files: resigned.files });
    await expect(applyRepairPlan(resigned, root)).rejects.toThrow(/unified diff does not match/);

    const outside = await tempDir('apipatch-outside-');
    const original = await read(root, 'client.ts');
    await writeFile(path.join(outside, 'client.ts'), original);
    await rm(path.join(root, 'client.ts'));
    await symlink(path.join(outside, 'client.ts'), path.join(root, 'client.ts'));
    const linked = await applyRepairPlan(plan, root);
    expect(linked.status).toBe('conflict');
    expect(linked.diagnostics).toEqual([expect.objectContaining({ code: 'REPAIR_SYMLINK', file: 'client.ts' })]);
    expect(await read(outside, 'client.ts')).toBe(original);
  });

  it('refuses symlinked directories inside the repository', async () => {
    const outside = await tempDir('apipatch-outside-');
    const source = `import axios from 'axios';\nexport const f = () => axios.get('http://127.0.0.1:4010/users/1?locale=es');\n`;
    const { root, plan } = await planned({ 'src/nested.ts': source });
    expect(plan.files.map(file => file.file)).toContain('src/nested.ts');
    await mkdir(path.join(outside, 'src'));
    await writeFile(path.join(outside, 'src', 'nested.ts'), source);
    await rm(path.join(root, 'src'), { recursive: true });
    await symlink(path.join(outside, 'src'), path.join(root, 'src'));
    const result = await applyRepairPlan(plan, root);
    expect(result).toMatchObject({ status: 'conflict', files: ['src/nested.ts'] });
    expect(await read(outside, 'src/nested.ts')).toBe(source);
  });
});
