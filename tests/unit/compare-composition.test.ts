import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadApi } from '../../src/openapi/index.js';
import { compareApis } from '../../src/compare/index.js';
import type { ApiChange } from '../../src/contracts/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name: string) => path.join(root, 'tests/fixtures/compare-composition', name);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function compareSpecs(oldSpec: object, newSpec: object, maxDepth?: number): Promise<ApiChange[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-composition-')); dirs.push(dir);
  await writeFile(path.join(dir, 'old.json'), JSON.stringify(oldSpec));
  await writeFile(path.join(dir, 'new.json'), JSON.stringify(newSpec));
  const options = maxDepth ? { limits: { maxDepth } } : {};
  return compareApis(await loadApi(path.join(dir, 'old.json'), options), await loadApi(path.join(dir, 'new.json'), options));
}
/** One POST whose request body and 200 response both use `schema`, so each change is seen in both directions. */
function api(schema: object, schemas: object = {}, version = '3.1.0') {
  const content = { 'application/json': { schema } };
  return { openapi: version, info: { title: 'C', version: '1' }, paths: { '/things': { post: { requestBody: { required: true, content }, responses: { '200': { description: 'OK', content } } } } }, components: { schemas } };
}
const summary = (changes: ApiChange[]) => changes.map(c => [c.direction, c.rule, c.classification, c.fieldPath ?? null]);

test('a change reachable only through a recursive reference is detected with its field path', async () => {
  const changes = compareApis(await loadApi(fixture('old.yaml')), await loadApi(fixture('new.yaml')));
  assert.deepEqual(summary(changes), [
    ['response', 'schema.type.changed', 'breaking', ['next', 'name']],
    ['request', 'schema.type.changed', 'breaking', ['next', 'name']],
  ]);
});

test('an unchanged recursive schema yields no change', async () => {
  const oldApi = await loadApi(fixture('old.yaml'));
  assert.deepEqual(compareApis(oldApi, await loadApi(fixture('old.yaml'))), []);
  const list = { Node: { type: 'object', properties: { name: { type: 'string' }, next: { $ref: '#/components/schemas/Node' } } } };
  assert.deepEqual(await compareSpecs(api({ $ref: '#/components/schemas/Node' }, list), api({ $ref: '#/components/schemas/Node' }, list)), []);
});

test('mutual recursion terminates and reports changes inside the cycle', async () => {
  const schemas = (type: string) => ({
    A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
    B: { type: 'object', properties: { value: { type }, a: { $ref: '#/components/schemas/A' } } },
  });
  const ref = { $ref: '#/components/schemas/A' };
  assert.deepEqual(await compareSpecs(api(ref, schemas('string')), api(ref, schemas('string'))), []);
  assert.deepEqual(summary(await compareSpecs(api(ref, schemas('string')), api(ref, schemas('integer')))), [
    ['request', 'schema.type.changed', 'breaking', ['b', 'value']],
    ['response', 'schema.type.changed', 'breaking', ['b', 'value']],
  ]);
});

test('recursive references that change target are compared structurally', async () => {
  // Old: list of Node; new: list whose tail is a different schema with a narrower type.
  const oldSchemas = { Node: { type: 'object', properties: { size: { type: 'number' }, next: { $ref: '#/components/schemas/Node' } } } };
  const newSchemas = { Node: { type: 'object', properties: { size: { type: 'number' }, next: { $ref: '#/components/schemas/Tail' } } }, Tail: { type: 'object', properties: { size: { type: 'integer' }, next: { $ref: '#/components/schemas/Tail' } } } };
  const ref = { $ref: '#/components/schemas/Node' };
  assert.deepEqual(summary(await compareSpecs(api(ref, oldSchemas), api(ref, newSchemas))), [
    ['request', 'schema.type.narrowed', 'breaking', ['next', 'size']],
    ['response', 'schema.type.narrowed', 'compatible', ['next', 'size']],
  ]);
});

test('object-like allOf branches are merged and compared with the normal rules', async () => {
  const schemas = { Base: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } };
  const schema = (extra: object) => ({ allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { note: { type: 'string' }, count: { type: 'number' } }, ...extra }] });
  assert.deepEqual(await compareSpecs(api(schema({}), schemas), api(schema({}), schemas)), []);
  assert.deepEqual(summary(await compareSpecs(api(schema({}), schemas), api(schema({ required: ['note'] }), schemas))), [
    ['request', 'schema.required.added', 'breaking', ['note']],
    ['response', 'schema.required.added', 'compatible', ['note']],
  ]);
  const narrowed = { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { note: { type: 'string' }, count: { type: 'integer' } } }] };
  assert.deepEqual(summary(await compareSpecs(api(schema({}), schemas), api(narrowed, schemas))), [
    ['request', 'schema.type.narrowed', 'breaking', ['count']],
    ['response', 'schema.type.narrowed', 'compatible', ['count']],
  ]);
});

