import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {
  SCHEMA_VERSION, stableId, validateDocument,
  type ApiChange, type ApiSnapshot, type MigrationConfig, type RunReport,
} from '../../src/contracts/index.js';
import { loadApi } from '../../src/openapi/index.js';
import { scanRepository } from '../../src/scan/index.js';
import { applyRepairPlan, loadMigration, planRepairs, RepairError } from '../../src/repair/index.js';

const FIXTURE = path.resolve('tests/fixtures/repair-nested');
const ORDERS = stableId('operation', { method: 'post', route: '/orders' });
const PROFILES = stableId('operation', { method: 'get', route: '/profiles/{id}' });
const ACCOUNTS = stableId('operation', { method: 'get', route: '/accounts/{id}' });
const PEOPLE = stableId('operation', { method: 'get', route: '/people/{id}' });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

let snapshots: { old: ApiSnapshot; new: ApiSnapshot } | undefined;
async function apis() {
  snapshots ??= { old: await loadApi(path.join(FIXTURE, 'v1.yaml')), new: await loadApi(path.join(FIXTURE, 'v2.yaml')) };
  return snapshots;
}

/** Synthetic changes shaped like compare output; fields are linked only through `fieldPath`. */
function changes(): ApiChange[] {
  const change = (partial: Omit<ApiChange, 'id' | 'evidence' | 'explanation'>): ApiChange =>
    ({ id: stableId('change', partial), explanation: partial.rule, evidence: [], ...partial });
  const orders = { operationId: ORDERS, method: 'post' as const, path: '/orders', location: 'request' as const, direction: 'request' as const, classification: 'breaking' as const };
  const profiles = { operationId: PROFILES, method: 'get' as const, path: '/profiles/{id}', location: 'response' as const, direction: 'response' as const, classification: 'breaking' as const };
  return [
    change({ ...orders, rule: 'request-property-removed', fieldPath: ['shipping', 'address', 'city'] }),
    change({ ...orders, rule: 'request-required-added', fieldPath: ['shipping', 'address', 'country'] }),
    change({ ...profiles, rule: 'response-property-removed', fieldPath: ['fullName'] }),
    change({ ...profiles, rule: 'response-property-removed', fieldPath: ['address', 'city'] }),
    change({ operationId: ACCOUNTS, method: 'get', path: '/accounts/{id}', location: 'path', rule: 'operation-removed', direction: 'operation', classification: 'breaking' }),
  ];
}

async function consumer(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-nested-'));
  roots.push(root);
  await cp(path.join(FIXTURE, 'consumer'), root, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return root;
}

async function report(root: string, list = changes()): Promise<RunReport> {
  const { old, new: next } = await apis();
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
const parses = (text: string) => !ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { noEmit: true } }).diagnostics?.length;

/** Finding ids and explanation of the use in `file` whose `functionName` contains the call. */
function findingsIn(r: RunReport, file: string, text: string, functionName: string, rule?: string) {
  const start = text.indexOf(`function ${functionName}(`);
  const end = text.indexOf('\nexport ', start + 1);
  const use = r.uses.find(item => item.file === file && item.range.start > start && (end < 0 || item.range.start < end));
  return r.findings.filter(item => item.useId === use?.id && (!rule || r.changes.find(change => change.id === item.changeId)!.fieldPath?.join('.') === rule));
}

async function plan(files: Record<string, string> = {}, migrationOverride?: (m: MigrationConfig) => MigrationConfig) {
  const root = await consumer(files);
  const r = await report(root);
  const base = await migration();
  const result = await planRepairs({ report: r, migration: migrationOverride ? migrationOverride(base) : base, repository: root });
  const explain = (id: string) => result.explanations.find(line => line.startsWith(`Finding ${id}`))!;
  const edits = (file: string) => result.files.find(item => item.file === file)?.edits.map(edit => [edit.oldText, edit.newText]) ?? [];
  return { root, r, plan: result, explain, edits };
}

