import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION, type ApiChange, type ApiOperation, type ApiSnapshot, type ScanOptions } from '../../src/contracts/index.js';
import { scanRepository } from '../../src/scan/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function operation(id: string, pathName: string, method: ApiOperation['method'], servers: string[]): ApiOperation {
  return { id, method, path: pathName, servers, parameters: [], responses: [], security: [], source: { file: 'api.yaml', pointer: `/paths/${pathName}` } };
}
function snapshot(operations: ApiOperation[]): ApiSnapshot {
  return { schemaVersion: SCHEMA_VERSION, id: 'api', openapi: '3.1.0', digest: 'digest', documents: [], operations, references: [], diagnostics: [] };
}
function breaking(operationId: string): ApiChange {
  return { id: `change-${operationId}`, operationId, method: 'get', path: '/', location: 'response', rule: 'removed', direction: 'response', classification: 'breaking', explanation: 'field removed', evidence: [] };
}
async function scan(source: string, operations: ApiOperation[], extra: Partial<ScanOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-scan-match-'));
  roots.push(root);
  await writeFile(path.join(root, 'consumer.ts'), source);
  return scanRepository({ repository: root, oldApi: snapshot(operations), newApi: snapshot(operations), changes: operations.map(op => breaking(op.id)), ...extra });
}

describe('scan origin matching for servers without origin', () => {
  const relative = operation('getUser', '/users/{id}', 'get', ['/']);
  const absent = operation('getUser', '/users/{id}', 'get', []);

  it.each([['relative server', relative], ['absent servers', absent]])('never gives high confidence to an unrelated absolute origin (%s)', async (_label, op) => {
    const result = await scan(`fetch('https://api.github.com/users/octocat');\nfetch('/users/1');\n`, [op]);
    expect(result.uses[0]).toMatchObject({ origin: 'https://api.github.com', operationIds: ['getUser'], resolution: 'partial', confidence: 'low' });
    expect(result.uses[0]?.reason).toContain('not confirmed');
    expect(result.uses[1]).toMatchObject({ operationIds: ['getUser'], resolution: 'resolved', confidence: 'high' });
    const third = result.findings.find(finding => finding.useId === result.uses[0]?.id);
    expect(third?.confidence).toBe('low');
  });

  it.each([['relative server', relative], ['absent servers', absent]])('compares the call origin with --base-url (%s)', async (_label, op) => {
    const result = await scan(`fetch('https://api.github.com/users/octocat');\nfetch('https://api.example.test/users/1');\n`, [op], { baseUrl: 'https://api.example.test' });
    expect(result.uses[0]).toMatchObject({ operationIds: [], resolution: 'partial' });
    expect(result.uses[1]).toMatchObject({ operationIds: ['getUser'], resolution: 'resolved', confidence: 'high' });
    expect(result.findings.map(finding => finding.useId)).toEqual([result.uses[1]?.id]);
  });

  it('resolves a relative server path against --base-url', async () => {
    const op = operation('getUser', '/users/{id}', 'get', ['/v1']);
    const result = await scan(`fetch('https://api.example.test/v1/users/1');\nfetch('https://evil.test/v1/users/1');\n`, [op], { baseUrl: 'https://api.example.test' });
    expect(result.uses.map(use => use.operationIds)).toEqual([['getUser'], []]);
    expect(result.uses[0]?.resolution).toBe('resolved');
  });

  it('prefers an origin-confirmed server over a relative one for the same operation', async () => {
    const op = operation('getUser', '/users/{id}', 'get', ['/', 'https://api.example.test']);
    const result = await scan(`fetch('https://api.example.test/users/1');\n`, [op]);
    expect(result.uses[0]).toMatchObject({ operationIds: ['getUser'], resolution: 'resolved', confidence: 'high' });
  });
});

