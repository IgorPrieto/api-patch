import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION, validateDocument, type ApiChange, type ApiOperation, type ApiSnapshot } from '../../src/contracts/index.js';
import { scanRepository } from '../../src/scan/index.js';

const FIXTURE = path.resolve('tests/fixtures/scan-wrappers');

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repository(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-scan-wrap-')); roots.push(root); return root; }

function operation(id: string, pathName: string, method: ApiOperation['method'], servers: string[]): ApiOperation {
  return { id, method, path: pathName, servers, parameters: [], responses: [], security: [], source: { file: 'api.yaml', pointer: `/paths/${pathName}` } };
}
function snapshot(operations: ApiOperation[]): ApiSnapshot {
  return { schemaVersion: SCHEMA_VERSION, id: 'api', openapi: '3.1.0', digest: 'digest', documents: [], operations, references: [], diagnostics: [] };
}
function breaking(operationId: string, method: ApiOperation['method'] = 'get'): ApiChange {
  return { id: `change-${operationId}`, operationId, method, path: '/', location: 'response', rule: 'removed', direction: 'response', classification: 'breaking', explanation: 'field removed', evidence: [] };
}

describe('wrapper scope: one-hop import, require, default export, axios.create instance, chains', () => {
  it('resolves named import, default import, require, and an imported axios.create instance; rejects a two-hop chain and a re-export', async () => {
    const root = await repository();
    await cp(FIXTURE, root, { recursive: true });
    const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
    const v1User = operation('v1User', '/users/{id}', 'get', ['https://api.example.test/v1']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users, v1User]), newApi: snapshot([users, v1User]), changes: [], baseUrl: 'https://api.example.test' });
    validateDocument('ScanResult', result);

    const byFile = (file: string) => result.uses.filter(use => use.file === file);

    const named = byFile('consumer-named.ts');
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ operationIds: ['users'], resolution: 'resolved', confidence: 'medium' });
    expect(named[0]?.via).toMatchObject({ name: 'getUser', file: 'wrappers.ts' });

    const def = byFile('consumer-default.ts');
    expect(def).toHaveLength(1);
    expect(def[0]).toMatchObject({ operationIds: ['users'], resolution: 'resolved', confidence: 'medium' });
    expect(def[0]?.via).toMatchObject({ name: 'getUserDefault', file: 'wrappers.ts' });

    const req = byFile('consumer-require.cjs');
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ operationIds: ['users'], resolution: 'resolved', confidence: 'medium' });
    expect(req[0]?.via).toMatchObject({ name: 'getUser', file: 'wrappers.ts' });

    const instance = byFile('consumer-instance.ts');
    expect(instance).toHaveLength(1);
    expect(instance[0]).toMatchObject({ client: 'axios', operationIds: ['v1User'], resolution: 'resolved', confidence: 'medium' });
    expect(instance[0]?.via).toMatchObject({ name: 'api', file: 'http.ts' });

    // Two-hop chain: hop-b re-forwards another wrapper's call, so it is not itself a recognized wrapper.
    expect(byFile('hop-consumer.ts')).toHaveLength(0);
    // Re-export is not a wrapper declaration in its own file.
    expect(byFile('reexport-consumer.ts')).toHaveLength(0);

    for (const use of result.uses) if (use.via) expect(['medium', 'low']).toContain(use.confidence);
  });

  it('rejects a wrapper imported from a package specifier', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `import { getUser } from 'some-package';\ngetUser('1');\n`);
    const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [] });
    expect(result.uses).toHaveLength(0);
  });

  it('rejects a wrapper declared in an excluded file', async () => {
    const root = await repository();
    await mkdir(path.join(root, 'excluded'));
    await writeFile(path.join(root, 'excluded', 'wrappers.ts'), `export function getUser(id) {\n  return fetch(\`/users/\${id}\`);\n}\n`);
    await writeFile(path.join(root, 'consumer.ts'), `import { getUser } from './excluded/wrappers.js';\ngetUser('1');\n`);
    const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [], excludes: ['excluded'] });
    expect(result.uses).toHaveLength(0);
  });

  it('rejects a wrapper reached through a symlinked file', async () => {
    const root = await repository();
    const outside = await repository();
    await writeFile(path.join(outside, 'realwrapper.ts'), `export function getUser(id) {\n  return fetch(\`/users/\${id}\`);\n}\n`);
    await symlink(path.join(outside, 'realwrapper.ts'), path.join(root, 'wrapper.ts'));
    await writeFile(path.join(root, 'consumer.ts'), `import { getUser } from './wrapper.js';\ngetUser('1');\n`);
    const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [] });
    expect(result.uses).toHaveLength(0);
    expect(result.diagnostics.map(d => d.code)).toContain('SCAN_SYMLINK_SKIPPED');
  });
});