describe('nested request repairs', () => {
  it('renames a nested shorthand key and adds a nested value at the allOf destination path', async () => {
    const { root, r, plan: p, explain, edits } = await plan();
    const text = await read(root, 'orders.ts');
    expect(edits('orders.ts')).toEqual([
      ['city', 'town: city'],
      ['', ",\n          country: 'ES'"],
      ["'city'", "'town'"],
      ['', ", country: 'ES'"],
    ]);
    for (const fn of ['createOrder', 'createOrderAxios']) {
      const [rename] = findingsIn(r, 'orders.ts', text, fn, 'shipping.address.city');
      const [value] = findingsIn(r, 'orders.ts', text, fn, 'shipping.address.country');
      expect(p.resolvedFindingIds).toEqual(expect.arrayContaining([rename!.id, value!.id]));
      expect(explain(rename!.id)).toMatch(/resolved — Rename request field shipping\.address\.city → shipping\.address\.town \(explicit nested rename mapping, parent shipping\.address\)/);
      expect(explain(value!.id)).toMatch(/resolved — Add required request field shipping\.address\.country = "ES"/);
    }
    const edit = p.files.find(item => item.file === 'orders.ts')!.edits[0]!;
    expect(edit.findingIds).toEqual([findingsIn(r, 'orders.ts', text, 'createOrder', 'shipping.address.city')[0]!.id]);
    expect(edit.reason).toMatch(/parent shipping\.address/);
  });

  const order = (body: string) => `const BASE = 'http://127.0.0.1:4010';\nexport async function createOrder(item: string, shipping: any, extra: any) {\n  return fetch(\`\${BASE}/orders\`, { method: 'POST', body: JSON.stringify(${body}) });\n}\n`;
  it.each([
    ['segment is a variable', '{ item, shipping }', /request body\.shipping is not an inline object literal/],
    ['spread on the path', '{ item, shipping: { ...extra, address: { city: "x" } } }', /request body\.shipping has spread\/computed members/],
    ['spread in the leaf object', '{ item, shipping: { address: { ...extra, city: "x" } } }', /spread\/computed members/],
    ['duplicate key on the path', '{ item, shipping: { address: { city: "x" }, address: { city: "y" } } }', /defines address more than once/],
    ['destination already present', '{ item, shipping: { address: { city: "x", town: "y", country: "ES" } } }', /already defines town/],
  ])('keeps the nested rename pending when the %s', async (_label, body, reason) => {
    const { root, r, plan: p, explain } = await plan({ 'orders.ts': order(body), 'profiles.ts': '', 'accounts.ts': '' });
    const [rename] = findingsIn(r, 'orders.ts', await read(root, 'orders.ts'), 'createOrder', 'shipping.address.city');
    expect(p.pendingFindingIds).toContain(rename!.id);
    expect(explain(rename!.id)).toMatch(reason);
    expect(p.files.flatMap(file => file.edits).some(edit => edit.findingIds.includes(rename!.id))).toBe(false);
  });

  it('rejects nested paths that cannot be verified at plan time', async () => {
    const root = await consumer();
    const r = await report(root);
    const base = await migration();
    const attempt = (rename: object) => planRepairs({ report: r, migration: { ...base, renames: [{ operationId: ORDERS, location: 'request', from: 'a', to: 'b', ...rename } as never] }, repository: root });
    await expect(attempt({ parent: ['options'], from: 'gift', to: 'present' })).rejects.toThrow(/cannot be verified: options uses oneOf/);
    await expect(attempt({ parent: ['lines'], from: 'sku', to: 'code' })).rejects.toThrow(/cannot be verified: lines is an array/);
    await expect(attempt({ parent: ['labels'], from: 'x', to: 'y' })).rejects.toThrow(/labels declares no properties/);
    await expect(attempt({ parent: ['shipping', 'missing'], from: 'x', to: 'y' })).rejects.toThrow(/does not exist/);
    await expect(attempt({ parent: ['shipping', 'address'], from: 'zip', to: 'town' })).rejects.toThrow(/request field shipping\.address\.zip does not exist in source/);
    await expect(attempt({ parent: ['shipping', 'address'], from: 'city', to: 'zip' })).rejects.toThrow(/shipping\.address\.zip does not exist in destination/);
    const value = (mapping: object) => planRepairs({ report: r, migration: { ...base, values: [{ operationId: ORDERS, location: 'request', parent: ['shipping', 'address'], name: 'country', value: 'ES', ...mapping } as never] }, repository: root });
    await expect(value({ value: 'FR' })).rejects.toThrow(/does not satisfy the declared type\/enum of country/);
    await expect(value({ parent: ['options'] })).rejects.toBeInstanceOf(RepairError);
  });

  it('rejects contradictory mappings only within the same parent path', async () => {
    const root = await consumer();
    const r = await report(root);
    const base = await migration();
    await expect(planRepairs({ report: r, migration: { ...base, values: [...base.values, { operationId: ORDERS, location: 'request', parent: ['shipping', 'address'], name: 'city', value: 'x' }] }, repository: root }))
      .rejects.toThrow(/both renamed and given a fixed value/);
  });
});

