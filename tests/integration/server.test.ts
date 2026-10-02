import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DEMO_PATHS } from '../../src/demo/runner.js';
import { validateDocument } from '../../src/contracts/index.js';
import { startServer, MAX_BODY_BYTES, PUBLIC_DIR, type RunningServer } from '../../src/server/index.js';

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }
interface Call { method?: string; path: string; headers?: Record<string, string>; body?: string | object; token?: string | null; origin?: string | null; host?: string }

let server: RunningServer;
let root: string;
let workspace: string;
let outside: string;

async function call(options: Call): Promise<Reply> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${server.port}`, ...options.headers };
  if (options.token !== null) headers['X-APIPatch-Token'] = options.token ?? server.token;
  const origin = options.origin === undefined ? (method === 'POST' ? `http://127.0.0.1:${server.port}` : undefined) : options.origin;
  if (origin !== undefined && origin !== null) headers.Origin = origin;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['Content-Type'] ??= 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, method, path: options.path, headers, setHost: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const analyze = (body: object) => call({ method: 'POST', path: '/api/analyze', body });
const demoInput = { old: 'specs/v1.yaml', new: 'specs/v2.yaml', repository: 'repository', migration: 'migration.yaml' };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function freshWorkspace(): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(workspace, 'specs'), { recursive: true });
  await cp(DEMO_PATHS.v1, path.join(workspace, 'specs/v1.yaml'));
  await cp(DEMO_PATHS.v2, path.join(workspace, 'specs/v2.yaml'));
  await cp(DEMO_PATHS.migration, path.join(workspace, 'migration.yaml'));
  await cp(DEMO_PATHS.repository, path.join(workspace, 'repository'), { recursive: true });
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'apipatch-server-')));
  workspace = path.join(root, 'workspace');
  outside = path.join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.yaml'), 'openapi: 3.0.3\ninfo: { title: secret, version: "1" }\npaths: {}\n');
  await cp(DEMO_PATHS.repository, path.join(outside, 'repo'), { recursive: true });
  await freshWorkspace();
  server = await startServer({ workspace, port: 0, log: () => {} });
});
afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe('startServer', () => {
  it('binds to 127.0.0.1 only and uses the canonical workspace', () => {
    expect(server.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('rejects invalid ports and workspaces', async () => {
    await expect(startServer({ workspace, port: 70_000, log: () => {} })).rejects.toThrow(/port/);
    await expect(startServer({ workspace, port: Number('abc'), log: () => {} })).rejects.toThrow(/port/);
    await expect(startServer({ workspace: path.join(root, 'missing'), port: 0, log: () => {} })).rejects.toThrow(/no existe/);
    await expect(startServer({ workspace: '/', port: 0, log: () => {} })).rejects.toThrow(/raíz/);
  });
  it('prints the token only in the startup URL fragment', async () => {
    const lines: string[] = [];
    const other = await startServer({ workspace, port: 0, log: line => lines.push(line) });
    try {
      expect(lines[0]).toBe(`APIPatch panel local: ${other.url}#token=${other.token}`);
      expect(lines.slice(1).join('\n')).not.toContain(other.token);
    } finally { await other.close(); }
  });
});

describe('static output and HTTP guards', () => {
  it('serves the fixed static files with a strict CSP and no CORS', async () => {
    const page = await call({ path: '/', token: null });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.text).not.toContain(server.token);
    expect((await call({ path: '/app.js', token: null })).headers['content-type']).toBe('text/javascript; charset=utf-8');
    for (const probe of ['/../package.json', '/%2e%2e/package.json', '/src/server/index.ts', '/index.html', '/app.js.map', '/api']) {
      expect((await call({ path: probe, token: null })).status, probe).toBe(404);
    }
    expect((await call({ method: 'POST', path: '/', token: null, body: {} })).status).toBe(405);
  });

  it('ships a parseable UI script that never injects HTML or evaluates code', async () => {
    const script = path.join(PUBLIC_DIR, 'app.js');
    const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
    const source = await readFile(script, 'utf8');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout(\'']) expect(source, sink).not.toContain(sink);
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`, `[::1]:${server.port}`]) {
      const reply = await call({ path: '/api/workspace', host });
      expect(reply.status, host).toBe(421);
      expect((await call({ path: '/', host, token: null })).status).toBe(421);
    }
    expect((await call({ path: '/api/workspace', host: `localhost:${server.port}` })).status).toBe(200);
  });

  it('requires the session token on every API route', async () => {
    for (const probe of ['/api/workspace', '/api/browse', '/api/runs/run_0123456789abcdef0123456789abcdef']) {
      expect((await call({ path: probe, token: null })).json.error.code).toBe('SESSION_REQUIRED');
      expect((await call({ path: probe, token: server.token.slice(0, -1) + 'x' })).status).toBe(401);
      expect((await call({ path: probe, token: '' })).status).toBe(401);
    }
    expect((await call({ method: 'POST', path: '/api/analyze', token: null, body: demoInput })).status).toBe(401);
    const workspaceInfo = await call({ path: '/api/workspace' });
    expect(workspaceInfo.json).toEqual({ name: 'workspace', root: workspace });
    expect(workspaceInfo.text).not.toContain(server.token);
  });

  it('refuses cross-origin and cross-site requests, and never answers preflights', async () => {
    expect((await call({ path: '/api/workspace', origin: 'http://evil.example' })).json.error.code).toBe('ORIGIN_REJECTED');
    expect((await call({ path: '/api/workspace', origin: `http://localhost:${server.port}` })).status).toBe(403);
    expect((await call({ method: 'POST', path: '/api/analyze', origin: 'null', body: demoInput })).status).toBe(403);
    expect((await call({ method: 'POST', path: '/api/analyze', origin: null, body: demoInput })).json.error.code).toBe('ORIGIN_REQUIRED');
    expect((await call({ path: '/api/workspace', headers: { 'Sec-Fetch-Site': 'cross-site' } })).json.error.code).toBe('CROSS_SITE_REJECTED');
    const preflight = await call({ method: 'OPTIONS', path: '/api/analyze', origin: 'http://evil.example', token: null, headers: { 'Access-Control-Request-Method': 'POST' } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect((await call({ method: 'OPTIONS', path: '/api/analyze' })).status).toBe(405);
  });

  it('enforces methods, JSON bodies and size limits', async () => {
    expect((await call({ method: 'GET', path: '/api/analyze' })).status).toBe(405);
    expect((await call({ method: 'DELETE', path: '/api/workspace' })).status).toBe(405);
    expect((await call({ method: 'PUT', path: '/api/analyze', body: demoInput })).status).toBe(405);
    expect((await call({ method: 'POST', path: '/api/analyze', body: JSON.stringify(demoInput), headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await call({ method: 'POST', path: '/api/analyze', body: 'x'.repeat(MAX_BODY_BYTES + 1) })).status).toBe(413);
    expect((await call({ method: 'POST', path: '/api/analyze', body: '{"old":' })).json.error.code).toBe('INVALID_JSON');
    expect((await call({ method: 'POST', path: '/api/analyze', body: '[]' })).json.error.code).toBe('INVALID_JSON');
    expect((await analyze({ ...demoInput, command: 'rm -rf /' })).json.error.message).toMatch(/Campos desconocidos: command/);
    expect((await analyze({ ...demoInput, old: 42 })).status).toBe(400);
    expect((await analyze({ ...demoInput, baseUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await analyze({ ...demoInput, baseUrl: 'https://user:password@api.example.test' })).status).toBe(400);
    expect((await analyze({ ...demoInput, baseUrl: 'https://api.example.test?token=secret' })).status).toBe(400);
    expect((await analyze({ ...demoInput, baseUrl: 'https://api.example.test#fragment' })).status).toBe(400);
    expect((await analyze({ ...demoInput, baseUrl: `https://x.example/${'a'.repeat(3000)}` })).status).toBe(400);
    expect((await call({ path: `/api/browse?path=${'a'.repeat(5000)}` })).status).toBe(400);
  });
});

describe('workspace confinement', () => {
  beforeAll(async () => {
    await symlink(outside, path.join(workspace, 'escape-dir'));
    await symlink(path.join(outside, 'secret.yaml'), path.join(workspace, 'specs', 'escape.yaml'));
    await symlink(path.join(workspace, 'specs'), path.join(workspace, 'linked-specs'));
    await writeFile(path.join(workspace, 'specs', 'ref-escape.yaml'),
      'openapi: 3.0.3\ninfo: { title: t, version: "1" }\npaths:\n  /x:\n    $ref: "../../outside/secret.yaml#/paths/~1x"\n');
  });
  afterAll(freshWorkspace);

  it('lists only entries inside the workspace', async () => {
    const top = await call({ path: '/api/browse?path=' });
    expect(top.status).toBe(200);
    const names = top.json.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain('specs');
    expect(names).toContain('linked-specs');
    expect(names).not.toContain('escape-dir');
    expect(top.json.hidden).toBeGreaterThanOrEqual(1);
    expect(top.json.parent).toBeNull();
    const specs = await call({ path: '/api/browse?path=specs' });
    expect(specs.json.entries.map((entry: { name: string }) => entry.name)).not.toContain('escape.yaml');
    expect(specs.json.parent).toBe('');
    expect((await call({ path: '/api/browse?path=linked-specs' })).json.entries.some((entry: { name: string }) => entry.name === 'v1.yaml')).toBe(true);
  });

  it.each([
    ['../outside', 'PATH_TRAVERSAL'], ['specs/../../outside', 'PATH_TRAVERSAL'], ['/etc', 'PATH_NOT_RELATIVE'],
    ['~/', 'PATH_NOT_RELATIVE'], ['C:/Windows', 'PATH_NOT_RELATIVE'], ['specs\\..\\..', 'INVALID_PATH'],
    ['specs%00', 'INVALID_PATH'], ['escape-dir', 'PATH_ESCAPE'], ['missing', 'PATH_NOT_FOUND'], ['specs/v1.yaml', 'NOT_A_DIRECTORY'],
  ])('browse rejects %s', async (input, code) => {
    const reply = await call({ path: `/api/browse?path=${input.replace('%00', '%00').replace(/\\/g, '%5C')}` });
    expect(reply.json.error.code).toBe(code);
    expect(reply.text).not.toContain(outside);
  });

  it.each([
    [{ old: '../outside/secret.yaml' }, 'PATH_TRAVERSAL'],
    [{ old: '/etc/hosts' }, 'PATH_NOT_RELATIVE'],
    [{ old: 'specs/escape.yaml' }, 'PATH_ESCAPE'],
    [{ old: 'escape-dir/secret.yaml' }, 'PATH_ESCAPE'],
    [{ repository: 'escape-dir/repo' }, 'PATH_ESCAPE'],
    [{ repository: '../outside/repo' }, 'PATH_TRAVERSAL'],
    [{ migration: 'escape-dir/secret.yaml' }, 'PATH_ESCAPE'],
    [{ old: 'specs' }, 'NOT_A_FILE'],
    [{ repository: 'migration.yaml' }, 'NOT_A_DIRECTORY'],
    [{ new: 'specs/none.yaml' }, 'PATH_NOT_FOUND'],
  ])('analyze rejects %o', async (override, code) => {
    const reply = await analyze({ ...demoInput, ...override });
    expect(reply.json.error.code).toBe(code);
    expect(reply.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts links that stay inside the workspace and confines $ref resolution', async () => {
    const linked = await analyze({ ...demoInput, old: 'linked-specs/v1.yaml' });
    expect(linked.status).toBe(200);
    expect(linked.json.inputs.old).toBe('specs/v1.yaml');
    const ref = await analyze({ ...demoInput, old: 'specs/ref-escape.yaml' });
    expect(ref.status).toBe(422);
    expect(ref.text).not.toContain(workspace);
  });
});

describe('analysis, review, export and application', () => {
  beforeEach(freshWorkspace);

  it('runs the real pipeline and reports changes, findings, plan, diff and verification', async () => {
    const reply = await analyze({ ...demoInput, baseUrl: 'http://127.0.0.1:9' });
    expect(reply.status).toBe(200);
    const view = reply.json;
    expect(view.id).toMatch(/^run_[0-9a-f]{32}$/);
    expect(view.summary).toMatchObject({ changes: 8, breaking: 3, compatible: 3, ambiguous: 2, uses: 4, findings: 5, resolved: 3, pending: 2 });
    expect(view).not.toHaveProperty('snapshots');
    // The ambiguous oneOf response stays pending.
    const preferences = view.findings.filter((finding: any) => view.changes.find((change: any) => change.id === finding.changeId).path === '/preferences');
    expect(preferences.length).toBeGreaterThan(0);
    expect(preferences.every((finding: any) => finding.outcome === 'pending')).toBe(true);
    expect(view.files).toEqual([expect.objectContaining({ file: 'client.js', patch: true })]);
    expect(view.files[0].diff).toContain('+++ b/client.js');
    expect(view.plan.unifiedDiff).toContain('lang');
    expect(view.plan.files).toEqual([{ file: 'client.js', originalHash: sha(await readFile(path.join(workspace, 'repository/client.js'))), edits: 4 }]);
    expect(view.verification.results.find((result: any) => result.level === 1).status).toBe('passed');
    expect(view.uses.every((use: any) => use.snippet && use.snippet.lines.length > 0)).toBe(true);
    expect((await call({ path: `/api/runs/${view.id}` })).json.id).toBe(view.id);
    expect(reply.text).not.toContain(server.token);
  });

  it('analyzes without migration and reports an invalid migration without failing the analysis', async () => {
    const plain = await analyze({ old: 'specs/v1.yaml', new: 'specs/v2.yaml', repository: 'repository' });
    expect(plain.json.plan).toBeNull();
    expect(plain.json.findings.every((finding: any) => finding.outcome === 'unplanned')).toBe(true);
    expect((await call({ path: `/api/runs/${plain.json.id}/export?format=patch` })).status).toBe(404);
    await writeFile(path.join(workspace, 'bad-migration.yaml'), "schemaVersion: '1.0'\nallowedOrigins: []\noperations: [{ from: nope, to: nope2 }]\nrenames: []\nvalues: []\n");
    const bad = await analyze({ ...demoInput, migration: 'bad-migration.yaml' });
    expect(bad.status).toBe(200);
    expect(bad.json.plan).toBeNull();
    expect(bad.json.planError).toMatch(/plan|Migración/);
    await writeFile(path.join(workspace, 'broken.yaml'), 'openapi: [unclosed');
    const broken = await analyze({ ...demoInput, new: 'broken.yaml' });
    expect(broken.status).toBe(422);
    expect(broken.json.error.message).not.toContain(workspace);
  });

  it('exports JSON, Markdown and patch for a run only', async () => {
    const view = (await analyze(demoInput)).json;
    const json = await call({ path: `/api/runs/${view.id}/export?format=json` });
    expect(json.headers['content-disposition']).toMatch(/^attachment; filename="apipatch-report_[0-9a-f]+\.json"$/);
    const report = validateDocument('RunReport', json.json);
    expect(report.repairs[0]!.id).toBe(view.plan.id);
    expect(report.verification.length).toBe(5);
    expect(json.text).not.toContain(server.token);
    const markdown = await call({ path: `/api/runs/${view.id}/export?format=markdown` });
    expect(markdown.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(markdown.text).toContain('# APIPatch');
    const patch = await call({ path: `/api/runs/${view.id}/export?format=patch` });
    expect(patch.text).toBe(view.plan.unifiedDiff);
    expect((await call({ path: `/api/runs/${view.id}/export?format=html` })).status).toBe(400);
    expect((await call({ path: '/api/runs/run_ffffffffffffffffffffffffffffffff/export?format=json' })).status).toBe(404);
    expect((await call({ path: '/api/runs/..%2F..%2Fetc/export?format=json' })).status).toBe(404);
  });

  it('recomputes the plan when a finding is rejected in review', async () => {
    const view = (await analyze(demoInput)).json;
    const target = view.findings.find((finding: any) => finding.outcome === 'resolved');
    const reviewed = await call({ method: 'POST', path: `/api/runs/${view.id}/review`, body: { findingId: target.id, status: 'rejected' } });
    expect(reviewed.status).toBe(200);
    expect(reviewed.json.findings.find((finding: any) => finding.id === target.id)).toMatchObject({ reviewStatus: 'rejected', outcome: 'rejected' });
    expect(reviewed.json.plan.resolvedFindingIds).not.toContain(target.id);
    expect((await call({ method: 'POST', path: `/api/runs/${view.id}/review`, body: { findingId: 'nope', status: 'rejected' } })).status).toBe(404);
    expect((await call({ method: 'POST', path: `/api/runs/${view.id}/review`, body: { findingId: target.id, status: 'done' } })).status).toBe(400);
  });

  it('applies only on explicit confirmation with matching plan id and hashes, inside the repository', async () => {
    const view = (await analyze(demoInput)).json;
    const files = view.plan.files.map((file: any) => ({ file: file.file, originalHash: file.originalHash }));
    const applyCall = (body: object) => call({ method: 'POST', path: `/api/runs/${view.id}/apply`, body });
    const client = path.join(workspace, 'repository/client.js');
    const before = await readFile(client, 'utf8');
    expect((await applyCall({ planId: view.plan.id, files })).json.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await applyCall({ planId: view.plan.id, files, confirm: 'yes' })).json.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await applyCall({ planId: 'repair_x', files, confirm: true })).json.error.code).toBe('PLAN_MISMATCH');
    expect((await applyCall({ planId: view.plan.id, files: [{ file: 'client.js', originalHash: '0'.repeat(64) }], confirm: true })).json.error.code).toBe('HASH_MISMATCH');
    expect((await applyCall({ planId: view.plan.id, files: [], confirm: true })).json.error.code).toBe('HASH_MISMATCH');
    expect((await applyCall({ planId: view.plan.id, files: [...files, { file: '../outside.js', originalHash: '0'.repeat(64) }], confirm: true })).status).toBe(409);
    expect(await readFile(client, 'utf8')).toBe(before);

    const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(root, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(async entry => [path.join(entry.parentPath, entry.name), sha(await readFile(path.join(entry.parentPath, entry.name)))])));
    const hashesBefore = await snapshot();
    const applied = await applyCall({ planId: view.plan.id, files, confirm: true });
    expect(applied.status).toBe(200);
    expect(applied.json.application).toMatchObject({ status: 'applied', files: ['client.js'] });
    expect(applied.json.verification.results.find((result: any) => result.level === 1).status).toBe('passed');
    const after = await readFile(client, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('/members/');
    const hashesAfter = await snapshot();
    const changed = Object.keys(hashesAfter).filter(file => hashesAfter[file] !== hashesBefore[file]);
    expect(changed).toEqual([client]);
    expect(Object.keys(hashesAfter).sort()).toEqual(Object.keys(hashesBefore).sort());
    expect((await call({ method: 'POST', path: `/api/runs/${view.id}/review`, body: { findingId: view.findings[0].id, status: 'rejected' } })).json.error.code).toBe('ALREADY_APPLIED');
  });

  it('does not overwrite files changed after the analysis', async () => {
    const view = (await analyze(demoInput)).json;
    const files = view.plan.files.map((file: any) => ({ file: file.file, originalHash: file.originalHash }));
    const client = path.join(workspace, 'repository/client.js');
    const edited = (await readFile(client, 'utf8')) + '\n// local edit\n';
    await writeFile(client, edited);
    const reply = await call({ method: 'POST', path: `/api/runs/${view.id}/apply`, body: { planId: view.plan.id, files, confirm: true } });
    expect(reply.status).toBe(200);
    expect(reply.json.application.status).toBe('conflict');
    expect(reply.json.application.diagnostics.map((item: any) => item.code)).toContain('REPAIR_CONFLICT');
    expect(await readFile(client, 'utf8')).toBe(edited);
  });

  it('never writes through a link to a file outside the repository', async () => {
    const view = (await analyze(demoInput)).json;
    const files = view.plan.files.map((file: any) => ({ file: file.file, originalHash: file.originalHash }));
    const client = path.join(workspace, 'repository/client.js');
    const target = path.join(outside, 'client-target.js');
    await cp(client, target);
    const outsideBefore = await readFile(target, 'utf8');
    await rm(client);
    await symlink(target, client);
    const reply = await call({ method: 'POST', path: `/api/runs/${view.id}/apply`, body: { planId: view.plan.id, files, confirm: true } });
    expect(reply.json.application.status).toBe('conflict');
    expect(await readFile(target, 'utf8')).toBe(outsideBefore);
  });

  it('refuses to apply when the repository directory was swapped for a link', async () => {
    const view = (await analyze(demoInput)).json;
    const files = view.plan.files.map((file: any) => ({ file: file.file, originalHash: file.originalHash }));
    await rename(path.join(workspace, 'repository'), path.join(workspace, 'repository-old'));
    await symlink(path.join(outside, 'repo'), path.join(workspace, 'repository'));
    const outsideBefore = await readFile(path.join(outside, 'repo/client.js'), 'utf8');
    const reply = await call({ method: 'POST', path: `/api/runs/${view.id}/apply`, body: { planId: view.plan.id, files, confirm: true } });
    expect(reply.json.error.code).toBe('REPOSITORY_MOVED');
    expect(await readFile(path.join(outside, 'repo/client.js'), 'utf8')).toBe(outsideBefore);
    await rm(path.join(workspace, 'repository'));
  });
});
