import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  DEFAULT_LIMITS, SCHEMA_VERSION, sha256, stableId,
  type ApiChange, type ApiOperation, type CodeRange, type ConsumerBinding,
  type ConsumerUse, type Diagnostic, type Finding, type HttpMethod,
  type ResourceLimits, type ScanOptions, type ScanResult,
} from '../contracts/index.js';

const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.turbo', '.cache']);
const METHODS = new Set<HttpMethod>(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const AXIOS_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'request']);

type Eval = { value: string; dynamic: boolean; parts: { name: string; node: ts.Node }[]; unknownPrefix?: string };
type Client = { kind: 'axios'; base?: string; baseUnknown?: boolean } | { kind: 'fetch' };
type Candidate = { path: string; origin?: string; operation: ApiOperation };
type Property = { kind: 'absent' } | { kind: 'value'; node: ts.Expression } | { kind: 'unknown' };
type Match = { operation: ApiOperation; originConfirmed: boolean };

function range(source: ts.SourceFile, node: ts.Node): CodeRange {
  const start = node.getStart(source);
  const pos = source.getLineAndCharacterOfPosition(start);
  return { start, end: node.getEnd(), line: pos.line + 1, column: pos.character + 1 };
}

function literal(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

// Shorthand members (`{method}`) refer to the local value, not to the property symbol.
function valueSymbol(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
}

function propertyKey(name: ts.PropertyName, checker: ts.TypeChecker): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const key = evaluate(name.expression, checker);
    return key && !key.dynamic ? key.value : undefined;
  }
  return undefined;
}

// Object literal semantics: the last definition wins; spreads, unresolved computed keys,
// methods and accessors make the property unknown unless a later member defines it.
function property(object: ts.ObjectLiteralExpression | undefined, name: string, checker: ts.TypeChecker, depth = 0): Property {
  let result: Property = { kind: 'absent' };
  if (!object) return result;
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      const spread = depth < 8 ? objectExpression(member.expression, checker) : undefined;
      const inner: Property = spread ? property(spread, name, checker, depth + 1) : { kind: 'unknown' };
      if (inner.kind !== 'absent') result = inner;
      continue;
    }
    const key = member.name ? propertyKey(member.name, checker) : undefined;
    if (key === undefined) { result = { kind: 'unknown' }; continue; }
    if (key !== name) continue;
    if (ts.isPropertyAssignment(member)) result = { kind: 'value', node: member.initializer };
    else if (ts.isShorthandPropertyAssignment(member)) result = { kind: 'value', node: member.name };
    else result = { kind: 'unknown' };
  }
  return result;
}

function propertyValue(object: ts.ObjectLiteralExpression | undefined, name: string, checker: ts.TypeChecker): ts.Expression | undefined {
  const found = property(object, name, checker);
  return found.kind === 'value' ? found.node : undefined;
}

function objectExpression(node: ts.Expression | undefined, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): ts.ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return objectExpression(node.expression, checker, seen);
  if (ts.isObjectLiteralExpression(node)) return node;
  if (!ts.isIdentifier(node)) return undefined;
  const symbol = valueSymbol(node, checker);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const) {
      return objectExpression(declaration.initializer, checker, seen);
    }
  }
  return undefined;
}