describe('nested response repairs', () => {
  it('renames nested accesses with optional chaining and axios, and the four destructuring forms', async () => {
    const { root, r, plan: p, explain, edits } = await plan();
    const text = await read(root, 'profiles.ts');
    expect(edits('profiles.ts')).toEqual([
      ['fullName', 'displayName'],
      ['city', 'town'],
      ['city', 'town'],
      ['fullName', 'displayName: fullName'],
      ['fullName', 'displayName'],
      ['fullName', 'displayName'],
      ['city', 'town: city'],
      ['city', 'town'],
    ]);
    for (const fn of ['profileCity', 'profileDestructured', 'profileAxios']) {
      const [nested] = findingsIn(r, 'profiles.ts', text, fn, 'address.city');
      expect(p.resolvedFindingIds).toContain(nested!.id);
      expect(explain(nested!.id)).toMatch(/Rename response field access address\.city → address\.town \(explicit nested rename mapping, parent address\)/);
    }
  });

  const profile = (body: string) => `const BASE = 'http://127.0.0.1:4010';\nexport async function profile(id: string, k: string, show: (v: unknown) => void) {\n  const response = await fetch(\`\${BASE}/profiles/\${id}\`);\n  const data = await response.json();\n${body}\n}\n`;
  it.each([
    ['element access', "  return data['address'].city;", 'address.city', /element access on response is not followed/],
    ['element access on the nested object', "  return data.address['city'];", 'address.city', /element access on response\.address is not followed/],
    ['rest element', '  const { ...rest } = data;\n  return rest;', 'fullName', /uses a rest element/],
    ['rest element in a nested pattern', '  const { address: { zip, ...others } } = data;\n  return others;', 'address.city', /destructuring of response\.address uses a rest element/],
    ['computed key', '  const { [k]: value } = data;\n  return value;', 'fullName', /uses computed keys/],
    ['destructuring assignment', '  let fullName;\n  ({ fullName } = data);\n  return fullName;', 'fullName', /destructured in an assignment/],
    ['nested object passed on', '  show(data.address);', 'address.city', /response\.address is also used in ways APIPatch cannot follow/],
    ['nested object aliased', '  const { address } = data;\n  return address.city;', 'address.city', /response\.address is bound to a variable/],
  ])('leaves %s partial with a caveat and never edits it', async (_label, body, fieldPath, reason) => {
    const { root, r, plan: p, explain } = await plan({ 'profiles.ts': profile(body), 'orders.ts': '', 'accounts.ts': '' });
    const [finding] = findingsIn(r, 'profiles.ts', await read(root, 'profiles.ts'), 'profile', fieldPath);
    expect(p.partialFindingIds).toContain(finding!.id);
    expect(explain(finding!.id)).toMatch(reason);
    expect(p.files).toEqual([]);
  });

  it('edits the readable accesses and keeps the caveat when a parameter destructures the response', async () => {
    const body = '  const read = ({ fullName }: any) => fullName;\n  read(data);\n  return data.fullName;';
    const { root, r, plan: p, explain, edits } = await plan({ 'profiles.ts': profile(body), 'orders.ts': '', 'accounts.ts': '' });
    const [finding] = findingsIn(r, 'profiles.ts', await read(root, 'profiles.ts'), 'profile', 'fullName');
    expect(p.partialFindingIds).toContain(finding!.id);
    expect(explain(finding!.id)).toMatch(/other reads of fullName may remain/);
    expect(edits('profiles.ts')).toEqual([['fullName', 'displayName']]);
  });
});

