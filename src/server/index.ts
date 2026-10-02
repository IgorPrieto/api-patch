import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportReport } from '../report/index.js';
import { PathError, listDirectory, resolveWorkspace } from './paths.js';
import { RequestError, RunStore, errorMessage, isClientError, parseAnalyzeInput, viewRun } from './runs.js';

/**
 * Local review panel. Security model (see src/server/README.md):
 * - listens on 127.0.0.1 only; Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
 * - every /api request carries the per-process session token in `X-APIPatch-Token`; the token reaches the
 *   browser only through the URL fragment printed by the CLI, never in a response, log or report;
 * - cross-origin requests are refused (Origin and Sec-Fetch-Site), no CORS headers are ever sent and mutating
 *   requests require JSON bodies, so a foreign page cannot forge them (CSRF);
 * - the browser addresses files only by paths relative to the CLI workspace, canonicalized in ./paths.ts;
 * - static output is a fixed in-memory set of files; no endpoint executes commands or repository scripts.
 */
export interface ServerOptions {
  /** Directory the browser may browse and analyze. Defaults to the current directory. */
  workspace?: string;
  /** TCP port on 127.0.0.1; 0 picks a free port. */
  port: number;
  /** Receives the startup lines (URL with token). Defaults to stdout. */
  log?: (line: string) => void;
}
export interface RunningServer { url: string; port: number; token: string; workspace: string; server: Server; close(): Promise<void> }

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 4096;
const TOKEN_HEADER = 'x-apipatch-token';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** src/server → src/ui/public; dist/server → src/ui/public (the package ships src/ui/public). */
export const PUBLIC_DIR = [path.resolve(HERE, '../ui/public'), path.resolve(HERE, '../../src/ui/public')]
  .find(candidate => existsSync(path.join(candidate, 'index.html'))) ?? path.resolve(HERE, '../ui/public');
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function baseHeaders(type: string): Record<string, string> {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': CSP,
  };
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...baseHeaders(type), 'Content-Length': String(Buffer.byteLength(body)), ...extra });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function tokenMatches(expected: Buffer, header: string | string[] | undefined): boolean {
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Se requiere Content-Type: application/json');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', `El cuerpo supera ${MAX_BODY_BYTES} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', `El cuerpo supera ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'INVALID_JSON', 'El cuerpo no es JSON válido'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_JSON', 'Se esperaba un objeto JSON');
  return value as Record<string, unknown>;
}

