import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadApi } from '../../src/openapi/index.js';
import { compareApis } from '../../src/compare/index.js';
import { SCHEMA_VERSION, validateDocument, type ApiChange, type ApiSnapshot } from '../../src/contracts/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name: string) => path.join(root, 'tests/fixtures', name);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function snapshots(oldSpec: object, newSpec: object): Promise<[ApiSnapshot, ApiSnapshot]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-test-')); dirs.push(dir);
  await writeFile(path.join(dir, 'old.json'), JSON.stringify(oldSpec));
  await writeFile(path.join(dir, 'new.json'), JSON.stringify(newSpec));
  return [await loadApi(path.join(dir, 'old.json')), await loadApi(path.join(dir, 'new.json'))];
}
async function compareSpecs(oldSpec: object, newSpec: object): Promise<ApiChange[]> {
  const [a, b] = await snapshots(oldSpec, newSpec);
  return compareApis(a, b);
}
function spec(operation: object, extra: object = {}, version = '3.1.0') {
  return { openapi: version, info: { title: 'Inline', version: '1' }, paths: { '/things': { post: operation } }, ...extra };
}
function body(schema: object) { return { required: true, content: { 'application/json': { schema } } }; }
function ok(schema: object) { return { '200': { description: 'OK', content: { 'application/json': { schema } } } }; }
/** Summaries of the form `classification rule field-or-scope` keep assertions readable. */
function find(changes: ApiChange[], rule: string, predicate: (c: ApiChange) => boolean = () => true): ApiChange {
  const match = changes.filter(c => c.rule === rule && predicate(c));
  assert.equal(match.length, 1, `expected exactly one ${rule}, got ${match.length}: ${JSON.stringify(changes.map(c => [c.rule, c.explanation]), null, 1)}`);
  return match[0]!;
}
const mentions = (text: string) => (c: ApiChange) => c.explanation.includes(text);
function assertValidReport(oldApi: ApiSnapshot, newApi: ApiSnapshot, changes: ApiChange[]) {
  validateDocument('RunReport', { schemaVersion: SCHEMA_VERSION, id: 'report_test', inputs: { old: { file: 'old', digest: oldApi.digest }, new: { file: 'new', digest: newApi.digest } }, snapshots: { old: oldApi, new: newApi }, changes, uses: [], findings: [], repairs: [], verification: [], limitations: [], diagnostics: [] });
}

