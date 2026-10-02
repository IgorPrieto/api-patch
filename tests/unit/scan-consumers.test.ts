import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION, type ApiChange, type ApiOperation, type ApiSnapshot } from '../../src/contracts/index.js';
import { scanRepository } from '../../src/scan/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repository(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'apipatch-scan-')); roots.push(root); return root; }
function operation(id: string, pathName: string, method: ApiOperation['method'], server: string): ApiOperation {
  return { id, method, path: pathName, servers: [server], parameters: [], responses: [], security: [], source: { file: 'api.yaml', pointer: `/paths/${pathName}` } };
}
function snapshot(operations: ApiOperation[]): ApiSnapshot {
  return { schemaVersion: SCHEMA_VERSION, id: 'api', openapi: '3.1.0', digest: 'digest', documents: [], operations, references: [], diagnostics: [] };
}
const users = operation('users', '/users/{id}', 'get', 'https://api.example.test/v1');
const posts = operation('posts', '/posts', 'post', 'https://api.example.test/v1');
const other = operation('other', '/users/{id}', 'get', 'https://other.example.test/v1');
const change: ApiChange = { id: 'change-users', operationId: 'users', method: 'get', path: '/users/{id}', location: 'response', rule: 'removed', direction: 'response', classification: 'breaking', explanation: 'name removed', evidence: [] };

describe('scanRepository', () => {
  it('associates imported axios aliases and immutable template paths with source evidence', async () => {
    const root = await repository();
    const source = `import client from 'axios';\nconst api = client.create({baseURL: 'https://api.example.test/v1'});\nconst id = '42';\napi.get(\`/users/\${id}\`);\napi.post('/posts', {title: 'A'});\n`;
    await writeFile(path.join(root, 'consumer.ts'), source);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users, posts]), newApi: snapshot([users, posts]), changes: [change] });
    expect(result.uses).toHaveLength(2);
    expect(result.uses[0]).toMatchObject({ client: 'axios', method: 'get', operationIds: ['users'], resolution: 'resolved', confidence: 'high' });
    expect(result.uses[0]?.range.start).toBe(source.indexOf('api.get('));
    expect(result.uses[0]?.range.line).toBe(4);
    expect(result.uses[1]?.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'request-property', name: 'title' })]));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ changeId: 'change-users', useId: result.uses[0]?.id, confidence: 'high', reviewStatus: 'pending' });
  });

  it('uses origin and method; rejects shadowed fetch and unrelated axios names', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.js'), `const axios = { get() {} };\naxios.get('https://api.example.test/v1/users/1');\nfunction call(fetch) { fetch('https://api.example.test/v1/users/1'); }\nfetch('https://other.example.test/v1/users/1');\nfetch('https://api.example.test/v1/users/1', {method:'POST'});\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users, other]), newApi: snapshot([users, other]), changes: [change] });
    expect(result.uses).toHaveLength(2);
    expect(result.uses[0]?.operationIds).toEqual(['other']);
    expect(result.uses[1]?.operationIds).toEqual([]);
    expect(result.findings).toHaveLength(0);
  });

  it('keeps unresolved method and URL cases pending', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `const endpoint = external();\nfetch(endpoint, {method: chooseMethod()});\nfetch('https://api.example.test/v1/users/1', {method: chooseMethod()});\nfetch('https://api.example.test/v1/users/1', options);\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [change] });
    expect(result.uses).toHaveLength(3);
    expect(result.uses.map(use => use.resolution)).toEqual(['unresolved', 'unresolved', 'unresolved']);
    expect(result.uses[1]?.operationIds).toEqual(['users']);
    expect(result.uses[1]?.method).toBeUndefined();
    expect(result.uses[2]?.method).toBeUndefined();
    expect(result.diagnostics.filter(d => d.code === 'SCAN_REVIEW_REQUIRED')).toHaveLength(3);
  });

  it('marks template path variables partial and reads axios request config with a local base', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `import axios from 'axios';\nconst api = axios.create({baseURL:'https://api.example.test/v1'});\napi.get(\`/users/\${userId}\`);\napi.request({url:'/posts', method:'POST', data:{title:'A'}});\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users, posts]), newApi: snapshot([users, posts]), changes: [change] });
    expect(result.uses).toHaveLength(2);
    expect(result.uses[0]).toMatchObject({ operationIds: ['users'], resolution: 'partial', confidence: 'medium' });
    expect(result.uses[0]?.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'url', name: 'userId' })]));
    expect(result.uses[1]).toMatchObject({ operationIds: ['posts'], method: 'post', resolution: 'resolved' });
  });

  it('records direct response fields from immutable fetch and axios variables', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'consumer.ts'), `import axios from 'axios';\nconst response = await fetch('https://api.example.test/v1/users/1');\nconst data = await response.json();\nconsole.log(data.name);\nconst second = await axios.get('https://api.example.test/v1/users/2');\nconsole.log(second.data.name);\n`);
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [change] });
    expect(result.uses).toHaveLength(2);
    expect(result.uses[0]?.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'response-property', name: 'name' })]));
    expect(result.uses[1]?.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'response-property', name: 'name' })]));
  });

  it('does not execute scripts, follow symlinks or scan excluded/build/oversize files', async () => {
    const root = await repository();
    const outside = await repository();
    const marker = path.join(outside, 'executed');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { postinstall: `touch ${marker}` } }));
    await writeFile(path.join(root, 'main.js'), `fetch('https://api.example.test/v1/users/1');`);
    await writeFile(path.join(outside, 'escaped.js'), `fetch('https://api.example.test/v1/users/1');`);
    await symlink(outside, path.join(root, 'linked'));
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist', 'built.js'), `fetch('https://api.example.test/v1/users/1');`);
    await mkdir(path.join(root, 'ignored'));
    await writeFile(path.join(root, 'ignored', 'skip.js'), `fetch('https://api.example.test/v1/users/1');`);
    await writeFile(path.join(root, 'large.js'), ' '.repeat(200));
    const result = await scanRepository({ repository: root, oldApi: snapshot([users]), newApi: snapshot([users]), changes: [change], excludes: ['ignored'], limits: { maxFileBytes: 100 } });
    expect(result.uses.map(use => use.file)).toEqual(['main.js']);
    expect(result.diagnostics.map(d => d.code)).toContain('SCAN_SYMLINK_SKIPPED');
    expect(result.diagnostics.map(d => d.code)).toContain('SCAN_FILE_TOO_LARGE');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('cancels before reading a repository', async () => {
    const root = await repository();
    const controller = new AbortController();
    controller.abort();
    await expect(scanRepository({ repository: root, oldApi: snapshot([]), newApi: snapshot([]), changes: [], signal: controller.signal })).rejects.toThrow('aborted');
  });
});
