import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Minimal Chrome DevTools Protocol driver over Node's built-in WebSocket, so the panel can be exercised in
 * a real headless browser without adding dependencies. Only what the e2e test needs.
 */
const CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

export function findChrome(): string | undefined {
  if (process.env.APIPATCH_E2E === '0') return undefined;
  const configured = process.env.APIPATCH_CHROME;
  return configured && existsSync(configured) ? configured : CANDIDATES.find(candidate => existsSync(candidate));
}

type Listener = (params: any, sessionId?: string) => void;

export class Browser {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly child: ChildProcess;
  private readonly socket: WebSocket;
  private readonly profile: string;
  private constructor(child: ChildProcess, socket: WebSocket, profile: string) {
    this.child = child;
    this.socket = socket;
    this.profile = profile;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter?.resolve(message.result);
      } else for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
    });
  }

  static async launch(executable: string): Promise<Browser> {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'apipatch-chrome-'));
    const child = spawn(executable, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', '--password-store=basic',
      ...(process.env.APIPATCH_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${output.slice(-500)}`)), 20_000);
      child.stderr!.on('data', chunk => {
        output += String(chunk);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited with ${code}: ${output.slice(-500)}`)); });
    });
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', () => reject(new Error('CDP connection failed'))); });
    return new Browser(child, socket, profile);
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    await page.init();
    return page;
  }

  async close(): Promise<void> {
    try { await Promise.race([this.send('Browser.close'), new Promise(resolve => setTimeout(resolve, 2000))]); } catch { /* already closing */ }
    this.socket.close();
    // Launchers such as /usr/bin/chromium exec a child browser: kill the whole process group.
    try { process.kill(-this.child.pid!, 'SIGKILL'); } catch { /* group already gone */ }
    await rm(this.profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

export class Page {
  readonly errors: string[] = [];
  private readonly browser: Browser;
  private readonly sessionId: string;
  constructor(browser: Browser, sessionId: string) { this.browser = browser; this.sessionId = sessionId; }

  async init(): Promise<void> {
    this.browser.on('Runtime.exceptionThrown', (params, session) => { if (session === this.sessionId) this.errors.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`); });
    this.browser.on('Runtime.consoleAPICalled', (params, session) => { if (session === this.sessionId && params.type === 'error') this.errors.push(`console.error: ${params.args.map((arg: any) => arg.value ?? arg.description).join(' ')}`); });
    this.browser.on('Log.entryAdded', (params, session) => { if (session === this.sessionId && params.entry.level === 'error') this.errors.push(`log: ${params.entry.text}`); });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
  }

  send<T = any>(method: string, params: object = {}): Promise<T> { return this.browser.send<T>(method, params, this.sessionId); }

  async goto(url: string): Promise<void> {
    const loaded = new Promise<void>(resolve => { const off = this.browser.on('Page.loadEventFired', (_params, session) => { if (session === this.sessionId) { off(); resolve(); } }); });
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    // Same-document (fragment) navigations have no loader and fire no load event: start from a fresh document.
    if (!result.loaderId) { await this.goto('about:blank'); return this.goto(url); }
    await loaded;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n${expression}`);
    return result.result.value as T;
  }

  async waitFor<T = any>(expression: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch(error => error);
      if (last && !(last instanceof Error)) return last as T;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for: ${expression} (last: ${String(last)})`);
  }

  /** Click like a user: scroll into view and dispatch real mouse events at the element's center. */
  async click(selector: string): Promise<void> {
    const box = await this.waitFor<{ x: number; y: number }>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return null;
      el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }

  async press(key: string, code = key, keyCode = 0): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  }

  /** Focus a field, clear it and type text through the input pipeline. */
  async fill(selector: string, text: string): Promise<void> {
    await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); })()`);
    await this.send('Input.insertText', { text });
    if (!text) await this.press('Delete', 'Delete', 46);
  }
}