test('request and response fixture contradicts symmetric rules', async () => {
  const oldApi = await loadApi(fixture('compare-directional/old.yaml')), newApi = await loadApi(fixture('compare-directional/new.yaml'));
  const changes = compareApis(oldApi, newApi);
  assertValidReport(oldApi, newApi, changes);
  const request = (c: ApiChange) => c.direction === 'request', response = (c: ApiChange) => c.direction === 'response';

  // Enum widening: compatible for requests, breaking for responses.
  assert.equal(find(changes, 'schema.enum.values-added', request).classification, 'compatible');
  assert.equal(find(changes, 'schema.enum.values-added', response).classification, 'breaking');
  assert.deepEqual(find(changes, 'schema.enum.values-added', response).newValue, ['archived']);
  // Enum narrowing in a request breaks.
  assert.equal(find(changes, 'schema.enum.values-removed', request).classification, 'breaking');
  // New required request field breaks; new required response field is a new guarantee.
  assert.equal(find(changes, 'schema.required.added', c => request(c) && mentions('currency')(c)).classification, 'breaking');
  assert.deepEqual(find(changes, 'schema.required.added', c => request(c) && mentions('currency')(c)).fieldPath, ['currency']);
  assert.equal(find(changes, 'schema.required.added', c => response(c) && mentions('trackingUrl')(c)).classification, 'compatible');
  // Dropping a requirement: compatible for requests, a removed guarantee for responses.
  assert.equal(find(changes, 'schema.required.removed', c => request(c) && mentions('note')(c)).classification, 'compatible');
  assert.equal(find(changes, 'schema.required.removed', c => response(c) && mentions('total')(c)).classification, 'breaking');
  assert.equal(find(changes, 'schema.property.removed', c => response(c) && mentions('legacy')(c)).classification, 'breaking');
  assert.deepEqual(find(changes, 'schema.property.removed', c => response(c) && mentions('legacy')(c)).fieldPath, ['legacy']);
  assert.equal(find(changes, 'schema.property.removed', c => response(c) && mentions('nickname')(c)).classification, 'ambiguous');
  // integer -> number widens: safe to send, unsafe to receive.
  assert.equal(find(changes, 'schema.type.widened', request).classification, 'compatible');
  assert.equal(find(changes, 'schema.type.widened', response).classification, 'breaking');
  // Shorter maxLength narrows: breaks requests, safe for responses.
  assert.equal(find(changes, 'schema.length.narrowed', request).classification, 'breaking');
  assert.equal(find(changes, 'schema.length.narrowed', response).classification, 'compatible');
  // Parameters and operations.
  const expand = find(changes, 'parameter.added.required');
  assert.equal(expand.classification, 'breaking'); assert.equal(expand.location, 'query');
  assert.equal(find(changes, 'parameter.added.optional').classification, 'compatible');
  const removed = changes.filter(c => c.rule === 'operation.removed').map(c => `${c.method} ${c.path}`).sort();
  assert.deepEqual(removed, ['delete /orders/{orderId}', 'put /items']);
  const methodChange = find(changes, 'operation.removed', c => c.path === '/items');
  assert.ok(methodChange.evidence.some(e => e.message.includes('POST') && e.message.includes('removal plus addition')));
  assert.equal(find(changes, 'operation.added').method, 'post');
  const renamed = find(changes, 'operation.path-template.renamed');
  assert.equal(renamed.classification, 'compatible');
  assert.equal(changes.filter(c => c.path === '/users/{id}' && c.rule !== 'operation.path-template.renamed').length, 0);
  // Every change carries evidence with source locations and an ID derived from the old operation.
  for (const change of changes) {
    assert.ok(change.evidence.length > 0 && change.evidence.some(e => e.source), change.rule);
    const owner = oldApi.operations.find(op => op.id === change.operationId) ?? newApi.operations.find(op => op.id === change.operationId);
    assert.ok(owner, change.rule);
  }
});

test('compatible evolution raises no breaking or ambiguous change', async () => {
  const oldApi = await loadApi(fixture('compare-compatible/old.json')), newApi = await loadApi(fixture('compare-compatible/new.json'));
  const changes = compareApis(oldApi, newApi);
  assertValidReport(oldApi, newApi, changes);
  assert.deepEqual(changes.filter(c => c.classification !== 'compatible').map(c => [c.rule, c.explanation]), []);
  const rules = new Set(changes.map(c => c.rule));
  for (const rule of ['operation.added', 'parameter.added.optional', 'schema.range.widened', 'schema.enum.values-added', 'schema.required.removed', 'schema.property.added', 'schema.required.added', 'schema.enum.values-removed', 'schema.length.narrowed', 'response.status.added', 'security.relaxed']) assert.ok(rules.has(rule), rule);
  // OpenAPI 3.1 `$ref` + description becomes allOf in the snapshot; annotation-only wrappers are not composition changes.
  assert.ok(!rules.has('schema.composition.changed'));
  assert.deepEqual(compareApis(oldApi, oldApi), []);
});

test('OpenAPI 3.0 nullable and boolean exclusiveMinimum match their 3.1 forms', async () => {
  const oldApi = await loadApi(fixture('compare-dialect/old-3.0.yaml')), newApi = await loadApi(fixture('compare-dialect/new-3.1.yaml'));
  const changes = compareApis(oldApi, newApi);
  assert.deepEqual(changes.map(c => [c.rule, c.direction, c.classification]), [['schema.nullable.added', 'response', 'breaking']]);
  assert.match(changes[0]!.explanation, /"body\.unit"/);
});