function attachmentName(name: string): Record<string, string> {
  return { 'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"` };
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const port = options.port;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port debe ser un entero entre 0 y 65535');
  const workspace = await resolveWorkspace(options.workspace ?? process.cwd());
  const store = new RunStore(workspace);
  const token = randomBytes(32).toString('base64url');
  const tokenBytes = Buffer.from(token);
  const statics = new Map(Object.entries(STATIC_FILES).map(([route, item]) => [route, { type: item.type, body: readFileSync(path.join(PUBLIC_DIR, item.file)) }]));
  let actualPort = port;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    if (rawUrl.length > MAX_URL_LENGTH || !rawUrl.startsWith('/')) throw new HttpError(400, 'INVALID_URL', 'URL no válida');
    const host = req.headers.host;
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) throw new HttpError(421, 'HOST_REJECTED', 'Host no permitido');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, 'ORIGIN_REJECTED', 'Origen no permitido');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'CROSS_SITE_REJECTED', 'Petición entre sitios no permitida');
    const url = new URL(rawUrl, `http://${host}`);
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      const file = statics.get(pathname);
      if (!file) throw new HttpError(404, 'NOT_FOUND', 'No encontrado');
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido');
      res.writeHead(200, { ...baseHeaders(file.type), 'Content-Length': String(file.body.length) });
      res.end(method === 'HEAD' ? undefined : file.body);
      return;
    }
    if (!tokenMatches(tokenBytes, req.headers[TOKEN_HEADER])) throw new HttpError(401, 'SESSION_REQUIRED', 'Falta el token de sesión o no es válido; abre la URL que imprimió la CLI');
    const allow = (expected: 'GET' | 'POST'): void => {
      if (method !== expected) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido');
      // Browsers always send Origin on POST; requiring it closes the remaining forged-form gap.
      if (expected === 'POST' && origin === undefined) throw new HttpError(403, 'ORIGIN_REQUIRED', 'Falta la cabecera Origin');
    };

    if (pathname === '/api/workspace') {
      allow('GET');
      return sendJson(res, 200, { name: path.basename(workspace), root: workspace });
    }
    if (pathname === '/api/browse') {
      allow('GET');
      return sendJson(res, 200, await listDirectory(workspace, url.searchParams.get('path') ?? ''));
    }
    if (pathname === '/api/analyze') {
      allow('POST');
      const input = parseAnalyzeInput(await readJson(req));
      const run = await store.exclusive(() => store.analyze(input));
      return sendJson(res, 200, viewRun(run));
    }
    const match = /^\/api\/runs\/([^/]+)(?:\/(review|apply|export))?$/.exec(pathname);
    if (!match) throw new HttpError(404, 'NOT_FOUND', 'No encontrado');
    const run = store.get(match[1]!);
    const action = match[2];
    if (action === undefined) { allow('GET'); return sendJson(res, 200, viewRun(run)); }
    if (action === 'review') {
      allow('POST');
      const body = await readJson(req);
      await store.exclusive(() => store.review(run, body.findingId, body.status));
      return sendJson(res, 200, viewRun(run));
    }
    if (action === 'apply') {
      allow('POST');
      const body = await readJson(req);
      await store.exclusive(() => store.apply(run, body));
      return sendJson(res, 200, viewRun(run));
    }
    allow('GET');
    const format = url.searchParams.get('format');
    const language = url.searchParams.get('lang') === 'en' ? 'en' : 'es';
    const stem = `apipatch-${run.report.id}`;
    if (format === 'json') return send(res, 200, 'application/json; charset=utf-8', exportReport(run.report, 'json'), attachmentName(`${stem}.json`));
    if (format === 'markdown') return send(res, 200, 'text/markdown; charset=utf-8', exportReport(run.report, 'markdown', language), attachmentName(`${stem}.md`));
    if (format === 'patch') {
      if (!run.plan) throw new HttpError(404, 'NO_PLAN', 'Este análisis no tiene plan de reparación');
      return send(res, 200, 'text/x-diff; charset=utf-8', run.plan.unifiedDiff, attachmentName(`${stem}.patch`));
    }
    throw new HttpError(400, 'INVALID_FORMAT', 'format debe ser json, markdown o patch');
  }

  const server = createServer({ requestTimeout: 180_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) return sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      if (error instanceof PathError || error instanceof RequestError) return sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      if (isClientError(error)) {
        const code = (error as { code?: unknown }).code;
        return sendJson(res, 422, { error: { code: typeof code === 'string' ? code : 'INVALID_INPUT', message: errorMessage(error, workspace) } });
      }
      // Unexpected failures: generic message to the browser, details only on the local terminal.
      process.stderr.write(`APIPatch UI: error interno: ${errorMessage(error, workspace)}\n`);
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Error interno del servidor; consulta la terminal' } });
    });
  });
  server.maxHeadersCount = 64;
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.off('error', reject); resolve(); });
  });
  actualPort = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${actualPort}/`;
  const log = options.log ?? ((line: string) => { process.stdout.write(line + '\n'); });
  log(`APIPatch panel local: ${url}#token=${token}`);
  log(`Workspace autorizado: ${workspace}`);
  log('El navegador solo puede leer y analizar rutas dentro de ese workspace. Ctrl+C para detener.');
  return {
    url, port: actualPort, token, workspace, server,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