describe('scan method and URL properties', () => {
  const server = ['https://api.example.test'];
  const getUser = operation('getUser', '/users/{id}', 'get', server);
  const deleteUser = operation('deleteUser', '/users/{id}', 'delete', server);
  const ops = [getUser, deleteUser];
  const u = `'https://api.example.test/users/1'`;

  it('reads shorthand, computed-literal, duplicate and known-spread method members', async () => {
    const result = await scan([
      `const method = 'DELETE';\nfetch(${u}, {method});`,
      `fetch(${u}, {['method']: 'DELETE'});`,
      `fetch(${u}, {method: 'GET', method: 'DELETE'});`,
      `const defaults = {method: 'DELETE'};\nfetch(${u}, {...defaults});`,
    ].join('\n'), ops);
    expect(result.uses).toHaveLength(4);
    for (const use of result.uses) expect(use).toMatchObject({ method: 'delete', operationIds: ['deleteUser'], resolution: 'resolved' });
  });

  it.each([
    ['unresolved shorthand', `const method = pick();\nfetch(${u}, {method});`],
    ['reassigned let shorthand', `let method = 'DELETE';\nmethod = pick();\nfetch(${u}, {method});`],
    ['unknown computed key', `fetch(${u}, {[key]: 'DELETE'});`],
    ['method member', `fetch(${u}, {method() { return 'DELETE'; }});`],
    ['getter', `fetch(${u}, {get method() { return 'DELETE'; }});`],
    ['unknown spread after method', `fetch(${u}, {method: 'GET', ...options});`],
    ['dynamic template method', `fetch(${u}, {method: \`\${verb}\`});`],
  ])('does not default to GET for %s', async (_label, source) => {
    const result = await scan(source, ops);
    expect(result.uses).toHaveLength(1);
    expect(result.uses[0]).toMatchObject({ resolution: 'unresolved', confidence: 'low' });
    expect(result.uses[0]?.method).toBeUndefined();
    expect(result.findings.every(finding => finding.confidence === 'low')).toBe(true);
  });

  it('keeps a known method when a later member overrides an unknown spread', async () => {
    const result = await scan(`fetch(${u}, {...options, method: 'DELETE'});\n`, ops);
    expect(result.uses[0]).toMatchObject({ method: 'delete', operationIds: ['deleteUser'], resolution: 'resolved' });
  });

  it('reads shorthand url/method in axios.request and the axios(url, config) form', async () => {
    const result = await scan([
      `import axios from 'axios';`,
      `const url = ${u};\nconst method = 'delete';`,
      `axios.request({url, method});`,
      `axios(${u}, {method: 'DELETE'});`,
      `axios({url, [verbKey]: 'delete'});`,
      `axios.request({url, method: chooseMethod()});`,
      `axios.request({url, ...extra});`,
    ].join('\n'), ops);
    expect(result.uses).toHaveLength(5);
    expect(result.uses[0]).toMatchObject({ method: 'delete', operationIds: ['deleteUser'], resolution: 'resolved' });
    expect(result.uses[1]).toMatchObject({ method: 'delete', operationIds: ['deleteUser'], resolution: 'resolved' });
    for (const use of result.uses.slice(2)) {
      expect(use.resolution).toBe('unresolved');
      expect(use.method).toBeUndefined();
    }
  });

  it('keeps the axios shorthand method even with a computed config member', async () => {
    const result = await scan(`import axios from 'axios';\naxios.delete(${u}, {[key]: 'x'});\n`, ops);
    expect(result.uses[0]).toMatchObject({ method: 'delete', operationIds: ['deleteUser'], resolution: 'resolved' });
  });
});

describe('scan axios base URLs', () => {
  const v1User = operation('v1User', '/users/{id}', 'get', ['https://api.test/v1']);
  const rootUser = operation('rootUser', '/users/{id}', 'get', ['https://api.test']);

  it('appends a relative axios URL without a leading slash to the baseURL path (combineURLs)', async () => {
    const result = await scan(`import axios from 'axios';\nconst api = axios.create({baseURL: 'https://api.test/v1'});\napi.get('users/1');\napi.get('/users/2');\nconst slash = axios.create({baseURL: 'https://api.test/v1/'});\nslash.get('users/3');\n`, [v1User, rootUser]);
    expect(result.uses.map(use => use.url)).toEqual(['https://api.test/v1/users/1', 'https://api.test/v1/users/2', 'https://api.test/v1/users/3']);
    for (const use of result.uses) expect(use).toMatchObject({ operationIds: ['v1User'], resolution: 'resolved', confidence: 'high' });
  });

  it('keeps absolute URLs independent of the axios baseURL', async () => {
    const result = await scan(`import axios from 'axios';\nconst api = axios.create({baseURL: 'https://api.test/v1'});\napi.get('https://api.test/users/1');\n`, [v1User, rootUser]);
    expect(result.uses[0]).toMatchObject({ url: 'https://api.test/users/1', operationIds: ['rootUser'], resolution: 'resolved' });
  });

  it.each([
    ['environment baseURL', `const api = axios.create({baseURL: process.env.STRIPE_URL});\napi.get('/users/1');`],
    ['opaque create config', `const api = axios.create(config);\napi.get('/users/1');`],
    ['dynamic template baseURL', `const api = axios.create({baseURL: \`\${host}/v1\`});\napi.get('/users/1');`],
    ['inline instance', `axios.create({baseURL: process.env.STRIPE_URL}).get('/users/1');`],
    ['request baseURL', `axios.get('/users/1', {baseURL: process.env.STRIPE_URL});`],
    ['inherited unknown base', `const api = axios.create({baseURL: process.env.X});\nconst child = api.create({timeout: 5});\nchild.get('/users/1');`],
  ])('keeps an unresolvable %s unresolved instead of using --base-url', async (_label, body) => {
    const result = await scan(`import axios from 'axios';\n${body}\n`, [rootUser], { baseUrl: 'https://api.test' });
    expect(result.uses).toHaveLength(1);
    expect(result.uses[0]).toMatchObject({ resolution: 'unresolved', confidence: 'low', url: '/users/1' });
    expect(result.uses[0]?.origin).toBeUndefined();
    expect(result.uses[0]?.reason).toContain('review hints');
    expect(result.findings.every(finding => finding.confidence === 'low')).toBe(true);
  });

  it('lets a known request baseURL override an unknown instance base', async () => {
    const result = await scan(`import axios from 'axios';\nconst api = axios.create({baseURL: process.env.X});\napi.get('/users/1', {baseURL: 'https://api.test'});\napi.get('https://api.test/users/2');\n`, [rootUser]);
    for (const use of result.uses) expect(use).toMatchObject({ operationIds: ['rootUser'], resolution: 'resolved' });
  });

  it('caps a call with an opaque request config at partial', async () => {
    const result = await scan(`import axios from 'axios';\nconst api = axios.create({baseURL: 'https://api.test'});\napi.get('/users/1', options);\n`, [rootUser]);
    expect(result.uses[0]).toMatchObject({ operationIds: ['rootUser'], resolution: 'partial', confidence: 'low' });
    expect(result.findings.every(finding => finding.confidence === 'low')).toBe(true);
  });
});