test('demo specs: removals, renames as removal plus addition, required fields and ambiguous composition', async () => {
  const oldApi = await loadApi(path.join(root, 'demo/specs/v1.yaml')), newApi = await loadApi(path.join(root, 'demo/specs/v2.yaml'));
  const changes = compareApis(oldApi, newApi);
  assertValidReport(oldApi, newApi, changes);
  assert.equal(find(changes, 'operation.removed').path, '/users/{id}');
  // Scanner links findings through ApiChange.operationId === old ApiOperation.id; additions use the new ID.
  assert.equal(find(changes, 'operation.removed').operationId, oldApi.operations.find(op => op.path === '/users/{id}')!.id);
  assert.ok(changes.filter(c => c.path === '/users').every(c => c.operationId === oldApi.operations.find(op => op.path === '/users' && op.method === 'post')!.id));
  assert.equal(find(changes, 'operation.added').operationId, newApi.operations.find(op => op.path === '/members/{id}')!.id);
  assert.equal(find(changes, 'operation.added').path, '/members/{id}');
  const create = changes.filter(c => c.path === '/users');
  assert.deepEqual(create.filter(c => c.rule === 'schema.required.added').map(c => c.classification), ['breaking', 'breaking']);
  assert.equal(find(create, 'schema.property.removed').classification, 'ambiguous', 'removed request property is not proven to be rejected');
  assert.ok(!create.some(c => c.rule === 'schema.required.removed'), 'a removed property is reported once');
  assert.ok(!changes.some(c => c.explanation.includes('renamed') && c.path === '/users'), 'no rename inferred');
  const health = changes.filter(c => c.path === '/health');
  assert.ok(health.length > 0 && health.every(c => c.classification === 'compatible'));
  assert.equal(find(changes, 'schema.composition.changed').classification, 'ambiguous');
  assert.equal(find(changes, 'schema.composition.changed').path, '/preferences');
});

test('output is deterministic and IDs are unique and stable', async () => {
  const oldApi = await loadApi(fixture('compare-directional/old.yaml')), newApi = await loadApi(fixture('compare-directional/new.yaml'));
  const first = compareApis(oldApi, newApi), second = compareApis(structuredClone(oldApi), structuredClone(newApi));
  assert.deepEqual(second, first);
  assert.equal(new Set(first.map(c => c.id)).size, first.length);
  assert.ok(first.every(c => /^change_[a-f0-9]{24}$/.test(c.id)));
  // Reordered operations in the snapshot do not change order or IDs.
  const shuffled = { ...newApi, operations: [...newApi.operations].reverse() };
  assert.deepEqual(compareApis(oldApi, shuffled), first);
});

test('request property removal is ambiguous unless additionalProperties forbids it', async () => {
  const open = await compareSpecs(spec({ requestBody: body({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }), responses: ok({}) }), spec({ requestBody: body({ type: 'object', properties: { a: { type: 'string' } } }), responses: ok({}) }));
  assert.equal(find(open, 'schema.property.removed').classification, 'ambiguous');
  const closed = await compareSpecs(spec({ requestBody: body({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }), responses: ok({}) }), spec({ requestBody: body({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }), responses: ok({}) }));
  assert.equal(find(closed, 'schema.property.removed').classification, 'breaking');
  assert.equal(find(closed, 'schema.additional-properties.narrowed').classification, 'ambiguous');
});