describe('wrapper recognition: same-file shapes, URL joining, method resolution, bindings', () => {
  it('resolves a same-file function wrapper with a template URL and default GET', async () => {
    const root = await repository();
    const source = `function getUser(id) {\n  return fetch(\`/users/\${id}\`);\n}\ngetUser('1');\n`;
    await writeFile(path.join(root, 'consumer.ts'), source);
    const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [], baseUrl: 'https://api.example.test' });
    validateDocument('ScanResult', result);
    expect(result.uses).toHaveLength(2); // the internal fetch call, and the call site
    const callSite = result.uses.find(use => use.via);
    expect(callSite).toMatchObject({ method: 'get', operationIds: ['users'], resolution: 'resolved', confidence: 'medium' });
    expect(callSite?.via).toMatchObject({ name: 'getUser' });
    expect(callSite?.range.start).toBe(source.indexOf("getUser('1')"));
    const internal = result.uses.find(use => !use.via);
    expect(internal).toMatchObject({ resolution: 'unresolved', operationIds: [] });
  });

  it('resolves an arrow wrapper with a `+` joined base and a literal wrapper method', async () => {
    const root = await repository();
    const source = `const BASE = '/v1';\nconst createUser = (id) => fetch(BASE + '/users/' + id, { method: 'POST' });\ncreateUser('9');\n`;
    await writeFile(path.join(root, 'consumer.ts'), source);
    const posted = operation('createUser', '/v1/users/{id}', 'post', ['/']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([posted]), newApi: snapshot([posted]), changes: [] });
    validateDocument('ScanResult', result);
    const callSite = result.uses.find(use => use.via);
    expect(callSite).toMatchObject({ method: 'post', operationIds: ['createUser'], resolution: 'resolved', confidence: 'medium', url: '/v1/users/9' });
  });

  it('resolves the HTTP method from an inline literal passed at the call site through a forwarded config parameter', async () => {
    const root = await repository();
    const source = `function request(url, options) {\n  return fetch(url, options);\n}\nrequest('/users/1', { method: 'DELETE' });\n`;
    await writeFile(path.join(root, 'consumer.ts'), source);
    const deleteUser = operation('deleteUser', '/users/{id}', 'delete', ['/']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([deleteUser]), newApi: snapshot([deleteUser]), changes: [] });
    validateDocument('ScanResult', result);
    const callSite = result.uses.find(use => use.via);
    expect(callSite).toMatchObject({ method: 'delete', operationIds: ['deleteUser'], resolution: 'resolved', confidence: 'medium' });
  });

  it('emits request-property bindings at the call site for a body parameter the wrapper forwards (JSON.stringify unwrapped)', async () => {
    const root = await repository();
    const source = `function createUser(url, body) {\n  return fetch(url, { method: 'POST', body: JSON.stringify(body) });\n}\ncreateUser('/users', { name: 'Ann' });\n`;
    await writeFile(path.join(root, 'consumer.ts'), source);
    const createUser = operation('createUser', '/users', 'post', ['/']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([createUser]), newApi: snapshot([createUser]), changes: [] });
    validateDocument('ScanResult', result);
    const callSite = result.uses.find(use => use.via);
    expect(callSite).toMatchObject({ method: 'post', operationIds: ['createUser'], resolution: 'resolved', confidence: 'medium' });
    const binding = callSite?.bindings.find(b => b.kind === 'request-property' && b.name === 'name');
    expect(binding).toMatchObject({ value: 'Ann' });
    // The binding points at the call site's own object literal, not inside the wrapper body.
    expect(binding?.range.start).toBe(source.indexOf("{ name: 'Ann' }") + 2);
  });

  it('keeps a wrapper that transforms the URL unresolved, with no via use for the call site', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `function getUser(id) {\n  return fetch('/users/' + id.toUpperCase());\n}\ngetUser('1');\n`);
    const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [] });
    expect(result.uses.every(use => !use.via)).toBe(true);
    expect(result.uses).toHaveLength(1); // only the internal fetch call; `getUser(...)` itself is not a client call
    expect(result.uses[0]).toMatchObject({ resolution: 'unresolved', operationIds: [] });
  });

  it('does not double count a finding between the wrapper-body call and the resolved call site', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `function getUser(id) {\n  return fetch(\`/users/\${id}\`);\n}\ngetUser('1');\n`);
    const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [breaking('users')], baseUrl: 'https://api.example.test' });
    const callSite = result.uses.find(use => use.via)!;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ useId: callSite.id, changeId: 'change-users' });
  });
});

