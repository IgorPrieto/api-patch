import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { loadApi, ApiLoadError } from '../../src/openapi/index.js';
import { validateDocument } from '../../src/contracts/index.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function tempDir(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), 'openapi-hardening-')); dirs.push(dir); return dir; }
function spec(version: string, schema: unknown = { type: 'object' }): Record<string, any> {
  return { openapi: version, info: { title: 'Fixture', version: '1' }, paths: { '/a': { get: { responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } } } } } };
}
function responseSchema(snapshot: Awaited<ReturnType<typeof loadApi>>, index = 0): any {
  return snapshot.operations[index]!.responses[0]!.content[0]!.schema;
}
function rejectsWith(code: string) {
  return (error: unknown) => error instanceof ApiLoadError && error.code === code;
}

test('OpenAPI 3.0 accepts boolean additionalProperties in JSON and YAML but rejects other boolean schemas', async () => {
  const dir = await tempDir();
  for (const value of [true, false]) {
    const document = spec('3.0.3', { type: 'object', properties: { tags: { type: 'object', additionalProperties: value } }, additionalProperties: value });
    await writeFile(path.join(dir, 'api.json'), JSON.stringify(document));
    await writeFile(path.join(dir, 'api.yaml'), YAML.stringify(document));
    for (const name of ['api.json', 'api.yaml']) {
      const snapshot = await loadApi(path.join(dir, name));
      validateDocument('ApiSnapshot', snapshot);
      assert.equal(responseSchema(snapshot).additionalProperties, value);
      assert.equal(responseSchema(snapshot).properties.tags.additionalProperties, value);
    }
  }
  await writeFile(path.join(dir, 'items.json'), JSON.stringify(spec('3.0.3', { type: 'array', items: true })));
  await assert.rejects(loadApi(path.join(dir, 'items.json')), (error: unknown) => rejectsWith('INVALID_SCHEMA')(error) && (error as ApiLoadError).source.pointer.endsWith('/items'));
});

test('a broken or path-escaping $ref inside dependentSchemas or contentSchema is rejected like any other schema ref', async () => {
  const dir = await tempDir();
  const broken = spec('3.1.0', { type: 'object', dependentSchemas: { a: { $ref: '#/components/schemas/Missing' } } });
  await writeFile(path.join(dir, 'broken.json'), JSON.stringify(broken));
  await assert.rejects(loadApi(path.join(dir, 'broken.json')), (error: unknown) => rejectsWith('BROKEN_REF')(error) && (error as ApiLoadError).source.pointer.endsWith('/dependentSchemas/a/$ref'));

  const escaping = spec('3.1.0', { type: 'string', contentSchema: { $ref: '../../etc/passwd#' } });
  await writeFile(path.join(dir, 'escape.json'), JSON.stringify(escaping));
  await assert.rejects(loadApi(path.join(dir, 'escape.json')), (error: unknown) => rejectsWith('REF_OUTSIDE_ROOT')(error) && (error as ApiLoadError).source.pointer.endsWith('/contentSchema/$ref'));
});

test('a small document whose shared references expand exponentially fails fast with MAX_EXPANSION', async () => {
  const dir = await tempDir();
  const levels = 24, schemas: Record<string, unknown> = {};
  for (let i = 0; i < levels; i++) schemas[`S${i}`] = { type: 'object', properties: { left: { $ref: `#/components/schemas/S${i + 1}` }, right: { $ref: `#/components/schemas/S${i + 1}` } } };
  schemas[`S${levels}`] = { type: 'string' };
  const document = { ...spec('3.1.0', { $ref: '#/components/schemas/S0' }), components: { schemas } };
  const text = JSON.stringify(document);
  assert.ok(text.length < 5_000);
  await writeFile(path.join(dir, 'bomb.json'), text);
  const started = Date.now();
  await assert.rejects(loadApi(path.join(dir, 'bomb.json')), rejectsWith('MAX_EXPANSION'));
  assert.ok(Date.now() - started < 15_000, `expansion limit took ${Date.now() - started} ms`);
});

