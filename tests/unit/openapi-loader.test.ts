import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { loadApi, ApiLoadError } from '../../src/openapi/index.js';
import { validateDocument } from '../../src/contracts/index.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>): Promise<{ dir: string; file: (name: string) => string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openapi-test-')); dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(dir, name), contents);
  return { dir, file: name => path.join(dir, name) };
}
function base(version: string) {
  return { openapi: version, info: { title: 'Fixture', version: '1' }, paths: { '/pets/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { operationId: 'getPet', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } } } } } }, security: [{ apiKey: [] }], servers: [{ url: 'https://example.test' }] };
}
for (const version of ['3.0.3', '3.1.1']) for (const format of ['json', 'yaml']) {
  test(`loads ${version} ${format} and normalizes operations`, async () => {
    const spec = base(version), text = format === 'json' ? JSON.stringify(spec) : YAML.stringify(spec);
    const { file } = await fixture({ [`api.${format}`]: text });
    const snap = await loadApi(file(`api.${format}`));
    validateDocument('ApiSnapshot', snap);
    assert.equal(snap.openapi, version);
    assert.equal(snap.operations.length, 1);
    const op = snap.operations[0]!;
    assert.equal(op.operationId, 'getPet');
    assert.deepEqual(op.parameters.map(p => p.name), ['id', 'q']);
    assert.deepEqual(op.security, [{ apiKey: [] }]);
    assert.equal(op.responses[0]?.content[0]?.schema && (op.responses[0].content[0].schema as { type: string }).type, 'object');
    assert.deepEqual(op.servers, ['https://example.test']);
    assert.equal(snap.documents.length, 1);
    assert.equal((await loadApi(file(`api.${format}`))).id, snap.id);
  });
}

test('operation parameters override inherited parameters by name and location; security overrides globals', async () => {
  const spec = base('3.1.0');
  const route = spec.paths['/pets/{id}'];
  route.get.parameters.push({ name: 'id', in: 'path', required: true, schema: { type: 'integer' } } as never);
  Object.assign(route.get, { security: [], servers: [{ url: 'https://override.test' }] });
  const { file } = await fixture({ 'api.json': JSON.stringify(spec) });
  const op = (await loadApi(file('api.json'))).operations[0]!;
  assert.equal((op.parameters[0]!.schema as { type: string }).type, 'integer');
  assert.deepEqual(op.security, []);
  assert.deepEqual(op.servers, ['https://override.test']);
});

test('resolves relative and nested schema refs while retaining recursive edge', async () => {
  const spec = base('3.1.0');
  spec.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema = { $ref: './schemas.yaml#/$defs/Pet' } as never;
  const schema = { $defs: { Pet: { type: 'object', properties: { friend: { $ref: '#/$defs/Pet' }, tag: { $ref: '#/$defs/Tag' } } }, Tag: { type: 'string' } } };
  const { file } = await fixture({ 'api.json': JSON.stringify(spec), 'schemas.yaml': YAML.stringify(schema) });
  const snap = await loadApi(file('api.json'));
  const normalized = snap.operations[0]!.responses[0]!.content[0]!.schema as { properties: Record<string, unknown> };
  assert.deepEqual(normalized.properties.tag, { type: 'string' });
  assert.deepEqual(normalized.properties.friend, { $ref: '#/$defs/Pet' });
  assert.equal(snap.documents.length, 2);
  assert.equal(snap.references.length, 3);
  assert.equal(snap.references.filter(r => r.recursive).length, 1);
  assert.equal(snap.diagnostics[0]?.code, 'RECURSIVE_SCHEMA');
});

test('preserves 3.0 nullable and 3.1 null union, with conservative ref sibling handling', async () => {
  const old = base('3.0.3'), modern = base('3.1.0');
  old.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Name', nullable: true } as never;
  modern.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Name', minLength: 2 } as never;
  Object.assign(old, { components: { schemas: { Name: { type: 'string', nullable: true } } } });
  Object.assign(modern, { components: { schemas: { Name: { type: ['string', 'null'] } } } });
  const { file } = await fixture({ 'old.json': JSON.stringify(old), 'modern.json': JSON.stringify(modern) });
  const a = await loadApi(file('old.json')), b = await loadApi(file('modern.json'));
  assert.deepEqual(a.operations[0]!.responses[0]!.content[0]!.schema, { type: 'string', nullable: true });
  assert.equal(a.diagnostics[0]?.code, 'IGNORED_REF_SIBLINGS');
  assert.deepEqual(b.operations[0]!.responses[0]!.content[0]!.schema, { allOf: [{ type: ['string', 'null'] }, { minLength: 2 }] });
});

test('rejects remote, broken, traversal and symlink-escape references', async () => {
  const outside = await fixture({ 'escape.json': JSON.stringify({ type: 'string' }) });
  const spec = base('3.1.0');
  const schema = spec.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema;
  const { dir, file } = await fixture({ 'api.json': JSON.stringify(spec) });
  await symlink(outside.file('escape.json'), path.join(dir, 'link.json'));
  for (const [ref, code] of [['https://example.test/a.json', 'REMOTE_REF'], ['#/missing', 'BROKEN_REF'], ['../missing.json#/x', 'REF_OUTSIDE_ROOT'], ['./link.json#', 'REF_OUTSIDE_ROOT']] as const) {
    Object.assign(schema, { $ref: ref }); await writeFile(file('api.json'), JSON.stringify(spec));
    await assert.rejects(loadApi(file('api.json')), (error: unknown) => error instanceof ApiLoadError && error.code === code && error.source.pointer.includes('$ref'));
  }
});

test('rejects invalid versions and shape in all four version/format pairs', async () => {
  for (const version of ['3.0.3', '3.1.0']) for (const format of ['json', 'yaml']) {
    const spec = base(version); delete (spec.paths['/pets/{id}'].get as Record<string, unknown>).responses;
    const { file } = await fixture({ [`bad.${format}`]: format === 'json' ? JSON.stringify(spec) : YAML.stringify(spec) });
    await assert.rejects(loadApi(file(`bad.${format}`)), (error: unknown) => error instanceof ApiLoadError && error.source.pointer.endsWith('/responses'));
  }
  const spec = base('2.0.0'); const { file } = await fixture({ 'bad.json': JSON.stringify(spec) });
  await assert.rejects(loadApi(file('bad.json')), (error: unknown) => error instanceof ApiLoadError && error.code === 'UNSUPPORTED_VERSION');
});

test('dependentSchemas and contentSchema resolve nested $ref across files, while dependentRequired is passed through untouched', async () => {
  const spec = base('3.1.0');
  spec.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema = {
    type: 'object',
    dependentSchemas: { creditCard: { $ref: './extra.yaml#/CreditCard' } },
    properties: { payload: { type: 'string', contentSchema: { $ref: './extra.yaml#/Payload' } } },
    dependentRequired: { creditCard: ['billingAddress'] },
  } as never;
  const extra = { CreditCard: { type: 'object', properties: { number: { $ref: '#/Digits' } } }, Digits: { type: 'string', pattern: '^[0-9]+$' }, Payload: { type: 'object', properties: { id: { type: 'string' } } } };
  const { file } = await fixture({ 'api.json': JSON.stringify(spec), 'extra.yaml': YAML.stringify(extra) });
  const snap = await loadApi(file('api.json'));
  const schema = snap.operations[0]!.responses[0]!.content[0]!.schema as Record<string, any>;
  assert.deepEqual(schema.dependentSchemas.creditCard.properties.number, { type: 'string', pattern: '^[0-9]+$' });
  assert.deepEqual(schema.properties.payload.contentSchema, { type: 'object', properties: { id: { type: 'string' } } });
  assert.deepEqual(schema.dependentRequired, { creditCard: ['billingAddress'] });
  assert.equal(snap.references.filter(r => r.to.file.endsWith('extra.yaml')).length, 3);
});

test('boolean dependentSchemas and contentSchema members respect the 3.0/3.1 dialect difference', async () => {
  const modern = base('3.1.0');
  modern.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema = { type: 'object', dependentSchemas: { a: true }, properties: { p: { type: 'string', contentSchema: false } } } as never;
  const { file } = await fixture({ 'ok.json': JSON.stringify(modern) });
  const snap = await loadApi(file('ok.json'));
  const schema = snap.operations[0]!.responses[0]!.content[0]!.schema as Record<string, any>;
  assert.equal(schema.dependentSchemas.a, true);
  assert.equal(schema.properties.p.contentSchema, false);

  const legacy = base('3.0.3');
  legacy.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema = { type: 'object', dependentSchemas: { a: true } } as never;
  const { file: legacyFile } = await fixture({ 'bad.json': JSON.stringify(legacy) });
  await assert.rejects(loadApi(legacyFile('bad.json')), (error: unknown) => error instanceof ApiLoadError && error.code === 'INVALID_SCHEMA' && error.source.pointer.endsWith('/dependentSchemas/a'));
});

test('OpenAPI 3.1 documents without paths load when webhooks or components are present; 3.0 still requires paths', async () => {
  const onlyComponents = { openapi: '3.1.0', info: { title: 'Fixture', version: '1' }, components: { schemas: { Pet: { type: 'string' } } } };
  const { file: fileA } = await fixture({ 'components-only.json': JSON.stringify(onlyComponents) });
  const snapA = await loadApi(fileA('components-only.json'));
  validateDocument('ApiSnapshot', snapA);
  assert.deepEqual(snapA.operations, []);

  const onlyWebhooks = { openapi: '3.1.0', info: { title: 'Fixture', version: '1' }, webhooks: { petCreated: { post: { responses: { '200': { description: 'OK' } } } } } };
  const { file: fileB } = await fixture({ 'webhooks-only.json': JSON.stringify(onlyWebhooks) });
  const snapB = await loadApi(fileB('webhooks-only.json'));
  validateDocument('ApiSnapshot', snapB);
  assert.deepEqual(snapB.operations, []);
  assert.ok(snapB.diagnostics.some(item => item.code === 'WEBHOOKS_NOT_COMPARED'));

  const empty = { openapi: '3.1.0', info: { title: 'Fixture', version: '1' } };
  const { file: fileC } = await fixture({ 'empty.json': JSON.stringify(empty) });
  assert.deepEqual((await loadApi(fileC('empty.json'))).operations, []);

  const invalidWebhooks = { openapi: '3.1.0', info: { title: 'Fixture', version: '1' }, webhooks: 'nope' };
  const { file: fileD } = await fixture({ 'invalid-webhooks.json': JSON.stringify(invalidWebhooks) });
  await assert.rejects(loadApi(fileD('invalid-webhooks.json')), (error: unknown) => error instanceof ApiLoadError && error.code === 'INVALID_STRUCTURE' && error.source.pointer.endsWith('/webhooks'));

  const missingIn30 = { openapi: '3.0.3', info: { title: 'Fixture', version: '1' }, components: { schemas: { Pet: { type: 'string' } } } };
  const { file: fileE } = await fixture({ 'missing-30.json': JSON.stringify(missingIn30) });
  await assert.rejects(loadApi(fileE('missing-30.json')), (error: unknown) => error instanceof ApiLoadError && error.code === 'INVALID_STRUCTURE' && error.source.pointer.endsWith('/paths'));
});

test('rejects oversized and hostile YAML documents, depth and cancellation', async () => {
  const spec = base('3.1.0');
  const { file } = await fixture({ 'api.json': JSON.stringify(spec), 'alias.yaml': 'openapi: 3.1.0\ninfo: {title: x, version: "1"}\npaths: &p {}\ncopy: *p\n', 'tag.yaml': 'openapi: 3.1.0\ninfo: {title: x, version: "1"}\npaths: !!js/function >\n  process.exit(1)\n' });
  await assert.rejects(loadApi(file('api.json'), { limits: { maxFileBytes: 30 } }), (error: unknown) => error instanceof ApiLoadError && error.code === 'MAX_FILE_BYTES');
  await assert.rejects(loadApi(file('alias.yaml')), (error: unknown) => error instanceof ApiLoadError && error.code === 'INVALID_DOCUMENT');
  await assert.rejects(loadApi(file('tag.yaml')), (error: unknown) => error instanceof ApiLoadError && error.code === 'INVALID_YAML');
  await assert.rejects(loadApi(file('api.json'), { limits: { maxDepth: 2 } }), (error: unknown) => error instanceof ApiLoadError && error.code === 'MAX_DEPTH');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadApi(file('api.json'), { signal: controller.signal }), (error: unknown) => error instanceof ApiLoadError && error.code === 'ABORTED');
});
