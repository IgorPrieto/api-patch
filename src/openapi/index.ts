import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { ApiMediaType, ApiOperation, ApiParameter, ApiResponse, ApiSnapshot, Diagnostic, HttpMethod, JsonObject, JsonValue, LoadApiOptions, ResourceLimits, SourceLocation } from '../contracts/index.js';
import { DEFAULT_LIMITS, SCHEMA_VERSION, sha256, stableId } from '../contracts/index.js';

const METHODS: HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
// Every $ref is inlined, so shared references can expand exponentially. The budget scales with the parsed input
// but stays bounded; exceeding it is an explicit error rather than an unbounded allocation.
const MIN_EXPANSION_BUDGET = 100_000;
const EXPANSION_FACTOR = 16;
const MAX_EXPANSION_BUDGET = 1_000_000;
/** Annotation added to a schema expanded from a recursion target: `[{ key, refs }]` (target key and the `$ref` texts that point back to it). */
export const RECURSION_ANCHOR = 'x-apipatch-recursion-anchor';
const REF_ANNOTATIONS = new Set(['summary', 'description']);
type Obj = Record<string, unknown>;
type Reference = ApiSnapshot['references'][number];
type Field = { value: unknown; source: SourceLocation; stack: string[] };

export class ApiLoadError extends Error {
  constructor(readonly code: string, readonly source: SourceLocation, message: string) {
    super(`${source.file}#${source.pointer}: ${message}`);
    this.name = 'ApiLoadError';
  }
}