describe('scan URLs with an unknown leading base value', () => {
  const user = operation('getUser', '/users/{id}', 'get', ['http://127.0.0.1:4010']);

  it('treats `${base}/path` and base + "/path" as unknown base with path-only review hints', async () => {
    const result = await scan(`export async function getUser(base, id) {\n  return fetch(\`\${base}/users/\${id}?locale=en\`);\n}\nexport function other(base) { return fetch(base + '/users/1'); }\n`, [user], { baseUrl: 'http://127.0.0.1:4010' });
    expect(result.uses).toHaveLength(2);
    expect(result.uses[0]).toMatchObject({ method: 'get', url: '/users/{id}?locale=en', operationIds: ['getUser'], resolution: 'unresolved', confidence: 'low' });
    expect(result.uses[0]?.origin).toBeUndefined();
    expect(result.uses[0]?.bindings.filter(binding => binding.kind === 'url').map(binding => binding.name)).toEqual(['id']);
    expect(result.uses[1]).toMatchObject({ url: '/users/1', operationIds: ['getUser'], resolution: 'unresolved' });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every(finding => finding.confidence === 'low')).toBe(true);
  });
});

describe('scan module extensions', () => {
  const user = operation('getUser', '/users/{id}', 'get', ['https://api.example.test']);

  it('analyzes .mjs, .cjs, .mts and .cts sources without executing them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-scan-ext-'));
    roots.push(root);
    const call = `fetch('https://api.example.test/users/1');\n`;
    await writeFile(path.join(root, 'a.mjs'), `export const x = 1;\n${call}`);
    await writeFile(path.join(root, 'b.cjs'), `const axios = require('axios');\naxios.get('https://api.example.test/users/2');\n`);
    await writeFile(path.join(root, 'c.mts'), `export const y: number = 1;\n${call}`);
    await writeFile(path.join(root, 'd.cts'), `const z: number = 1;\n${call}`);
    await writeFile(path.join(root, 'e.json'), call);
    const result = await scanRepository({ repository: root, oldApi: snapshot([user]), newApi: snapshot([user]), changes: [] });
    expect(result.uses.map(use => [use.file, use.client, use.resolution])).toEqual([
      ['a.mjs', 'fetch', 'resolved'], ['b.cjs', 'axios', 'resolved'], ['c.mts', 'fetch', 'resolved'], ['d.cts', 'fetch', 'resolved'],
    ]);
    expect(result.diagnostics.filter(d => d.code === 'SCAN_PARSE_ERROR')).toEqual([]);
  });

  it('finds the demo consumer calls as low-confidence hints, not resolved matches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-scan-demo-'));
    roots.push(root);
    const demo = await readFile(path.resolve(import.meta.dirname, '../../demo/consumer/client.mjs'), 'utf8');
    await writeFile(path.join(root, 'client.mjs'), demo);
    const server = ['http://127.0.0.1:4010'];
    const ops = [
      operation('getUser', '/users/{id}', 'get', server), operation('createUser', '/users', 'post', server),
      operation('health', '/health', 'get', server), operation('preferences', '/preferences', 'get', server),
    ];
    const result = await scanRepository({ repository: root, oldApi: snapshot(ops), newApi: snapshot(ops), changes: ops.map(op => breaking(op.id)), baseUrl: 'http://127.0.0.1:4010' });
    expect(result.uses.map(use => [use.method, use.operationIds])).toEqual([
      ['get', ['getUser']], ['post', ['createUser']], ['get', ['health']], ['get', ['preferences']],
    ]);
    for (const use of result.uses) expect(use).toMatchObject({ resolution: 'unresolved', confidence: 'low' });
    expect(result.findings).toHaveLength(4);
    expect(result.findings.every(finding => finding.confidence === 'low')).toBe(true);
  });
});