test('the expansion budget also bounds fan-out reached through dependentSchemas and contentSchema', async () => {
  const dir = await tempDir();
  const levels = 24, schemas: Record<string, unknown> = {};
  for (let i = 0; i < levels; i++) schemas[`S${i}`] = { type: 'object', dependentSchemas: { left: { $ref: `#/components/schemas/S${i + 1}` }, right: { $ref: `#/components/schemas/S${i + 1}` } } };
  schemas[`S${levels}`] = { type: 'string' };
  const document = { ...spec('3.1.0', { $ref: '#/components/schemas/S0' }), components: { schemas } };
  const text = JSON.stringify(document);
  assert.ok(text.length < 5_000);
  await writeFile(path.join(dir, 'bomb.json'), text);
  await assert.rejects(loadApi(path.join(dir, 'bomb.json')), rejectsWith('MAX_EXPANSION'));
});

test('legitimate reuse of a shared schema across many operations still loads within the expansion budget', async () => {
  const dir = await tempDir();
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 200; i++) paths[`/items/${i}`] = { get: { responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } } };
  const properties = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, { $ref: '#/components/schemas/Tag' }]));
  const document = { openapi: '3.1.0', info: { title: 'Reuse', version: '1' }, paths, components: { schemas: { Item: { type: 'object', properties }, Tag: { type: 'string' } } } };
  await writeFile(path.join(dir, 'reuse.json'), JSON.stringify(document));
  const snapshot = await loadApi(path.join(dir, 'reuse.json'));
  assert.equal(snapshot.operations.length, 200);
  assert.deepEqual(responseSchema(snapshot).properties.field19, { type: 'string' });
});

test.skipIf(process.platform === 'win32')('FIFO references and FIFO inputs are rejected without blocking', async () => {
  const dir = await tempDir();
  execFileSync('mkfifo', [path.join(dir, 'pipe.json')]);
  await writeFile(path.join(dir, 'api.json'), JSON.stringify(spec('3.1.0', { $ref: './pipe.json#' })));
  const started = Date.now();
  await assert.rejects(loadApi(path.join(dir, 'api.json'), { limits: { timeoutMs: 2_000 } }), (error: unknown) => rejectsWith('INVALID_FILE')(error) && (error as ApiLoadError).source.pointer.endsWith('$ref'));
  await assert.rejects(loadApi(path.join(dir, 'pipe.json')), rejectsWith('INVALID_FILE'));
  assert.ok(Date.now() - started < 2_000);
});

test('Path Item $ref siblings are merged with source locations, and conflicting fields are explicit errors', async () => {
  const dir = await tempDir();
  const shared = { get: { operationId: 'listB', responses: { '200': { description: 'OK' } } }, parameters: [{ name: 'tenant', in: 'header', required: true, schema: { type: 'string' } }], summary: 'shared' };
  await writeFile(path.join(dir, 'paths.yaml'), YAML.stringify({ B: shared }));
  const document = spec('3.1.0');
  document.paths['/b'] = { $ref: './paths.yaml#/B', summary: 'local', post: { operationId: 'createB', responses: { '201': { description: 'Created' } } } };
  await writeFile(path.join(dir, 'api.json'), JSON.stringify(document));
  const snapshot = await loadApi(path.join(dir, 'api.json'));
  const operations = snapshot.operations.filter(operation => operation.path === '/b');
  assert.deepEqual(operations.map(operation => `${operation.method}:${operation.operationId}`), ['get:listB', 'post:createB']);
  assert.ok(operations[0]!.source.file.endsWith('paths.yaml') && operations[0]!.source.pointer === '/B/get');
  assert.ok(operations[1]!.source.file.endsWith('api.json') && operations[1]!.source.pointer === '/paths/~1b/post');
  for (const operation of operations) assert.deepEqual(operation.parameters.map(parameter => parameter.name), ['tenant']);
  assert.ok(snapshot.diagnostics.some(item => item.code === 'PATH_ITEM_REF_SIBLINGS'));
  assert.ok(snapshot.diagnostics.some(item => item.code === 'PATH_ITEM_REF_OVERRIDE'));

  document.paths['/b'] = { $ref: './paths.yaml#/B', get: { responses: { '204': { description: 'Local' } } } };
  await writeFile(path.join(dir, 'api.json'), JSON.stringify(document));
  await assert.rejects(loadApi(path.join(dir, 'api.json')), (error: unknown) => rejectsWith('PATH_ITEM_REF_CONFLICT')(error) && (error as ApiLoadError).source.pointer === '/paths/~1b/get');

  document.paths['/b'] = { $ref: '#/paths/~1c' };
  document.paths['/c'] = { $ref: '#/paths/~1b' };
  await writeFile(path.join(dir, 'api.json'), JSON.stringify(document));
  await assert.rejects(loadApi(path.join(dir, 'api.json')), rejectsWith('CYCLIC_REF'));
});