describe('linkage, wrappers and moved operations', () => {
  it('links a nested finding only to a mapping with the same parent', async () => {
    const { root, r, plan: p, explain } = await plan({}, m => ({ ...m, renames: m.renames.filter(item => item.parent?.join('.') !== 'address') }));
    const [nested] = findingsIn(r, 'profiles.ts', await read(root, 'profiles.ts'), 'profileCity', 'address.city');
    expect(p.pendingFindingIds).toContain(nested!.id);
    expect(explain(nested!.id)).toMatch(/nested field address\.city is outside the supported repair scope: no explicit nested migration mapping with parent address/);
  });

  it('keeps calls made through a repository wrapper pending', async () => {
    const root = await consumer();
    const r = await report(root);
    const text = await read(root, 'profiles.ts');
    const target = findingsIn(r, 'profiles.ts', text, 'profileCity')[0]!.useId;
    const wrapped = validateDocument('RunReport', { ...r, uses: r.uses.map(use => use.id === target ? { ...use, via: { name: 'getProfile', file: 'src/api/profiles.ts', range: { start: 10, end: 40, line: 3, column: 1 } } } : use) });
    const p = await planRepairs({ report: wrapped, migration: await migration(), repository: root });
    const ids = wrapped.findings.filter(finding => finding.useId === target).map(finding => finding.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(p.pendingFindingIds).toEqual(expect.arrayContaining(ids));
    for (const id of ids) expect(p.explanations.find(line => line.startsWith(`Finding ${id}`))).toMatch(/wrapper getProfile \(src\/api\/profiles\.ts:3\); wrapper calls are not edited/);
    const start = text.indexOf('function profileCity('), end = text.indexOf('function profileDestructured(');
    expect(p.files.find(file => file.file === 'profiles.ts')!.edits.some(edit => edit.start > start && edit.start < end)).toBe(false);
  });

  it('resolves a moved operation whose nested response change is demonstrated by an explicit nested rename', async () => {
    const { root, r, plan: p, explain, edits } = await plan();
    const [moved] = findingsIn(r, 'accounts.ts', await read(root, 'accounts.ts'), 'accountTown');
    expect(edits('accounts.ts')).toEqual([['/accounts/${id}', '/people/${id}'], ['city', 'town']]);
    expect(p.resolvedFindingIds).toContain(moved!.id);
    expect(explain(moved!.id)).toMatch(/resolved — all destination obligations covered/);
  });

  it('keeps the moved operation partial without the nested mapping', async () => {
    const { root, r, plan: p, explain } = await plan({}, m => ({ ...m, renames: m.renames.filter(item => item.operationId !== PEOPLE) }));
    const [moved] = findingsIn(r, 'accounts.ts', await read(root, 'accounts.ts'), 'accountTown');
    expect(p.partialFindingIds).toContain(moved!.id);
    expect(explain(moved!.id)).toMatch(/response field address has a different schema in the destination/);
  });
});

describe('end to end', () => {
  it('applies the nested plan to a temporary copy and matches the expected snapshot', async () => {
    const { root, plan: p } = await plan();
    const result = await applyRepairPlan(p, root);
    expect(result.status).toBe('applied');
    for (const file of ['orders.ts', 'profiles.ts', 'accounts.ts']) {
      const text = await read(root, file);
      expect(parses(text)).toBe(true);
      expect(text).toBe(await readFile(path.join(FIXTURE, 'expected', file), 'utf8'));
    }
    expect(await read(root, 'orders.ts')).toContain('// Nested body edited in place; this comment must survive.');
  });
});