function object(value: unknown, at: SourceLocation): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiLoadError('INVALID_STRUCTURE', at, 'expected an object');
  return value as Obj;
}
function requiredString(value: unknown, at: SourceLocation): string {
  if (typeof value !== 'string' || value.length === 0) throw new ApiLoadError('INVALID_STRUCTURE', at, 'expected a nonempty string');
  return value;
}
function child(at: SourceLocation, key: string | number): SourceLocation {
  return { file: at.file, pointer: `${at.pointer}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}` };
}
function fail(code: string, at: SourceLocation, message: string): never { throw new ApiLoadError(code, at, message); }
/** Defines an own property even for keys such as `__proto__`, which plain assignment would turn into a prototype change. */
function put(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function within(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

class Loader {
  private readonly limits: ResourceLimits;
  private readonly started = Date.now();
  private readonly docs = new Map<string, { value: Obj; digest: string }>();
  private readonly realpaths = new Map<string, string>();
  private readonly references: Reference[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private root = '';
  private version = '';
  private sourceNodes = 0;
  private expandedNodes = 0;
  /** Reference texts that closed a schema cycle, per target key; their targets get a `RECURSION_ANCHOR` annotation. */
  private readonly recursionRefs = new Map<string, Set<string>>();
  constructor(private readonly options: LoadApiOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [name, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new ApiLoadError('INVALID_LIMIT', { file: '', pointer: '' }, `${name} must be a positive integer`);
  }
  private check(at: SourceLocation, depth = 0): void {
    if (this.options.signal?.aborted) fail('ABORTED', at, 'loading was cancelled');
    if (Date.now() - this.started > this.limits.timeoutMs) fail('TIMEOUT', at, 'loading exceeded the time limit');
    if (depth > this.limits.maxDepth) fail('MAX_DEPTH', at, 'reference or document depth limit exceeded');
  }
  private validateTree(value: unknown, at: SourceLocation, depth = 0): void {
    this.check(at, depth);
    this.sourceNodes++;
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) this.validateTree(value[i], child(at, i), depth + 1); return; }
    if (typeof value === 'object') { for (const [key, val] of Object.entries(value as Obj)) this.validateTree(val, child(at, key), depth + 1); return; }
    fail('INVALID_DOCUMENT', at, 'expected JSON-compatible data');
  }
  private async loadDocument(file: string, from: SourceLocation): Promise<{ file: string; value: Obj; digest: string }> {
    this.check(from);
    const resolved = path.resolve(file);
    if (!within(this.root, resolved)) fail('REF_OUTSIDE_ROOT', from, `path escapes allowed root: ${file}`);
    // Cached per load: every $ref passes through here, and a realpath syscall per reference dominates large expansions.
    let actual = this.realpaths.get(resolved);
    if (actual === undefined) {
      try { actual = await realpath(resolved); } catch { return fail('FILE_NOT_FOUND', from, `cannot read file: ${file}`); }
      this.realpaths.set(resolved, actual);
    }
    if (!within(this.root, actual)) fail('REF_OUTSIDE_ROOT', from, `symlink escapes allowed root: ${file}`);
    const cached = this.docs.get(actual);
    if (cached) return { file: actual, ...cached };
    if (this.docs.size >= this.limits.maxFiles) fail('MAX_FILES', from, 'OpenAPI document file limit exceeded');
    // Reject FIFOs, devices and directories before opening: a blocking open() of a FIFO cannot be timed out or cancelled.
    const before = await stat(actual).catch(() => fail('FILE_NOT_FOUND', from, `cannot read file: ${file}`));
    if (!before.isFile()) fail('INVALID_FILE', from, 'reference target must be a regular file');
    // O_NONBLOCK keeps a file swapped for a FIFO after the stat from blocking; the fstat below rejects it.
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)).catch(() => fail('FILE_NOT_FOUND', from, `cannot open file: ${file}`));
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) fail('INVALID_FILE', from, 'reference target must be a regular file');
      if (stat.size > this.limits.maxFileBytes) fail('MAX_FILE_BYTES', from, `file exceeds ${this.limits.maxFileBytes} bytes`);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        this.check(from);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, this.limits.maxFileBytes - total + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > this.limits.maxFileBytes) fail('MAX_FILE_BYTES', from, `file exceeds ${this.limits.maxFileBytes} bytes`);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks, total);
    } finally { await handle.close(); }
    if (bytes.length > this.limits.maxFileBytes) fail('MAX_FILE_BYTES', from, `file exceeds ${this.limits.maxFileBytes} bytes`);
    this.check(from);
    const source = { file: actual, pointer: '' };
    let value: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (path.extname(actual).toLowerCase() === '.json') value = JSON.parse(text);
      else {
        const doc = parseDocument(text, { strict: true, uniqueKeys: true, version: '1.2', schema: 'core' });
        if (doc.errors.length || doc.warnings.length) fail('INVALID_YAML', source, [...doc.errors, ...doc.warnings].map(e => e.message).join('; '));
        value = doc.toJS({ maxAliasCount: 0 });
      }
    } catch (error) {
      if (error instanceof ApiLoadError) throw error;
      fail('INVALID_DOCUMENT', source, `cannot parse document: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.validateTree(value, source);
    const parsed = object(value, source);
    const entry = { value: parsed, digest: sha256(bytes) };
    this.docs.set(actual, entry);
    return { file: actual, ...entry };
  }
  private pointer(root: unknown, pointer: string, at: SourceLocation): unknown {
    if (!pointer) return root;
    if (!pointer.startsWith('/')) fail('INVALID_REF', at, 'fragment must be a JSON Pointer');
    let current: unknown = root;
    for (const raw of pointer.slice(1).split('/')) {
      if (/~(?![01])/.test(raw)) fail('INVALID_REF', at, 'invalid JSON Pointer escape');
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (Array.isArray(current)) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) fail('BROKEN_REF', at, `missing target ${pointer}`);
        current = current[Number(key)];
      } else if (current && typeof current === 'object' && Object.hasOwn(current, key)) current = (current as Obj)[key];
      else fail('BROKEN_REF', at, `missing target ${pointer}`);
    }
    return current;
  }
  private async target(ref: string, at: SourceLocation, stack: string[]): Promise<{ value: unknown; source: SourceLocation; key: string; recursive: boolean }> {
    this.check(at, stack.length);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || ref.startsWith('//')) fail('REMOTE_REF', at, 'remote and protocol references are disabled');
    const hash = ref.indexOf('#');
    const filePart = hash < 0 ? ref : ref.slice(0, hash);
    const fragment = hash < 0 ? '' : ref.slice(hash + 1);
    let pointer: string;
    try { pointer = decodeURIComponent(fragment); } catch { return fail('INVALID_REF', at, 'invalid percent encoding in fragment'); }
    if (filePart.includes('?') || filePart.includes('\\') || filePart.includes('\0')) fail('INVALID_REF', at, 'invalid reference path');
    let decoded: string;
    try { decoded = decodeURIComponent(filePart); } catch { return fail('INVALID_REF', at, 'invalid percent encoding in path'); }
    if (path.isAbsolute(decoded)) fail('REF_OUTSIDE_ROOT', at, 'absolute reference paths are not allowed');
    const file = decoded ? path.resolve(path.dirname(at.file), decoded) : at.file;
    const doc = await this.loadDocument(file, at);
    const source = { file: doc.file, pointer };
    const value = this.pointer(doc.value, pointer, at);
    const key = `${doc.file}#${pointer}`;
    const recursive = stack.includes(key);
    this.references.push({ from: at, to: source, recursive });
    return { value, source, key, recursive };
  }
  private async deref(value: unknown, at: SourceLocation, stack: string[], kind: 'schema' | 'object'): Promise<{ value: Obj; source: SourceLocation; stack: string[]; recursive: boolean }> {
    let current = object(value, at), source = at;
    for (;;) {
      if (!Object.hasOwn(current, '$ref')) return { value: current, source, stack, recursive: false };
      const refAt = child(source, '$ref');
      const target = await this.target(requiredString(current.$ref, refAt), refAt, stack);
      if (target.recursive) {
        if (kind === 'object') fail('CYCLIC_REF', refAt, 'cyclic non-schema reference');
        this.diagnostics.push({ code: 'RECURSIVE_SCHEMA', severity: 'warning', message: 'Recursive schema reference is retained for review', source: refAt });
        const refs = this.recursionRefs.get(target.key) ?? new Set<string>();
        refs.add(current.$ref as string); this.recursionRefs.set(target.key, refs);
        const retained: JsonObject = { $ref: current.$ref as string };
        const siblings = Object.fromEntries(Object.entries(current).filter(([key]) => key !== '$ref'));
        // 3.1 applies $ref siblings by conjunction; keep them instead of silently dropping them.
        if (this.version.startsWith('3.1.') && Object.keys(siblings).length) return { value: { allOf: [retained, await this.normalizeSchema(siblings, source, stack)] }, source, stack, recursive: true };
        return { value: retained, source, stack, recursive: true };
      }
      if (kind === 'schema' && Object.keys(current).length > 1) {
        const siblings = Object.fromEntries(Object.entries(current).filter(([key]) => key !== '$ref'));
        if (this.version.startsWith('3.1.')) {
          const resolved = await this.normalizeSchema(target.value, target.source, [...stack, target.key]);
          const normalizedSiblings = await this.normalizeSchema(siblings, source, stack);
          return { value: { allOf: [resolved, normalizedSiblings] }, source, stack, recursive: false };
        }
        this.diagnostics.push({ code: 'IGNORED_REF_SIBLINGS', severity: 'warning', message: 'OpenAPI 3.0 ignores schema siblings of $ref', source });
      } else if (kind === 'object' && Object.keys(current).some(key => key !== '$ref' && !REF_ANNOTATIONS.has(key))) {
        this.diagnostics.push({ code: 'IGNORED_REF_SIBLINGS', severity: 'warning', message: 'Reference Object siblings other than summary/description are ignored', source });
      }
      current = object(target.value, target.source); source = target.source; stack = [...stack, target.key];
      this.check(source, stack.length);
    }
  }
  private async normalizeSchema(value: unknown, at: SourceLocation, stack: string[], depth = 0): Promise<JsonValue> {
    this.check(at, depth + stack.length);
    const budget = Math.min(MAX_EXPANSION_BUDGET, Math.max(MIN_EXPANSION_BUDGET, EXPANSION_FACTOR * this.sourceNodes));
    if (++this.expandedNodes > budget) fail('MAX_EXPANSION', at, `schema expansion exceeded ${budget} nodes; shared references expand too much to inline safely`);
    if (typeof value === 'boolean') {
      if (this.version.startsWith('3.1.')) return value;
      fail('INVALID_SCHEMA', at, 'boolean schemas require OpenAPI 3.1 (3.0 allows booleans only for additionalProperties)');
    }
    const resolved = await this.deref(value, at, stack, 'schema');
    if (resolved.recursive) return resolved.value as JsonObject;
    const schema = resolved.value;
    if (this.version.startsWith('3.0.') && typeof schema.nullable !== 'undefined' && typeof schema.nullable !== 'boolean') fail('INVALID_SCHEMA', child(resolved.source, 'nullable'), 'nullable must be boolean');
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(schema)) {
      const itemAt = child(resolved.source, key);
      if (key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions' || key === 'dependentSchemas') {
        const entries = object(item, itemAt); const nested: JsonObject = {};
        for (const [name, member] of Object.entries(entries)) put(nested, name, await this.normalizeSchema(member, child(itemAt, name), resolved.stack, depth + 1));
        put(output, key, nested);
      } else if (key === 'additionalProperties' && typeof item === 'boolean') {
        put(output, key, item);
      } else if (['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'contentSchema'].includes(key) && (typeof item === 'object' || typeof item === 'boolean')) {
        put(output, key, await this.normalizeSchema(item, itemAt, resolved.stack, depth + 1));
      } else if (['allOf', 'oneOf', 'anyOf', 'prefixItems'].includes(key) && Array.isArray(item)) {
        put(output, key, await Promise.all(item.map((member, i) => this.normalizeSchema(member, child(itemAt, i), resolved.stack, depth + 1))));
      } else put(output, key, item as JsonValue);
    }
    // Lets the comparator resolve retained recursive `$ref`s to the enclosing expansion of their target.
    const anchors = resolved.stack.slice(stack.length).filter(key => this.recursionRefs.has(key)).map(key => ({ key, refs: [...this.recursionRefs.get(key)!].sort() }));
    if (anchors.length && output[RECURSION_ANCHOR] === undefined) put(output, RECURSION_ANCHOR, anchors);
    return output;
  }
  private async content(value: unknown, at: SourceLocation, stack: string[]): Promise<ApiMediaType[]> {
    if (value === undefined) return [];
    const entries = object(value, at);
    const result: ApiMediaType[] = [];
    for (const [mediaType, raw] of Object.entries(entries)) {
      const source = child(at, mediaType), media = object(raw, source);
      result.push({ mediaType, schema: media.schema === undefined ? {} : await this.normalizeSchema(media.schema, child(source, 'schema'), stack), source });
    }
    return result;
  }
  private async parameters(raw: unknown, at: SourceLocation, stack: string[]): Promise<ApiParameter[]> {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) fail('INVALID_STRUCTURE', at, 'parameters must be an array');
    const result: ApiParameter[] = [];
    for (let i = 0; i < raw.length; i++) {
      const resolved = await this.deref(raw[i], child(at, i), stack, 'object');
      const item = resolved.value, source = resolved.source;
      const name = requiredString(item.name, child(source, 'name'));
      if (!['path', 'query', 'header', 'cookie'].includes(String(item.in))) fail('INVALID_STRUCTURE', child(source, 'in'), 'invalid parameter location');
      const location = item.in as ApiParameter['in'];
      if (location === 'path' && item.required !== true) fail('INVALID_STRUCTURE', child(source, 'required'), 'path parameter must be required');
      if (item.required !== undefined && typeof item.required !== 'boolean') fail('INVALID_STRUCTURE', child(source, 'required'), 'required must be boolean');
      let schema: JsonValue;
      if (item.schema !== undefined) schema = await this.normalizeSchema(item.schema, child(source, 'schema'), resolved.stack);
      else if (item.content !== undefined) {
        const media = await this.content(item.content, child(source, 'content'), resolved.stack);
        schema = media.length === 1 ? media[0]!.schema : {};
        this.diagnostics.push({ code: 'PARAMETER_CONTENT', severity: 'warning', message: 'Parameter media type and encoding are not represented in the normalized contract', source });
      } else fail('INVALID_STRUCTURE', source, 'parameter requires schema or content');
      result.push({ name, in: location, required: item.required === true, schema, source });
    }
    return result;
  }
  private async responses(raw: unknown, at: SourceLocation, stack: string[]): Promise<ApiResponse[]> {
    const entries = object(raw, at);
    if (!Object.keys(entries).some(key => !key.startsWith('x-'))) fail('INVALID_STRUCTURE', at, 'responses must contain at least one response');
    const result: ApiResponse[] = [];
    for (const [status, value] of Object.entries(entries)) {
      if (status.startsWith('x-')) continue;
      if (!/^(default|[1-5](?:[0-9]{2}|XX))$/.test(status)) fail('INVALID_STRUCTURE', child(at, status), 'invalid response status');
      const resolved = await this.deref(value, child(at, status), stack, 'object');
      if (typeof resolved.value.description !== 'string') fail('INVALID_STRUCTURE', child(resolved.source, 'description'), 'response description must be a string');
      result.push({ status, content: await this.content(resolved.value.content, child(resolved.source, 'content'), resolved.stack), source: resolved.source });
    }
    return result;
  }
  private security(raw: unknown, at: SourceLocation): JsonValue[] {
    if (!Array.isArray(raw)) fail('INVALID_STRUCTURE', at, 'security must be an array');
    for (let i = 0; i < raw.length; i++) object(raw[i], child(at, i));
    return raw as JsonValue[];
  }
  private servers(raw: unknown, at: SourceLocation): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) fail('INVALID_STRUCTURE', at, 'servers must be an array');
    return raw.map((entry, i) => requiredString(object(entry, child(at, i)).url, child(child(at, i), 'url')));
  }
  /** Resolves a Path Item, merging fields beside `$ref`; a field defined on both sides is undefined behavior in OpenAPI. */
  private async pathItem(raw: unknown, at: SourceLocation, stack: string[]): Promise<Map<string, Field>> {
    this.check(at, stack.length);
    const item = object(raw, at);
    const fields = new Map<string, Field>();
    for (const [key, value] of Object.entries(item)) if (key !== '$ref') fields.set(key, { value, source: at, stack });
    if (!Object.hasOwn(item, '$ref')) return fields;
    const refAt = child(at, '$ref');
    const target = await this.target(requiredString(item.$ref, refAt), refAt, stack);
    if (target.recursive) fail('CYCLIC_REF', refAt, 'cyclic path item reference');
    const referenced = await this.pathItem(target.value, target.source, [...stack, target.key]);
    if ([...fields.keys()].some(key => !REF_ANNOTATIONS.has(key) && !key.startsWith('x-'))) {
      this.diagnostics.push({ code: 'PATH_ITEM_REF_SIBLINGS', severity: 'info', message: 'Path Item fields beside $ref were merged with the referenced Path Item', source: at });
    }
    for (const [key, field] of referenced) {
      const local = fields.get(key);
      if (!local) { fields.set(key, field); continue; }
      if (REF_ANNOTATIONS.has(key) || key.startsWith('x-')) {
        this.diagnostics.push({ code: 'PATH_ITEM_REF_OVERRIDE', severity: 'warning', message: `Path Item field "${key}" is defined beside $ref and in the referenced object; the local value is kept`, source: child(at, key) });
        continue;
      }
      fail('PATH_ITEM_REF_CONFLICT', child(at, key), `Path Item field "${key}" is defined beside $ref and in the referenced object; OpenAPI leaves the result undefined`);
    }
    return fields;
  }
  async run(file: string): Promise<ApiSnapshot> {
    const input = path.resolve(file);
    const requestedRoot = path.resolve(this.options.allowedRoot ?? path.dirname(input));
    try { this.root = await realpath(requestedRoot); } catch { fail('INVALID_ROOT', { file: requestedRoot, pointer: '' }, 'allowed root does not exist'); }
    // The main input is checked by its real path, so a symlinked directory leading to it is accepted while a
    // symlink escaping the allowed root is still rejected by loadDocument.
    let actualInput: string;
    try { actualInput = await realpath(input); } catch { return fail('FILE_NOT_FOUND', { file: input, pointer: '' }, `cannot read file: ${file}`); }
    const main = await this.loadDocument(actualInput, { file: input, pointer: '' });
    const top = main.value, source = { file: main.file, pointer: '' };
    this.version = requiredString(top.openapi, child(source, 'openapi'));
    if (!/^3\.(?:0|1)\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(this.version)) fail('UNSUPPORTED_VERSION', child(source, 'openapi'), 'only OpenAPI 3.0 and 3.1 are supported');
    const info = object(top.info, child(source, 'info'));
    requiredString(info.title, child(child(source, 'info'), 'title'));
    requiredString(info.version, child(child(source, 'info'), 'version'));
    const pathsAt = child(source, 'paths');
    let paths: Obj;
    if (top.paths === undefined) {
      if (!this.version.startsWith('3.1.')) fail('INVALID_STRUCTURE', pathsAt, 'paths is required in OpenAPI 3.0');
      paths = {};
    } else paths = object(top.paths, pathsAt);
    if (top.webhooks !== undefined) {
      object(top.webhooks, child(source, 'webhooks'));
      // Webhooks are accepted so a 3.1 document missing paths can still load, but they are not turned into
      // operations: compare only diffs `paths`, so a webhook-only change would be silently invisible otherwise.
      this.diagnostics.push({ code: 'WEBHOOKS_NOT_COMPARED', severity: 'info', message: 'OpenAPI 3.1 webhooks are accepted for loading but are not represented as operations or compared', source: child(source, 'webhooks') });
    }
    const globalServers = this.servers(top.servers, child(source, 'servers'));
    const globalSecurity = top.security === undefined ? [] : this.security(top.security, child(source, 'security'));
    const operations: ApiOperation[] = [];
    for (const [route, rawPath] of Object.entries(paths)) {
      if (route.startsWith('x-')) continue;
      if (!route.startsWith('/')) fail('INVALID_STRUCTURE', child(pathsAt, route), 'path must start with /');
      const pathAt = child(pathsAt, route);
      const pathItem = await this.pathItem(rawPath, pathAt, []);
      const pathParameters = pathItem.get('parameters'), pathServers = pathItem.get('servers');
      const inherited = pathParameters ? await this.parameters(pathParameters.value, child(pathParameters.source, 'parameters'), pathParameters.stack) : [];
      for (const method of METHODS) {
        const field = pathItem.get(method);
        if (!field) continue;
        const opAt = child(field.source, method), operation = object(field.value, opAt), opStack = field.stack;
        const own = await this.parameters(operation.parameters, child(opAt, 'parameters'), opStack);
        const byKey = new Map<string, ApiParameter>();
        for (const parameter of inherited) byKey.set(`${parameter.in}\0${parameter.name}`, parameter);
        for (const parameter of own) byKey.set(`${parameter.in}\0${parameter.name}`, parameter);
        let requestBody: ApiOperation['requestBody'];
        if (operation.requestBody !== undefined) {
          const body = await this.deref(operation.requestBody, child(opAt, 'requestBody'), opStack, 'object');
          if (body.value.required !== undefined && typeof body.value.required !== 'boolean') fail('INVALID_STRUCTURE', child(body.source, 'required'), 'required must be boolean');
          requestBody = { required: body.value.required === true, content: await this.content(body.value.content, child(body.source, 'content'), body.stack), source: body.source };
        }
        const responses = await this.responses(operation.responses, child(opAt, 'responses'), opStack);
        const security = operation.security === undefined ? globalSecurity : this.security(operation.security, child(opAt, 'security'));
        const servers = operation.servers !== undefined ? this.servers(operation.servers, child(opAt, 'servers')) : pathServers ? this.servers(pathServers.value, child(pathServers.source, 'servers')) : globalServers;
        const operationId = operation.operationId === undefined ? undefined : requiredString(operation.operationId, child(opAt, 'operationId'));
        operations.push({ id: stableId('operation', { method, route }), ...(operationId !== undefined ? { operationId } : {}), method, path: route, servers, parameters: [...byKey.values()], ...(requestBody ? { requestBody } : {}), responses, security, source: opAt });
      }
    }
    operations.sort((a, b) => a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
    const documents = [...this.docs].map(([name, doc]) => ({ file: name, digest: doc.digest })).sort((a, b) => a.file.localeCompare(b.file));
    return { schemaVersion: SCHEMA_VERSION, id: stableId('api', { digest: main.digest, documents }), openapi: this.version, digest: main.digest, documents, operations, references: this.references, diagnostics: this.diagnostics };
  }
}

/** Read and normalize a local OpenAPI 3.0/3.1 document without network access or code execution. */
export async function loadApi(file: string, options: LoadApiOptions = {}): Promise<ApiSnapshot> {
  return new Loader(options).run(file);
}