function evaluate(node: ts.Expression | undefined, checker: ts.TypeChecker, depth = 0, seen = new Set<ts.Symbol>()): Eval | undefined {
  if (!node || depth > 12) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return evaluate(node.expression, checker, depth + 1, seen);
  }
  const direct = literal(node);
  if (direct !== undefined) return { value: direct, dynamic: false, parts: [] };
  if (ts.isNumericLiteral(node)) return { value: node.text, dynamic: false, parts: [] };
  if (ts.isIdentifier(node)) {
    const symbol = valueSymbol(node, checker);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && (declaration.parent.flags & ts.NodeFlags.Const)) {
        return evaluate(declaration.initializer, checker, depth + 1, seen);
      }
    }
    return undefined;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    let left = evaluate(node.left, checker, depth + 1, new Set(seen));
    const right = evaluate(node.right, checker, depth + 1, new Set(seen));
    // An unknown leading identifier (`base + '/users'`) is an unknown base, not a path segment.
    if (!left && ts.isIdentifier(node.left) && right) left = { value: `{${node.left.text}}`, dynamic: true, parts: [], unknownPrefix: `{${node.left.text}}` };
    if (!left || !right) return undefined;
    return { value: left.value + right.value, dynamic: left.dynamic || right.dynamic, parts: [...left.parts, ...right.parts], ...(left.unknownPrefix ? { unknownPrefix: left.unknownPrefix } : {}) };
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    const parts: Eval['parts'] = [];
    let dynamic = false;
    let unknownPrefix: string | undefined;
    for (const [index, span] of node.templateSpans.entries()) {
      const resolved = evaluate(span.expression, checker, depth + 1, new Set(seen));
      if (resolved) {
        if (index === 0 && !node.head.text && resolved.unknownPrefix) unknownPrefix = resolved.unknownPrefix;
        value += resolved.value;
        dynamic ||= resolved.dynamic;
        parts.push(...resolved.parts);
      } else if (ts.isIdentifier(span.expression)) {
        const placeholder = `{${span.expression.text}}`;
        value += placeholder;
        dynamic = true;
        // A leading unresolved value is an unknown base (`${base}/users`), not a path variable.
        if (index === 0 && !node.head.text) unknownPrefix = placeholder;
        else parts.push({ name: span.expression.text, node: span.expression });
      } else return undefined;
      value += span.literal.text;
    }
    return { value, dynamic, parts, ...(unknownPrefix ? { unknownPrefix } : {}) };
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
    const first = evaluate(node.arguments?.[0], checker, depth + 1, new Set(seen));
    const base = evaluate(node.arguments?.[1], checker, depth + 1, new Set(seen));
    if (!first || first.unknownPrefix || base?.unknownPrefix) return undefined;
    if (!base) return first.value.startsWith('http:') || first.value.startsWith('https:') ? first : undefined;
    try {
      return { value: new URL(first.value, base.value).href, dynamic: first.dynamic || base.dynamic, parts: [...first.parts, ...base.parts] };
    } catch { return undefined; }
  }
  return undefined;
}

function isRequireAxios(node: ts.Expression): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
    && node.arguments.length === 1 && literal(node.arguments[0]!) === 'axios';
}

function clientOf(node: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): Client | undefined {
  if (ts.isParenthesizedExpression(node)) return clientOf(node.expression, checker, seen);
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (node.text === 'fetch') {
      const declarations = symbol?.declarations ?? [];
      if (declarations.length === 0 || declarations.every(d => d.getSourceFile().isDeclarationFile)) return { kind: 'fetch' };
    }
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isImportSpecifier(declaration)) {
        const importNode = declaration.parent && ts.isImportDeclaration(declaration.parent) ? declaration.parent
          : declaration.parent?.parent && ts.isImportDeclaration(declaration.parent.parent) ? declaration.parent.parent
          : declaration.parent?.parent?.parent && ts.isImportDeclaration(declaration.parent.parent.parent) ? declaration.parent.parent.parent : undefined;
        const module = importNode && literal(importNode.moduleSpecifier);
        if (module === 'axios') return { kind: 'axios' };
        if ((module === 'node-fetch' || module === 'cross-fetch') && (ts.isImportClause(declaration) || ts.isImportSpecifier(declaration))) return { kind: 'fetch' };
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && (declaration.parent.flags & ts.NodeFlags.Const)) {
        if (isRequireAxios(declaration.initializer)) return { kind: 'axios' };
        const resolved = clientOf(declaration.initializer, checker, seen);
        if (resolved) return resolved;
      }
    }
    return undefined;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'create') {
    const parent = clientOf(node.expression.expression, checker, seen);
    if (parent?.kind !== 'axios') return undefined;
    const argument = node.arguments[0];
    const config = objectExpression(argument, checker);
    const baseURL = argument && !config ? { kind: 'unknown' } as const : property(config, 'baseURL', checker);
    if (baseURL.kind === 'absent') return parent;
    const base = baseURL.kind === 'value' ? staticBase(evaluate(baseURL.node, checker)) : undefined;
    return base === undefined ? { kind: 'axios', baseUnknown: true } : { kind: 'axios', base };
  }
  return undefined;
}

function staticBase(value: Eval | undefined): string | undefined {
  return value && !value.dynamic ? value.value : undefined;
}

// Mirrors axios isAbsoluteURL/combineURLs: a relative URL is appended to the base path.
function isAbsoluteUrl(value: string): boolean {
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(value);
}

function combineUrls(base: string, relative: string): string {
  return relative ? `${base.replace(/\/?\/$/, '')}/${relative.replace(/^\/+/, '')}` : base;
}

