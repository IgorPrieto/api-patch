import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEMO_PATHS } from '../../src/demo/runner.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { Browser, findChrome, type Page } from './cdp.js';

/**
 * Real-browser walk through the panel: workspace explorer → analysis with the real services → findings
 * (including the ambiguous one) → diff → verification → export → explicit application. Skipped only when no
 * Chrome/Chromium executable is available (set APIPATCH_CHROME to point at one, APIPATCH_E2E=0 to skip).
 */
const chrome = findChrome();
const XSS_NAME = '<img src=x onerror="window.__xss=1">.yaml';

describe.skipIf(!chrome)('panel e2e in headless Chromium', () => {
  let root: string;
  let workspace: string;
  let downloads: string;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'apipatch-e2e-')));
    workspace = path.join(root, 'workspace');
    downloads = path.join(root, 'downloads');
    await mkdir(path.join(workspace, 'specs'), { recursive: true });
    await mkdir(downloads);
    await cp(DEMO_PATHS.v1, path.join(workspace, 'specs/v1.yaml'));
    await cp(DEMO_PATHS.v2, path.join(workspace, 'specs/v2.yaml'));
    await cp(DEMO_PATHS.v1, path.join(workspace, 'specs', XSS_NAME));
    await cp(DEMO_PATHS.migration, path.join(workspace, 'migration.yaml'));
    await cp(DEMO_PATHS.repository, path.join(workspace, 'repository'), { recursive: true });
    server = await startServer({ workspace, port: 0, log: () => {} });
    browser = await Browser.launch(chrome!);
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('refuses to work without the session token', { timeout: 30_000 }, async () => {
    await page.goto(`${server.url}?lang=es`);
    await page.waitFor(`!document.getElementById('session-error').hidden`);
    expect(await page.evaluate(`document.getElementById('session-error').textContent`)).toMatch(/token de sesión/);
    expect(await page.evaluate(`document.getElementById('analyze').disabled`)).toBe(true);
  });

  it('analyzes and exports in English by default', async () => {
    await page.goto(`${server.url}#token=${server.token}`);
    await page.waitFor(`document.getElementById('workspace').textContent.startsWith('Authorized workspace')`);
    expect(await page.evaluate('document.documentElement.lang')).toBe('en');
    expect(await page.evaluate(`document.getElementById('inputs-title').textContent`)).toBe('1. Inputs');
    expect(await page.evaluate(`document.getElementById('evidence-language').hidden`)).toBe(false);
    await page.fill('#old', 'specs/v1.yaml');
    await page.fill('#new', 'specs/v2.yaml');
    await page.fill('#repository', 'repository');
    await page.fill('#migration', 'migration.yaml');
    await page.click('#analyze');
    await page.waitFor(`document.getElementById('analyze-status').textContent.startsWith('Analysis complete')`, 60_000);
    expect(await page.evaluate(`document.getElementById('summary').textContent`)).toContain('Changes8');
    await page.click('#tab-verify');
    expect(await page.evaluate(`document.getElementById('verification').textContent`)).toContain('Pending review (2)');
    const done = new Promise<void>(resolve => { const off = browser.on('Browser.downloadProgress', params => { if (params.state === 'completed') { off(); resolve(); } }); });
    await page.click('[data-export="markdown"]');
    await done;
    await page.waitFor(`document.getElementById('export-status').textContent.startsWith('Downloaded')`);
    const names = await readdir(downloads);
    const markdownName = names.find(name => name.endsWith('.md'));
    expect(markdownName).toBeDefined();
    expect(await readFile(path.join(downloads, markdownName!), 'utf8')).toContain('# APIPatch — analysis report');
    await rm(path.join(downloads, markdownName!));
    await page.click('#lang-es');
    await page.waitFor(`document.getElementById('workspace').textContent.startsWith('Workspace autorizado')`);
    expect(await page.evaluate('document.documentElement.lang')).toBe('es');
    await page.click('#lang-en');
    await page.waitFor(`document.getElementById('workspace').textContent.startsWith('Authorized workspace')`);
  }, 90_000);

  it('walks selection → analysis → findings → diff → verification → export → apply', async () => {
    page.errors.length = 0;
    await page.goto(`${server.url}?lang=es#token=${server.token}`);
    await page.waitFor(`document.getElementById('workspace').textContent.startsWith('Workspace autorizado')`);
    expect(await page.evaluate('location.hash')).toBe('');
    expect(await page.evaluate('location.href')).not.toContain(server.token);

    // Bounded explorer: navigate into specs/, untrusted file names are shown as text, pick v1.yaml.
    await page.click('[data-browse="old"]');
    await page.waitFor(`document.getElementById('explorer').open && document.querySelector('#explorer-list [data-path="specs"]')`);
    await page.click('#explorer-list [data-path="specs"]');
    await page.waitFor(`document.querySelector('#explorer-list [data-path="specs/v1.yaml"]')`);
    expect(await page.evaluate(`[...document.querySelectorAll('#explorer-list button')].some(b => b.textContent.includes(${JSON.stringify(XSS_NAME)}))`)).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('#explorer-list img').length`)).toBe(0);
    await page.click('#explorer-list [data-path="specs/v1.yaml"]');
    await page.waitFor(`!document.getElementById('explorer').open`);
    expect(await page.evaluate(`document.getElementById('old').value`)).toBe('specs/v1.yaml');
    expect(await page.evaluate(`document.activeElement.dataset.browse`)).toBe('old');

    // Directory mode: choose the repository folder.
    await page.click('[data-browse="repository"]');
    await page.waitFor(`document.querySelector('#explorer-list [data-path="repository"]')`);
    await page.click('#explorer-list [data-path="repository"]');
    await page.waitFor(`document.getElementById('explorer-path').textContent === 'repository'`);
    await page.click('#explorer-choose-dir');
    await page.waitFor(`!document.getElementById('explorer').open`);
    expect(await page.evaluate(`document.getElementById('repository').value`)).toBe('repository');

    // Invalid input first: a traversal path is rejected by the server and shown as an alert.
    await page.fill('#new', '../outside.yaml');
    await page.fill('#migration', 'migration.yaml');
    await page.click('#analyze');
    await page.waitFor(`!document.getElementById('form-error').hidden`);
    expect(await page.evaluate(`document.getElementById('form-error').textContent`)).toContain('PATH_TRAVERSAL');
    expect(await page.evaluate(`document.getElementById('results').hidden`)).toBe(true);

    // Real analysis.
    await page.fill('#new', 'specs/v2.yaml');
    await page.click('#analyze');
    await page.waitFor(`!document.getElementById('results').hidden && document.getElementById('analyze-status').textContent.startsWith('Análisis completado')`, 60_000);
    const summary = await page.evaluate<string>(`document.getElementById('summary').textContent`);
    expect(summary).toContain('Cambios8');
    expect(summary).toContain('Hallazgos5');
    expect(summary).toContain('Resueltos3');
    expect(summary).toContain('Pendientes2');
    expect(await page.evaluate(`document.querySelectorAll('#changes tbody tr').length`)).toBe(8);
    await page.evaluate(`(() => { const s = document.getElementById('change-filter'); s.value = 'ambiguous'; s.dispatchEvent(new Event('change')); })()`);
    expect(await page.evaluate(`document.querySelectorAll('#changes tbody tr').length`)).toBe(2);

    // Keyboard tab navigation (ArrowRight) to files and findings.
    await page.evaluate(`document.getElementById('tab-changes').focus()`);
    await page.press('ArrowRight', 'ArrowRight', 39);
    expect(await page.evaluate(`document.activeElement.id`)).toBe('tab-files');
    expect(await page.evaluate(`document.getElementById('panel-files').hidden`)).toBe(false);
    const files = await page.evaluate<string>(`document.getElementById('files').textContent`);
    expect(files).toContain('client.js');
    expect(files).toContain('/preferences');
    // The ambiguous /preferences finding is pending, labelled with text and not only colour.
    expect(await page.evaluate(`[...document.querySelectorAll('#files .finding')].filter(f => f.textContent.includes('/preferences')).every(f => f.querySelector('.badge.pending')?.textContent === 'pendiente')`)).toBe(true);

    await page.click('#tab-diff');
    const diff = await page.evaluate<string>(`document.getElementById('diff').textContent`);
    expect(diff).toContain('+++ b/client.js');
    expect(await page.evaluate(`[...document.querySelectorAll('#diff .add')].some(l => l.textContent.includes('lang'))`)).toBe(true);

    await page.click('#tab-verify');
    const verification = await page.evaluate<string>(`document.getElementById('verification').textContent`);
    expect(verification).toMatch(/1superado/);
    expect(verification).toContain('Pendientes de revisión (2)');

    // Export Markdown through a real download.
    const done = new Promise<string>(resolve => { const off = browser.on('Browser.downloadProgress', params => { if (params.state === 'completed') { off(); resolve(params.guid); } }); });
    await page.click('[data-export="markdown"]');
    await done;
    await page.waitFor(`document.getElementById('export-status').textContent.startsWith('Descargado')`);
    const downloaded = (await readdir(downloads)).filter(name => name.endsWith('.md'));
    expect(downloaded).toHaveLength(1);
    expect(await readFile(path.join(downloads, downloaded[0]!), 'utf8')).toContain('# APIPatch');

    // Application requires the explicit confirmation checkbox.
    const client = path.join(workspace, 'repository/client.js');
    const before = await readFile(client, 'utf8');
    expect(await page.evaluate(`document.getElementById('apply-button').disabled`)).toBe(true);
    expect(await page.evaluate(`document.getElementById('apply').textContent`)).toContain('client.js');
    await page.click('#apply-confirm');
    await page.click('#apply-button');
    await page.waitFor(`document.getElementById('apply').textContent.includes('Plan aplicado')`, 30_000);
    const after = await readFile(client, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('/members/');

    expect(await page.evaluate('window.__xss')).toBeUndefined();
    // Chrome logs every non-2xx fetch; the only one expected is the deliberate 403 for the traversal path.
    expect(page.errors).toEqual(['log: Failed to load resource: the server responded with a status of 403 (Forbidden)']);
  }, 120_000);
});