test('response nullability, type changes and composition', async () => {
  const response = (schema: object) => spec({ responses: ok(schema) });
  const nullable = await compareSpecs(response({ type: 'object', properties: { a: { type: 'string' } } }), response({ type: 'object', properties: { a: { type: ['string', 'null'] } } }));
  assert.equal(find(nullable, 'schema.nullable.added').classification, 'breaking');
  const changed = await compareSpecs(response({ type: 'object', properties: { a: { type: 'string', maxLength: 3 } } }), response({ type: 'object', properties: { a: { type: 'integer', maximum: 3 } } }));
  assert.deepEqual(changed.map(c => [c.rule, c.classification]), [['schema.type.changed', 'breaking']]);
  const composed = await compareSpecs(response({ oneOf: [{ type: 'string' }, { type: 'integer' }] }), response({ oneOf: [{ type: 'string' }, { type: 'boolean' }] }));
  assert.deepEqual(composed.map(c => [c.rule, c.classification]), [['schema.composition.changed', 'ambiguous']]);
  // Unchanged composition: sibling narrowing in a request cannot be proven to break.
  const sibling = await compareSpecs(spec({ requestBody: body({ anyOf: [{ required: ['a'] }, { required: ['b'] }], type: 'object', properties: { a: { type: 'string' } } }), responses: ok({}) }), spec({ requestBody: body({ anyOf: [{ required: ['a'] }, { required: ['b'] }], type: 'object', properties: { a: { type: 'string', maxLength: 4 } } }), responses: ok({}) }));
  assert.equal(find(sibling, 'schema.length.narrowed').classification, 'ambiguous');
  const format = await compareSpecs(response({ type: 'string', format: 'date' }), response({ type: 'string', format: 'date-time' }));
  assert.equal(find(format, 'schema.format.changed').classification, 'ambiguous');
  const unknown = await compareSpecs(response({ type: 'object', patternProperties: { '^x': { type: 'string' } } }), response({ type: 'object', patternProperties: { '^x': { type: 'integer' } } }));
  assert.equal(find(unknown, 'schema.keyword.unsupported').classification, 'ambiguous');
});

test('readOnly required properties do not bind requests', async () => {
  const schema = (required: string[]) => ({ type: 'object', required, properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' } } });
  const changes = await compareSpecs(spec({ requestBody: body(schema(['name'])), responses: ok({}) }), spec({ requestBody: body(schema(['name', 'id'])), responses: ok({}) }));
  assert.deepEqual(changes, []);
});

test('response status and media type changes', async () => {
  const before = spec({ responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } }, 'text/csv': { schema: { type: 'string' } } } } } });
  const after = spec({ responses: { '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object' } } } }, '409': { description: 'Conflict' } } });
  const changes = await compareSpecs(before, after);
  assert.equal(find(changes, 'response.status.removed').classification, 'ambiguous');
  assert.equal(find(changes, 'response.status.added', c => c.newValue === '201').classification, 'ambiguous');
  assert.equal(find(changes, 'response.status.added', c => c.newValue === '409').classification, 'compatible');
  const media = await compareSpecs(before, spec({ responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } }));
  assert.deepEqual(media.map(c => [c.rule, c.classification]), [['response.media-type.removed', 'breaking']]);
  const request = await compareSpecs(spec({ requestBody: { content: { 'application/xml': { schema: {} } } }, responses: ok({}) }), spec({ requestBody: { required: true, content: { 'application/json': { schema: {} } } }, responses: ok({}) }));
  assert.deepEqual(request.map(c => [c.rule, c.classification]).sort(), [['request.body.became-required', 'breaking'], ['request.media-type.added', 'compatible'], ['request.media-type.removed', 'breaking']]);
});

test('media types that normalize to the same key require manual review instead of dropping a schema', async () => {
  const response = (one: string, two: string) => spec({ responses: {
    '200': { description: 'OK', content: {
      'application/json': { schema: { type: one } },
      'application/json; charset=utf-8': { schema: { type: two } },
    } },
  } });
  const changes = await compareSpecs(response('object', 'string'), response('object', 'integer'));
  const collision = find(changes, 'response.media-type.collision');
  assert.equal(collision.classification, 'ambiguous');
  assert.deepEqual(collision.oldValue, ['application/json', 'application/json; charset=utf-8']);
});