function normalizeMethod(value: string | undefined): HttpMethod | undefined {
  const method = value?.toLowerCase() as HttpMethod | undefined;
  return method && METHODS.has(method) ? method : undefined;
}

function resolveUrl(value: string, base?: string): { url: string; origin?: string; pathname: string; query: string } | undefined {
  if (value.startsWith('//') && !base) return undefined;
  try {
    const parsed = new URL(value, base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
    return { url: absolute || base ? parsed.href : value, origin: absolute || base ? parsed.origin : undefined, pathname: parsed.pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}'), query: parsed.search };
  } catch {
    if (!value.startsWith('/')) return undefined;
    const [pathname = '', query = ''] = value.split('?', 2);
    return { url: value, pathname, query };
  }
}

function routeMatches(template: string, actual: string): boolean {
  const expected = template.replace(/\/$/, '').split('/');
  const observed = actual.replace(/\/$/, '').split('/');
  return expected.length === observed.length && expected.every((segment, index) =>
    /^\{[^/{}]+\}$/.test(segment) ? !!observed[index] : segment === observed[index]);
}

function httpUrl(value: string | undefined, base?: string): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch { return undefined; }
}

// Relative (or absent) servers only gain an origin from the known API base URL.
function serverCandidate(server: string, operation: ApiOperation, apiBase: URL | undefined): Candidate | undefined {
  const url = httpUrl(server) ?? (apiBase ? httpUrl(server, apiBase.href) : undefined);
  if (url) return { operation, origin: url.origin, path: `${url.pathname.replace(/\/$/, '')}${operation.path}` };
  if (!server.startsWith('/')) return undefined;
  return { operation, path: `${server.replace(/\/$/, '')}${operation.path}` };
}

/**
 * `origin` is the call's origin when known. A call with a known origin never gets an
 * origin-confirmed match from a server without origin. With `baseUnknown`, the call's
 * prefix is unknown, so its path is compared with every operation only as a review hint.
 */
function matchingOperations(operations: ApiOperation[], pathname: string, origin: string | undefined, method: HttpMethod | undefined, apiBase: URL | undefined, baseUnknown: boolean): Match[] {
  const matches: Match[] = [];
  for (const operation of operations) {
    if (method && operation.method !== method) continue;
    const servers = operation.servers.length ? operation.servers : [apiBase?.href ?? '/'];
    const candidates = servers.map(server => serverCandidate(server, operation, apiBase)).filter((candidate): candidate is Candidate => !!candidate);
    if (baseUnknown) {
      if (routeMatches(operation.path, pathname) || candidates.some(candidate => routeMatches(candidate.path, pathname))) matches.push({ operation, originConfirmed: false });
      continue;
    }
    let match: Match | undefined;
    for (const candidate of candidates) {
      if (candidate.origin && candidate.origin !== origin) continue;
      if (!routeMatches(candidate.path, pathname)) continue;
      const originConfirmed = candidate.origin !== undefined || origin === undefined;
      if (!match || (originConfirmed && !match.originConfirmed)) match = { operation, originConfirmed };
    }
    if (match) matches.push(match);
  }
  return matches;
}

function bindingsFor(source: ts.SourceFile, checker: ts.TypeChecker, url: Eval | undefined, urlNode: ts.Expression | undefined, parsedQuery: string | undefined, body: ts.Expression | undefined): ConsumerBinding[] {
  const bindings: ConsumerBinding[] = [];
  for (const part of url?.parts ?? []) bindings.push({ kind: 'url', name: part.name, range: range(source, part.node) });
  if (parsedQuery) {
    for (const [name, value] of new URLSearchParams(parsedQuery)) {
      // The whole literal is the supported edit span; query components inside a string are not independently editable.
      if (url && !url.dynamic && urlNode) bindings.push({ kind: 'query', name, value, range: range(source, urlNode) });
    }
  }
  const unwrappedBody = body && ts.isCallExpression(body) && ts.isPropertyAccessExpression(body.expression)
    && ts.isIdentifier(body.expression.expression) && body.expression.expression.text === 'JSON'
    && body.expression.name.text === 'stringify' ? body.arguments[0] : body;
  const object = objectExpression(unwrappedBody, checker);
  if (object) {
    for (const member of object.properties) {
      if (!ts.isPropertyAssignment(member)) continue;
      const name = ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name) ? member.name.text : undefined;
      if (!name) continue;
      const value = evaluate(member.initializer, checker);
      bindings.push({ kind: 'request-property', name, range: range(source, member.name), ...(value && !value.dynamic ? { value: value.value } : {}) });
    }
  }
  return bindings;
}

