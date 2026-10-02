import { createServer, type Server } from 'node:http';

export type DemoApiVersion = 'v1' | 'v2';
/** One request as received by the synthetic API, with the status it answered. */
export interface RecordedRequest { method: string; path: string; query: string; body?: unknown; status: number; error?: string }
export interface RunningApi { base: string; requests: RecordedRequest[] }

const MAX_BODY_BYTES = 16_384;

async function readJson(request: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** In-memory implementation of demo/specs/v1.yaml or v2.yaml; it never touches disk or network beyond its socket. */
function syntheticApi(version: DemoApiVersion, requests: RecordedRequest[]): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const entry: RecordedRequest = { method: request.method ?? '', path: url.pathname, query: url.search, status: 0 };
    requests.push(entry);
    const send = (status: number, body: Record<string, unknown>): void => {
      entry.status = status;
      if (typeof body.error === 'string') entry.error = body.error;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && url.pathname === '/health') {
      send(200, version === 'v1' ? { ok: true } : { ok: true, version: 'v2' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/preferences') {
      send(200, version === 'v1' ? { theme: 'light' } : { mode: 'simple' });
      return;
    }
    const route = version === 'v1' ? /^\/users\/([^/]+)$/ : /^\/members\/([^/]+)$/;
    const match = request.method === 'GET' ? route.exec(url.pathname) : null;
    if (match) {
      const query = version === 'v1' ? 'locale' : 'lang';
      if (!url.searchParams.get(query)) { send(400, { error: `missing ${query}` }); return; }
      send(200, version === 'v1'
        ? { id: match[1]!, fullName: 'Ada Lovelace' }
        : { id: match[1]!, displayName: 'Ada Lovelace' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/users') {
      let body: unknown;
      try { body = await readJson(request); } catch { send(400, { error: 'invalid JSON' }); return; }
      entry.body = body;
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
      const required = version === 'v1' ? ['name'] : ['displayName', 'tenantId'];
      const missing = required.filter(name => typeof record[name] !== 'string' || !record[name]);
      if (missing.length) { send(400, { error: `missing ${missing.join(', ')}` }); return; }
      send(201, { id: 'user-42' });
      return;
    }
    send(404, { error: 'unknown route' });
  });
}

/** Serves one API version on an ephemeral 127.0.0.1 port for the duration of `run`, then closes every connection. */
export async function withDemoApi<T>(version: DemoApiVersion, run: (api: RunningApi) => Promise<T>): Promise<T> {
  const requests: RecordedRequest[] = [];
  const server = syntheticApi(version, requests);
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port');
    return await run({ base: `http://127.0.0.1:${address.port}`, requests });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}