test('ignored Reference Object siblings are reported instead of silently dropped', async () => {
  const dir = await tempDir();
  const document = { ...spec('3.0.3'), components: { requestBodies: { Body: { content: { 'application/json': { schema: { type: 'object' } } } } } } };
  document.paths['/a'].post = { requestBody: { $ref: '#/components/requestBodies/Body', required: true }, responses: { '204': { description: 'No content' } } };
  await writeFile(path.join(dir, 'api.json'), JSON.stringify(document));
  const snapshot = await loadApi(path.join(dir, 'api.json'));
  assert.equal(snapshot.operations.find(operation => operation.method === 'post')!.requestBody!.required, false);
  assert.ok(snapshot.diagnostics.some(item => item.code === 'IGNORED_REF_SIBLINGS' && item.source?.pointer === '/paths/~1a/post/requestBody'));
});

test('schema properties named __proto__ and constructor are preserved as own data in JSON and YAML', async () => {
  const dir = await tempDir();
  const schemaJson = '{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"},"name":{"type":"string"}}}';
  await writeFile(path.join(dir, 'api.json'), JSON.stringify(spec('3.1.0')).replace('{"type":"object"}', schemaJson));
  await writeFile(path.join(dir, 'api.yaml'), 'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: OK\n          content:\n            application/json:\n              schema:\n                type: object\n                required: [__proto__]\n                properties:\n                  __proto__: {type: string}\n                  constructor: {type: integer}\n                  name: {type: string}\n');
  for (const name of ['api.json', 'api.yaml']) {
    const snapshot = await loadApi(path.join(dir, name));
    const properties = responseSchema(snapshot).properties;
    assert.deepEqual(Object.keys(properties), ['__proto__', 'constructor', 'name']);
    assert.equal(Object.getPrototypeOf(properties), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(properties, '__proto__')?.value, { type: 'string' });
    assert.ok(JSON.stringify(snapshot).includes('"__proto__":{"type":"string"}'));
    validateDocument('ApiSnapshot', snapshot);
  }
  assert.equal(({} as Record<string, unknown>).type, undefined);
});

test.skipIf(process.platform === 'win32')('main input through a symlinked directory loads; a symlinked input escaping its root does not', async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, 'real'));
  await mkdir(path.join(dir, 'outside'));
  await writeFile(path.join(dir, 'real', 'api.json'), JSON.stringify(spec('3.1.0', { $ref: './schema.json#' })));
  await writeFile(path.join(dir, 'real', 'schema.json'), JSON.stringify({ type: 'string' }));
  await symlink(path.join(dir, 'real'), path.join(dir, 'link'));
  const snapshot = await loadApi(path.join(dir, 'link', 'api.json'));
  assert.deepEqual(responseSchema(snapshot), { type: 'string' });
  assert.ok((await loadApi(path.join(dir, 'link', 'api.json'), { allowedRoot: path.join(dir, 'real') })).operations.length === 1);

  await writeFile(path.join(dir, 'outside', 'api.json'), JSON.stringify(spec('3.1.0')));
  await symlink(path.join(dir, 'outside', 'api.json'), path.join(dir, 'real', 'escape.json'));
  await assert.rejects(loadApi(path.join(dir, 'real', 'escape.json')), rejectsWith('REF_OUTSIDE_ROOT'));
  await assert.rejects(loadApi(path.join(dir, 'real', 'missing.json')), rejectsWith('FILE_NOT_FOUND'));
});

test('specification extensions are ignored in Paths and Responses objects', async () => {
  const dir = await tempDir();
  const document = spec('3.0.3');
  document.paths['x-internal'] = { owner: 'team' };
  document.paths['/a'].get.responses['x-note'] = 'documented elsewhere';
  await writeFile(path.join(dir, 'api.yaml'), YAML.stringify(document));
  const snapshot = await loadApi(path.join(dir, 'api.yaml'));
  assert.deepEqual(snapshot.operations.map(operation => operation.path), ['/a']);
  assert.deepEqual(snapshot.operations[0]!.responses.map(response => response.status), ['200']);

  document.paths['/a'].get.responses = { 'x-only': true };
  await writeFile(path.join(dir, 'api.yaml'), YAML.stringify(document));
  await assert.rejects(loadApi(path.join(dir, 'api.yaml')), (error: unknown) => rejectsWith('INVALID_STRUCTURE')(error) && (error as ApiLoadError).source.pointer.endsWith('/responses'));
});