async function collectFiles(root: string, limits: ResourceLimits, excludes: string[], signal: AbortSignal | undefined, diagnostics: Diagnostic[]): Promise<string[]> {
  const files: string[] = [];
  const start = Date.now();
  const excluded = excludes.map(value => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''));
  async function walk(dir: string, depth: number): Promise<void> {
    if (signal?.aborted) throw new Error('Scan aborted');
    if (Date.now() - start > limits.timeoutMs) throw new Error('Scan timed out');
    if (depth > limits.maxDepth) { diagnostics.push({ code: 'SCAN_DEPTH_LIMIT', severity: 'warning', message: `Directory depth limit reached: ${path.relative(root, dir)}` }); return; }
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Scan aborted');
      if (Date.now() - start > limits.timeoutMs) throw new Error('Scan timed out');
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (IGNORED.has(entry.name) && entry.isDirectory()) continue;
      if (excluded.some(exclusion => exclusion && (relative === exclusion || relative.startsWith(exclusion + '/')))) continue;
      if (entry.isSymbolicLink()) { diagnostics.push({ code: 'SCAN_SYMLINK_SKIPPED', severity: 'info', message: 'Symbolic link skipped', file: relative }); continue; }
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await lstat(full);
      if (stat.size > limits.maxFileBytes) { diagnostics.push({ code: 'SCAN_FILE_TOO_LARGE', severity: 'warning', message: `File exceeds ${limits.maxFileBytes} bytes`, file: relative }); continue; }
      if (files.length >= limits.maxFiles) { diagnostics.push({ code: 'SCAN_FILE_LIMIT', severity: 'warning', message: `File limit ${limits.maxFiles} reached` }); return; }
      files.push(full);
    }
  }
  await walk(root, 0);
  return files;
}