describe('wrapper-body suppression requires every caller to be provably covered', () => {
  const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);
  const WRAPPER = `function getUser(id) {\n  return fetch(\`/users/\${id}\`);\n}\n`;
  const EXPORTED_WRAPPER = `export function getUser(id) {\n  return fetch(\`/users/\${id}\`);\n}\n`;

  it('(a) suppresses the inner use for a module-local wrapper whose only caller resolved', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `${WRAPPER}getUser('1');\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [breaking('users')], baseUrl: 'https://api.example.test' });
    validateDocument('ScanResult', result);
    const inner = result.uses.find(use => !use.via)!;
    expect(inner).toMatchObject({ resolution: 'unresolved', confidence: 'low', operationIds: [] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.useId).not.toBe(inner.id);
  });

  it('(b) keeps the inner use findings for an exported wrapper whose only caller is a one-hop importer, in addition to the call site', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'wrapper.ts'), EXPORTED_WRAPPER);
    await writeFile(path.join(root, 'consumer.ts'), `import { getUser } from './wrapper.js';\ngetUser('1');\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [breaking('users')], baseUrl: 'https://api.example.test' });
    validateDocument('ScanResult', result);
    const callSite = result.uses.find(use => use.via)!;
    const inner = result.uses.find(use => !use.via && use.file === 'wrapper.ts')!;
    expect(callSite).toMatchObject({ resolution: 'resolved', operationIds: ['users'] });
    expect(inner).toMatchObject({ resolution: 'partial', operationIds: ['users'] });
    expect(result.findings.map(f => f.useId).sort()).toEqual([callSite.id, inner.id].sort());
  });

  it('(c) keeps the inner use findings for an exported wrapper with no scanned callers', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'wrapper.ts'), EXPORTED_WRAPPER);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [breaking('users')], baseUrl: 'https://api.example.test' });
    validateDocument('ScanResult', result);
    expect(result.uses).toHaveLength(1);
    expect(result.uses[0]).toMatchObject({ resolution: 'partial', operationIds: ['users'] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.useId).toBe(result.uses[0]?.id);
  });

  it('(d) keeps the inner use findings for a module-local wrapper also referenced as a value', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `${WRAPPER}const handlers = [];\nhandlers.push(getUser);\ngetUser('1');\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [breaking('users')], baseUrl: 'https://api.example.test' });
    validateDocument('ScanResult', result);
    const callSite = result.uses.find(use => use.via)!;
    const inner = result.uses.find(use => !use.via)!;
    expect(inner).toMatchObject({ resolution: 'partial', operationIds: ['users'] });
    expect(result.findings.map(f => f.useId).sort()).toEqual([callSite.id, inner.id].sort());
  });

  it('(e) an unsuppressed wrapper-body call matches the same shape scanned as a plain (non-wrapper) function', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'wrapper.ts'), EXPORTED_WRAPPER); // exported -> never suppressed
    const wrapped = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [], baseUrl: 'https://api.example.test' });

    const plainRoot = await repository();
    // Two statements instead of one: not a recognized wrapper shape, so this is handled as an
    // ordinary direct call with no wrapper machinery involved at all - the pre-S2 baseline.
    await writeFile(path.join(plainRoot, 'wrapper.ts'), `export function getUser(id) {\n  const response = fetch(\`/users/\${id}\`);\n  return response;\n}\n`);
    const plain = await scanRepository({ repository: plainRoot, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [], baseUrl: 'https://api.example.test' });

    expect(wrapped.uses).toHaveLength(1);
    expect(plain.uses).toHaveLength(1);
    const shape = (use: typeof wrapped.uses[number]) => ({ client: use.client, method: use.method, resolution: use.resolution, confidence: use.confidence, operationIds: use.operationIds, url: use.url });
    expect(shape(wrapped.uses[0]!)).toEqual(shape(plain.uses[0]!));
    expect(wrapped.uses[0]?.via).toBeUndefined(); // the wrapper's own body is never itself a call site
  });
});