test('security: effective requirements are compared as alternatives', async () => {
  const op = (security?: object[]) => spec({ responses: ok({}), ...(security ? { security } : {}) });
  const added = await compareSpecs(op(), op([{ oauth: ['read'] }]));
  assert.deepEqual(added.map(c => [c.rule, c.classification, c.location, c.direction]), [['security.authentication.required', 'breaking', 'security', 'security']]);
  assert.match(added[0]!.explanation, /never creates/);
  const replaced = await compareSpecs(op([{ apiKey: [] }]), op([{ bearer: [] }]));
  assert.deepEqual(replaced.map(c => [c.rule, c.classification]), [['security.requirement.unsatisfied', 'breaking']]);
  const scopes = await compareSpecs(op([{ oauth: ['read'] }]), op([{ oauth: ['read', 'write'] }]));
  assert.deepEqual(scopes.map(c => [c.rule, c.classification]), [['security.scopes.added', 'ambiguous']]);
  const relaxed = await compareSpecs(op([{ apiKey: [], oauth: ['read'] }]), op([{ apiKey: [] }, {}]));
  assert.deepEqual(relaxed.map(c => [c.rule, c.classification]), [['security.relaxed', 'compatible']]);
  const global = await compareSpecs(spec({ responses: ok({}) }, { security: [{ apiKey: [] }] }), spec({ responses: ok({}) }, { security: [{ apiKey: [] }] }));
  assert.deepEqual(global, []);
  const reordered = await compareSpecs(op([{ a: [] }, { b: [] }]), op([{ b: [] }, { a: [] }]));
  assert.deepEqual(reordered, []);
});

test('parameters: requirement changes, removal ambiguity and case-insensitive headers', async () => {
  const op = (parameters: object[]) => spec({ parameters, responses: ok({}) });
  const changes = await compareSpecs(
    op([{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'X-Trace', in: 'header', schema: { type: 'string' } }, { name: 'old', in: 'query', schema: { type: 'string' } }]),
    op([{ name: 'q', in: 'query', required: true, schema: { type: 'string', enum: ['a'] } }, { name: 'x-trace', in: 'header', schema: { type: 'string' } }]));
  assert.equal(find(changes, 'parameter.became-required').classification, 'breaking');
  assert.equal(find(changes, 'schema.enum.narrowed').classification, 'breaking');
  assert.equal(find(changes, 'parameter.removed').classification, 'ambiguous');
  assert.ok(!changes.some(c => c.location === 'header'));
});

test('recursive schemas terminate and still report differences outside the cycle', async () => {
  const api = (nameType: string) => ({ openapi: '3.1.0', info: { title: 'Tree', version: '1' }, paths: { '/tree': { get: { responses: ok({ $ref: '#/components/schemas/Node' }) } } }, components: { schemas: { Node: { type: 'object', required: ['name'], properties: { name: { type: nameType }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } } } });
  const [a, b] = await snapshots(api('string'), api('string'));
  assert.deepEqual(compareApis(a, b), []);
  const changes = await compareSpecs(api('string'), api('integer'));
  assert.deepEqual(changes.map(c => [c.rule, c.classification]), [['schema.type.changed', 'breaking']]);
});

test('specific status documented only as a range is ambiguous and still compared', async () => {
  const changes = await compareSpecs(spec({ responses: ok({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }) }), spec({ responses: { '2XX': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } } } } } }));
  assert.deepEqual(changes.map(c => [c.rule, c.classification]), [['response.status.generalized', 'ambiguous'], ['schema.required.removed', 'breaking']]);
});

test('path parameters are matched by template position', async () => {
  const api = (name: string, type: string) => ({ openapi: '3.0.3', info: { title: 'P', version: '1' }, paths: { [`/a/{${name}}`]: { get: { parameters: [{ name, in: 'path', required: true, schema: { type } }], responses: ok({}) } } } });
  const changes = await compareSpecs(api('id', 'string'), api('key', 'integer'));
  assert.deepEqual(changes.map(c => [c.rule, c.location, c.classification]), [['operation.path-template.renamed', 'path', 'compatible'], ['schema.type.changed', 'path', 'breaking']]);
});