test('allOf that cannot be merged exactly stays ambiguous', async () => {
  // Same property defined with different schemas in two branches.
  const conflicting = (type: string) => ({ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type }, b: { type: 'string' } } }] });
  assert.deepEqual(summary(await compareSpecs(api(conflicting('string', )), api(conflicting('integer')))).map(c => c.slice(0, 3)), [
    ['request', 'schema.composition.changed', 'ambiguous'],
    ['response', 'schema.composition.changed', 'ambiguous'],
  ]);
  // A closed branch would reject properties only another branch declares: not a plain union.
  const closed = (type: string) => ({ allOf: [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type } } }] });
  assert.deepEqual(summary(await compareSpecs(api(closed('string')), api(closed('integer')))).map(c => c.slice(0, 3)), [
    ['request', 'schema.composition.changed', 'ambiguous'],
    ['response', 'schema.composition.changed', 'ambiguous'],
  ]);
});

test('anyOf branch addition and removal are classified by direction', async () => {
  const two = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  const three = { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }] };
  assert.deepEqual(summary(await compareSpecs(api(two), api(three))), [
    ['request', 'schema.any-of.branch-added', 'compatible', null],
    ['response', 'schema.any-of.branch-added', 'breaking', null],
  ]);
  assert.deepEqual(summary(await compareSpecs(api(three), api(two))), [
    ['request', 'schema.any-of.branch-removed', 'breaking', null],
    ['response', 'schema.any-of.branch-removed', 'compatible', null],
  ]);
  // Adding and removing at once is neither: ambiguous.
  const replaced = { anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'null' }] };
  assert.deepEqual(summary(await compareSpecs(api(two), api(replaced))).map(c => c.slice(1, 3)), [['schema.composition.changed', 'ambiguous'], ['schema.composition.changed', 'ambiguous']]);
});

test('anyOf branches with the same shape are compared pairwise; breaks inside one branch are not provable', async () => {
  const schema = (max: number) => ({ anyOf: [{ type: 'string', maxLength: max }, { type: 'integer' }] });
  assert.deepEqual(summary(await compareSpecs(api(schema(10)), api(schema(5)))), [
    ['request', 'schema.length.narrowed', 'ambiguous', null],
    ['response', 'schema.length.narrowed', 'compatible', null],
  ]);
  // A branch replaced in place is a disjoint change of that branch, which another branch might still cover.
  const swapped = { anyOf: [{ type: 'string', maxLength: 10 }, { type: 'boolean' }] };
  assert.deepEqual(summary(await compareSpecs(api(schema(10)), api(swapped))).map(c => c.slice(1, 3)), [['schema.type.changed', 'ambiguous'], ['schema.type.changed', 'ambiguous']]);
  assert.deepEqual(summary(await compareSpecs(api(schema(5)), api(schema(10)))), [
    ['request', 'schema.length.widened', 'compatible', null],
    ['response', 'schema.length.widened', 'ambiguous', null],
  ]);
});

test('oneOf branch addition stays ambiguous', async () => {
  const two = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
  const three = { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'number' }] };
  assert.deepEqual(summary(await compareSpecs(api(two), api(three))).map(c => c.slice(0, 3)), [
    ['request', 'schema.composition.changed', 'ambiguous'],
    ['response', 'schema.composition.changed', 'ambiguous'],
  ]);
});

test('depth limit is still reported as ambiguous', async () => {
  const nest = (leaf: object) => { let schema: object = leaf; for (let i = 0; i < 70; i++) schema = { type: 'object', properties: { x: schema } }; return schema; };
  const changes = await compareSpecs(api(nest({ type: 'string' })), api(nest({ type: 'integer' })), 1000);
  assert.deepEqual(changes.map(c => [c.rule, c.classification]), [['schema.depth-limit', 'ambiguous'], ['schema.depth-limit', 'ambiguous']]);
});

test('a recursive reference that cannot be resolved is ambiguous even when its text is unchanged', async () => {
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'x-apipatch-recursion-anchor').map(([key, item]) => [key, strip(item)])) : value;
  const oldApi = strip(await loadApi(fixture('old.yaml'))) as Parameters<typeof compareApis>[0];
  const changes = compareApis(oldApi, strip(await loadApi(fixture('old.yaml'))) as Parameters<typeof compareApis>[1]);
  assert.deepEqual(summary(changes), [
    ['response', 'schema.recursion.unresolved', 'ambiguous', ['next']],
    ['request', 'schema.recursion.unresolved', 'ambiguous', ['next']],
  ]);
});

test('3.1 siblings of a recursive reference are kept instead of silently dropped', async () => {
  const schemas = (max: number) => ({ Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node', maxProperties: max } } } });
  const ref = { $ref: '#/components/schemas/Node' };
  assert.deepEqual(summary(await compareSpecs(api(ref, schemas(3)), api(ref, schemas(2)))), [
    ['request', 'schema.composition.changed', 'ambiguous', ['next']],
    ['response', 'schema.composition.changed', 'ambiguous', ['next']],
  ]);
});