describe('never-reassigned let resolution', () => {
  const u = `'https://api.example.test/users/1'`;
  const users = operation('users', '/users/{id}', 'get', ['https://api.example.test']);

  it('resolves a module-local let that is never reassigned, incremented, or exported', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `let method = 'DELETE';\nfetch(${u}, {method});\n`);
    const deleteUser = operation('deleteUser', '/users/{id}', 'delete', ['https://api.example.test']);
    const result = await scanRepository({ repository: root, oldApi: snapshot([deleteUser]), newApi: snapshot([deleteUser]), changes: [] });
    expect(result.uses[0]).toMatchObject({ method: 'delete', operationIds: ['deleteUser'], resolution: 'resolved', confidence: 'high' });
  });

  it.each([
    ['reassigned inside a nested closure', `let method = 'DELETE';\nfunction reset() { method = 'GET'; }\nfetch(${u}, {method});\n`],
    ['compound assignment', `let method = 'DELETE';\nmethod += '';\nfetch(${u}, {method});\n`],
    ['destructuring assignment target', `let method = 'DELETE';\nlet other = 'x';\n[method, other] = ['GET', 'y'];\nfetch(${u}, {method});\n`],
    ['exported let', `export let method = 'DELETE';\nfetch(${u}, {method});\n`],
  ])('keeps %s unresolved', async (_label, source) => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), source);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [] });
    expect(result.uses[0]).toMatchObject({ resolution: 'unresolved' });
    expect(result.uses[0]?.method).toBeUndefined();
  });

  it('keeps an incremented let in a template path dynamic', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `let id = 1;\nid++;\nfetch(\`/users/\${id}\`);\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [] });
    expect(result.uses[0]).toMatchObject({ resolution: 'partial' });
    expect(result.uses[0]?.bindings.some(b => b.kind === 'url' && b.name === 'id')).toBe(true);
  });

  it('keeps a for-of loop target unresolved', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `let key = 'a';\nfor (key of ['b', 'c']) {\n  fetch(\`/users/\${key}\`);\n}\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [] });
    expect(result.uses[0]).toMatchObject({ resolution: 'partial' });
    expect(result.uses[0]?.bindings.some(b => b.kind === 'url' && b.name === 'key')).toBe(true);
  });
});