export async function scanRepository(options: ScanOptions): Promise<ScanResult> {
  const diagnostics: Diagnostic[] = [];
  const limitations = [
    'Static analysis only: unknown wrappers, computed properties, mutable values and complex data flow require review.',
    'Response properties are traced only through immutable direct response variables and fetch json() variables.',
  ];
  const limits: ResourceLimits = { ...DEFAULT_LIMITS, ...options.limits };
  if (Object.values(limits).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid scan limits');
  if (options.signal?.aborted) throw new Error('Scan aborted');
  const root = await realpath(options.repository);
  const files = await collectFiles(root, limits, options.excludes ?? [], options.signal, diagnostics);
  const contents = new Map<string, string>();
  for (const file of files) {
    if (options.signal?.aborted) throw new Error('Scan aborted');
    const resolved = await realpath(file);
    if (!resolved.startsWith(root + path.sep)) {
      diagnostics.push({ code: 'SCAN_PATH_ESCAPE', severity: 'warning', message: 'File resolved outside repository', file: path.relative(root, file) });
      continue;
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.size > limits.maxFileBytes) {
        diagnostics.push({ code: 'SCAN_FILE_TOO_LARGE', severity: 'warning', message: `File exceeds ${limits.maxFileBytes} bytes`, file: path.relative(root, file) });
        continue;
      }
      contents.set(file, await handle.readFile({ encoding: 'utf8' }));
    } finally { await handle.close(); }
  }
  const readableFiles = files.filter(file => contents.has(file));
  const host = ts.createCompilerHost({ allowJs: true, checkJs: false, noEmit: true, noResolve: true });
  const hostReadFile = host.readFile.bind(host);
  host.readFile = file => contents.get(file) ?? hostReadFile(file);
  const program = ts.createProgram(readableFiles, { allowJs: true, checkJs: false, noEmit: true, noResolve: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker();
  const uses: ConsumerUse[] = [];
  const findings: Finding[] = [];
  const operations = [...options.oldApi.operations, ...options.newApi.operations];
  const uniqueOperations = [...new Map(operations.map(operation => [operation.id, operation])).values()];
  const apiBase = httpUrl(options.baseUrl);
  const begin = Date.now();
  for (const file of readableFiles) {
    if (options.signal?.aborted) throw new Error('Scan aborted');
    if (Date.now() - begin > limits.timeoutMs) { diagnostics.push({ code: 'SCAN_TIMEOUT', severity: 'warning', message: 'Analysis time limit reached' }); break; }
    const source = program.getSourceFile(file);
    if (!source) continue;
    const sf = source;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const fileHash = sha256(contents.get(file)!);
    const callUses = new Map<ts.CallExpression, ConsumerUse>();
    for (const error of program.getSyntacticDiagnostics(sf)) diagnostics.push({ code: 'SCAN_PARSE_ERROR', severity: 'warning', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), file: relative });
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        let client: Client | undefined;
        let method: HttpMethod | undefined;
        let urlNode: ts.Expression | undefined;
        let config: ts.ObjectLiteralExpression | undefined;
        // A config argument exists but is not a statically known object literal.
        let configOpaque = false;
        let body: ts.Expression | undefined;
        let methodUnknown = false;
        const configAt = (index: number) => {
          const argument = node.arguments[index];
          config = objectExpression(argument, checker);
          configOpaque = !!argument && !config;
        };
        const configProperty = (name: string): Property => configOpaque ? { kind: 'unknown' } : property(config, name, checker);
        const readMethod = (fallback: HttpMethod) => {
          const found = configProperty('method');
          if (found.kind === 'absent') { method = fallback; return; }
          const value = found.kind === 'value' ? evaluate(found.node, checker) : undefined;
          method = value && !value.dynamic ? normalizeMethod(value.value) : undefined;
          methodUnknown = !method;
        };
        if (ts.isPropertyAccessExpression(node.expression)) {
          const name = node.expression.name.text;
          client = clientOf(node.expression.expression, checker);
          if (client?.kind === 'axios' && AXIOS_METHODS.has(name)) {
            if (name === 'request') configAt(0);
            else {
              method = normalizeMethod(name);
              urlNode = node.arguments[0];
              if (name === 'post' || name === 'put' || name === 'patch') { body = node.arguments[1]; configAt(2); }
              else configAt(1);
            }
          } else client = undefined;
        } else {
          client = clientOf(node.expression, checker);
          if (client?.kind === 'fetch') {
            urlNode = node.arguments[0];
            configAt(1);
            readMethod('get');
            body = propertyValue(config, 'body', checker);
          } else if (client?.kind === 'axios') {
            // axios(config) or axios(url[, config])
            const first = node.arguments[0];
            if (first && !objectExpression(first, checker) && evaluate(first, checker)) { urlNode = first; configAt(1); }
            else configAt(0);
          }
        }
        if (client) {
          let base = options.baseUrl;
          let baseUnknown = false;
          let baseUncertain = false;
          if (client.kind === 'axios') {
            if (!urlNode) {
              const found = configProperty('url');
              if (found.kind === 'value') urlNode = found.node;
            }
            if (!method && !methodUnknown) readMethod('get');
            body ??= propertyValue(config, 'data', checker);
            const requestBase = configProperty('baseURL');
            if (configOpaque) baseUncertain = true;
            if (requestBase.kind === 'value') {
              base = staticBase(evaluate(requestBase.node, checker));
              baseUnknown = base === undefined;
            } else if (requestBase.kind === 'unknown' && !configOpaque) baseUnknown = true;
            else if (client.baseUnknown) { base = undefined; baseUnknown = true; }
            else base = client.base ?? options.baseUrl;
          }
          const url = evaluate(urlNode, checker);
          let value = url?.value;
          if (url?.unknownPrefix) value = url.value.slice(url.unknownPrefix.length);
          const relativeValue = value !== undefined && !isAbsoluteUrl(value);
          // Unknown prefix or base: only the observed path is known, so matches are review hints.
          const hint = !!url?.unknownPrefix || (client.kind === 'axios' && baseUnknown && relativeValue);
          const parsed = value === undefined ? undefined
            : hint ? (value.startsWith('/') ? resolveUrl(value) : undefined)
            : client.kind === 'axios' && relativeValue && base ? resolveUrl(combineUrls(base, value), options.baseUrl)
            : resolveUrl(value, options.baseUrl);
          const matches = parsed ? matchingOperations(uniqueOperations, parsed.pathname, hint ? undefined : parsed.origin, method, apiBase, hint) : [];
          const originUnconfirmed = matches.some(match => !match.originConfirmed);
          const operationIds = [...new Set(matches.map(match => match.operation.id))].sort();
          const resolution = !url || !parsed || !method || methodUnknown || hint ? 'unresolved'
            : matches.length === 1 && !url.dynamic && !originUnconfirmed && !baseUncertain ? 'resolved' : 'partial';
          const confidence = resolution === 'resolved' ? 'high' : resolution === 'partial' && !originUnconfirmed && !baseUncertain ? 'medium' : 'low';
          const reason = !url ? 'URL expression could not be resolved statically'
            : !parsed ? (url.unknownPrefix ? 'URL starts with a value that could not be resolved statically' : 'URL or base could not be interpreted')
            : !method || methodUnknown ? 'HTTP method could not be resolved statically'
            : hint ? `${url.unknownPrefix ? 'URL base comes from a value' : 'axios baseURL'} that could not be resolved statically; path matches are review hints only`
            : !matches.length ? 'No operation matched the URL, origin, path and method'
            : matches.length > 1 ? 'Several operations match the known URL and method'
            : originUnconfirmed ? `Path matches an operation whose server has no origin; call origin ${parsed.origin} is not confirmed by the server or a known base URL`
            : baseUncertain ? 'axios request config is not statically known and may override baseURL'
            : url.dynamic ? 'Path contains a dynamic template value' : 'Literal or immutable URL, method and operation matched';
          const use: ConsumerUse = {
            id: stableId('use', { file: relative, start: node.getStart(sf), end: node.getEnd(), client: client.kind }),
            file: relative, fileHash, range: range(sf, node), client: client.kind,
            urlExpression: urlNode?.getText(sf) ?? '', ...(parsed ? { url: parsed.url, ...(parsed.origin ? { origin: parsed.origin } : {}) } : {}),
            ...(method ? { method } : {}), operationIds,
            bindings: bindingsFor(sf, checker, url, urlNode, parsed?.query, body), resolution, confidence, reason,
          };
          uses.push(use);
          callUses.set(node, use);
          if (resolution !== 'resolved') diagnostics.push({ code: 'SCAN_REVIEW_REQUIRED', severity: 'warning', message: reason, file: relative });
          for (const change of options.changes) {
            if (change.classification === 'compatible') continue;
            if (!matches.some(({ operation }) => operation.id === change.operationId || operation.operationId === change.operationId)) continue;
            const finding: Finding = {
              id: stableId('finding', { change: change.id, use: use.id }), changeId: change.id, useId: use.id,
              consequence: `${change.classification === 'breaking' ? 'Potential break' : 'Review needed'}: ${change.explanation}`,
              evidence: [
                { kind: 'ast', message: `HTTP ${method ?? 'unknown'} call; ${reason}`, file: relative, range: use.range },
                ...change.evidence,
              ],
              confidence: change.classification === 'ambiguous' || confidence === 'low' ? 'low' : confidence,
              reviewStatus: 'pending',
            };
            findings.push(finding);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    const responseSymbols = new Map<ts.Symbol, ConsumerUse>();
    const dataSymbols = new Map<ts.Symbol, ConsumerUse>();
    function collectResponseVariables(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && (node.parent.flags & ts.NodeFlags.Const) && node.initializer) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        if (symbol && ts.isCallExpression(initializer)) {
          const use = callUses.get(initializer);
          if (use) responseSymbols.set(symbol, use);
          if (ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === 'json'
            && ts.isIdentifier(initializer.expression.expression)) {
            const response = checker.getSymbolAtLocation(initializer.expression.expression);
            const sourceUse = response && responseSymbols.get(response);
            if (sourceUse?.client === 'fetch') dataSymbols.set(symbol, sourceUse);
          }
        }
      }
      ts.forEachChild(node, collectResponseVariables);
    }
    collectResponseVariables(source);
    function collectResponseAccesses(node: ts.Node): void {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const dataUse = symbol && dataSymbols.get(symbol);
        if (dataUse && node.name.text !== 'then') dataUse.bindings.push({ kind: 'response-property', name: node.name.text, range: range(sf, node.name) });
      } else if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'data' && ts.isIdentifier(node.expression.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression.expression);
        const responseUse = symbol && responseSymbols.get(symbol);
        if (responseUse?.client === 'axios') responseUse.bindings.push({ kind: 'response-property', name: node.name.text, range: range(sf, node.name) });
      }
      ts.forEachChild(node, collectResponseAccesses);
    }
    collectResponseAccesses(source);
  }
  uses.sort((a, b) => a.file.localeCompare(b.file) || a.range.start - b.range.start);
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: SCHEMA_VERSION, uses, findings, diagnostics, limitations };
}
