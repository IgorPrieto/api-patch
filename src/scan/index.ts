import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  DEFAULT_LIMITS, SCHEMA_VERSION, sha256, stableId,
  type ApiChange, type ApiOperation, type CodeRange, type ConsumerBinding,
  type ConsumerUse, type Diagnostic, type Finding, type HttpMethod,
  type ResourceLimits, type ScanOptions, type ScanResult, type WrapperReference, type Confidence,
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

// Set once per source file before visiting it or analyzing wrapper declarations in it; lets evaluate()/
// objectExpression() resolve a never-reassigned `let` the same way as a `const` (see collectResolvableLets).
let resolvableLets = new Set<ts.Symbol>();

export function range(source: ts.SourceFile, node: ts.Node): CodeRange {
  const start = node.getStart(source);
  const pos = source.getLineAndCharacterOfPosition(start);
  return { start, end: node.getEnd(), line: pos.line + 1, column: pos.character + 1 };
}

export function literal(node: ts.Node): string | undefined {
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

// A declaration this static analysis may treat as immutable: an explicit `const`, or a module-local
// `let` proven (collectResolvableLets) never reassigned, incremented, or exported anywhere in the file.
function isResolvableDeclaration(declaration: ts.Declaration, symbol: ts.Symbol): declaration is ts.VariableDeclaration {
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  if (declaration.parent.flags & ts.NodeFlags.Const) return true;
  return (declaration.parent.flags & ts.NodeFlags.Let) !== 0 && resolvableLets.has(symbol);
}

// Object literal semantics: the last definition wins; spreads, unresolved computed keys,
// methods and accessors make the property unknown unless a later member defines it.
export function property(object: ts.ObjectLiteralExpression | undefined, name: string, checker: ts.TypeChecker, depth = 0): Property {
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

export function propertyValue(object: ts.ObjectLiteralExpression | undefined, name: string, checker: ts.TypeChecker): ts.Expression | undefined {
  const found = property(object, name, checker);
  return found.kind === 'value' ? found.node : undefined;
}

export function objectExpression(node: ts.Expression | undefined, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): ts.ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return objectExpression(node.expression, checker, seen);
  if (ts.isObjectLiteralExpression(node)) return node;
  if (!ts.isIdentifier(node)) return undefined;
  const symbol = valueSymbol(node, checker);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (isResolvableDeclaration(declaration, symbol)) return objectExpression(declaration.initializer, checker, seen);
  }
  return undefined;
}

export function evaluate(node: ts.Expression | undefined, checker: ts.TypeChecker, depth = 0, seen = new Set<ts.Symbol>()): Eval | undefined {
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
      if (isResolvableDeclaration(declaration, symbol)) return evaluate(declaration.initializer, checker, depth + 1, seen);
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

export function clientOf(node: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): Client | undefined {
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

// `JSON.stringify(x)` unwraps to `x`: the scanner reads the value that was serialized, not the call.
function unwrapJsonStringify(node: ts.Expression): ts.Expression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'JSON'
    && node.expression.name.text === 'stringify' && node.arguments[0] ? node.arguments[0] : node;
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
  const unwrappedBody = body && unwrapJsonStringify(body);
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

// ---------------------------------------------------------------------------------------------
// Direct call-shape extraction, shared between a top-level fetch/axios call and the single
// recognized call inside a wrapper's body (see src/scan/WRAPPERS.md).
// ---------------------------------------------------------------------------------------------

interface CallShape {
  client: Client;
  method?: HttpMethod;
  methodUnknown: boolean;
  urlNode?: ts.Expression;
  config?: ts.ObjectLiteralExpression;
  configArgNode?: ts.Expression;
  configOpaque: boolean;
  body?: ts.Expression;
  base?: string;
  baseUnknown: boolean;
  baseUncertain: boolean;
}

function extractCallShape(node: ts.CallExpression, checker: ts.TypeChecker, baseUrl: string | undefined, clientOverride?: Client): CallShape | undefined {
  let client: Client | undefined = clientOverride;
  let method: HttpMethod | undefined;
  let urlNode: ts.Expression | undefined;
  let config: ts.ObjectLiteralExpression | undefined;
  let configArgNode: ts.Expression | undefined;
  let configOpaque = false;
  let body: ts.Expression | undefined;
  let methodUnknown = false;
  const configAt = (index: number) => {
    configArgNode = node.arguments[index];
    config = objectExpression(configArgNode, checker);
    configOpaque = !!configArgNode && !config;
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
    client ??= clientOf(node.expression.expression, checker);
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
    client ??= clientOf(node.expression, checker);
    if (client?.kind === 'fetch') {
      urlNode = node.arguments[0];
      configAt(1);
      readMethod('get');
      body = propertyValue(config, 'body', checker);
    } else if (client?.kind === 'axios') {
      const first = node.arguments[0];
      if (first && !objectExpression(first, checker) && evaluate(first, checker)) { urlNode = first; configAt(1); }
      else configAt(0);
    }
  }
  if (!client) return undefined;
  let base = baseUrl;
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
    else base = client.base ?? baseUrl;
  }
  return { client, method, methodUnknown, urlNode, config, configArgNode, configOpaque, body, base, baseUnknown, baseUncertain };
}

// ---------------------------------------------------------------------------------------------
// Finding/use assembly shared between direct calls and resolved wrapper call sites.
// ---------------------------------------------------------------------------------------------

interface FinalizeInput {
  sf: ts.SourceFile; checker: ts.TypeChecker; relative: string; fileHash: string; node: ts.CallExpression;
  client: Client; method: HttpMethod | undefined; methodUnknown: boolean;
  urlNode: ts.Expression | undefined; url: Eval | undefined; urlExpressionText: string;
  base: string | undefined; baseUnknown: boolean; baseUncertain: boolean; scanBaseUrl: string | undefined;
  config: ts.ObjectLiteralExpression | undefined; body: ts.Expression | undefined;
  uniqueOperations: ApiOperation[]; apiBase: URL | undefined; changes: ApiChange[]; via?: WrapperReference;
}

// Always computes the plain, non-suppressed result — including for the single recognized call
// inside a wrapper's own body, which is treated exactly like a direct call of the same shape here.
// Suppressing its findings is a separate, conditional step (see suppressSafeWrapperDefinitions)
// applied after the whole repository has been scanned, once every one of its own-file call sites'
// resolutions is known.
function finalizeUse(input: FinalizeInput): { use: ConsumerUse; findings: Finding[] } {
  const { sf, checker, relative, fileHash, node, client, method, methodUnknown, urlNode, url, urlExpressionText, base, baseUnknown, baseUncertain, config, body, uniqueOperations, apiBase, changes, via } = input;
  let value = url?.value;
  if (url?.unknownPrefix) value = url.value.slice(url.unknownPrefix.length);
  const relativeValue = value !== undefined && !isAbsoluteUrl(value);
  // Unknown prefix or base: only the observed path is known, so matches are review hints.
  const hint = !!url?.unknownPrefix || (client.kind === 'axios' && baseUnknown && relativeValue);
  const parsed = value === undefined ? undefined
    : hint ? (value.startsWith('/') ? resolveUrl(value) : undefined)
    : client.kind === 'axios' && relativeValue && base ? resolveUrl(combineUrls(base, value), input.scanBaseUrl)
    : resolveUrl(value, input.scanBaseUrl);
  const matches = parsed ? matchingOperations(uniqueOperations, parsed.pathname, hint ? undefined : parsed.origin, method, apiBase, hint) : [];
  const originUnconfirmed = matches.some(match => !match.originConfirmed);
  const operationIds = [...new Set(matches.map(match => match.operation.id))].sort();
  const resolution = !url || !parsed || !method || methodUnknown || hint ? 'unresolved'
    : matches.length === 1 && !url.dynamic && !originUnconfirmed && !baseUncertain ? 'resolved' : 'partial';
  let confidence: Confidence = resolution === 'resolved' ? 'high' : resolution === 'partial' && !originUnconfirmed && !baseUncertain ? 'medium' : 'low';
  // Scope rule: a call resolved only through a wrapper (or an imported axios instance) is never high confidence.
  if (via && confidence === 'high') confidence = 'medium';
  const baseReason = !url ? 'URL expression could not be resolved statically'
    : !parsed ? (url.unknownPrefix ? 'URL starts with a value that could not be resolved statically' : 'URL or base could not be interpreted')
    : !method || methodUnknown ? 'HTTP method could not be resolved statically'
    : hint ? `${url.unknownPrefix ? 'URL base comes from a value' : 'axios baseURL'} that could not be resolved statically; path matches are review hints only`
    : !matches.length ? 'No operation matched the URL, origin, path and method'
    : matches.length > 1 ? 'Several operations match the known URL and method'
    : originUnconfirmed ? `Path matches an operation whose server has no origin; call origin ${parsed.origin} is not confirmed by the server or a known base URL`
    : baseUncertain ? 'axios request config is not statically known and may override baseURL'
    : url.dynamic ? 'Path contains a dynamic template value' : 'Literal or immutable URL, method and operation matched';
  const reason = via ? `${baseReason} (wrapper '${via.name}')` : baseReason;
  const use: ConsumerUse = {
    id: stableId('use', { file: relative, start: node.getStart(sf), end: node.getEnd(), client: client.kind }),
    file: relative, fileHash, range: range(sf, node), client: client.kind,
    urlExpression: urlExpressionText, ...(parsed ? { url: parsed.url, ...(parsed.origin ? { origin: parsed.origin } : {}) } : {}),
    ...(method ? { method } : {}), operationIds,
    bindings: bindingsFor(sf, checker, url, urlNode, parsed?.query, body), resolution, confidence, reason,
    ...(via ? { via } : {}),
  };
  const findings: Finding[] = [];
  for (const change of changes) {
    if (change.classification === 'compatible') continue;
    if (!matches.some(({ operation }) => operation.id === change.operationId || operation.operationId === change.operationId)) continue;
    findings.push({
      id: stableId('finding', { change: change.id, use: use.id }), changeId: change.id, useId: use.id,
      consequence: `${change.classification === 'breaking' ? 'Potential break' : 'Review needed'}: ${change.explanation}`,
      evidence: [
        { kind: 'ast', message: `HTTP ${method ?? 'unknown'} call; ${reason}`, file: relative, range: use.range },
        ...change.evidence,
      ],
      confidence: change.classification === 'ambiguous' || confidence === 'low' ? 'low' : confidence,
      reviewStatus: 'pending',
    });
  }
  return { use, findings };
}

// ---------------------------------------------------------------------------------------------
// Never-reassigned `let` detection (src/scan/WRAPPERS.md, rule 3).
// ---------------------------------------------------------------------------------------------

function collectResolvableLets(source: ts.SourceFile, checker: ts.TypeChecker): Set<ts.Symbol> {
  const letSymbols = new Set<ts.Symbol>();
  function hasExportModifier(node: ts.VariableStatement): boolean {
    return !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  function visitDecls(node: ts.Node): void {
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Let) && !hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const symbol = checker.getSymbolAtLocation(decl.name);
          if (symbol) letSymbols.add(symbol);
        }
      }
    }
    ts.forEachChild(node, visitDecls);
  }
  visitDecls(source);
  if (letSymbols.size === 0) return letSymbols;
  const unstable = new Set<ts.Symbol>();
  function markTarget(expr: ts.Expression): void {
    if (ts.isParenthesizedExpression(expr)) { markTarget(expr.expression); return; }
    if (ts.isIdentifier(expr)) { const symbol = checker.getSymbolAtLocation(expr); if (symbol) unstable.add(symbol); return; }
    if (ts.isArrayLiteralExpression(expr)) { for (const el of expr.elements) { if (!ts.isOmittedExpression(el)) markTarget(ts.isSpreadElement(el) ? el.expression : el); } return; }
    if (ts.isObjectLiteralExpression(expr)) {
      for (const p of expr.properties) {
        if (ts.isShorthandPropertyAssignment(p)) markTarget(p.name);
        else if (ts.isPropertyAssignment(p)) markTarget(p.initializer);
        else if (ts.isSpreadAssignment(p)) markTarget(p.expression);
      }
    }
  }
  function visitMutations(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) markTarget(node.left);
    else if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) markTarget(node.operand);
    else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) markTarget(node.initializer);
    else if (ts.isExportSpecifier(node)) { const symbol = checker.getSymbolAtLocation(node.propertyName ?? node.name); if (symbol) unstable.add(symbol); }
    else if (ts.isExportAssignment(node) && !node.isExportEquals) markTarget(node.expression);
    ts.forEachChild(node, visitMutations);
  }
  visitMutations(source);
  const resolvable = new Set<ts.Symbol>();
  for (const symbol of letSymbols) if (!unstable.has(symbol)) resolvable.add(symbol);
  return resolvable;
}

// ---------------------------------------------------------------------------------------------
// Wrapper recognition and one-hop import resolution (src/scan/WRAPPERS.md).
// ---------------------------------------------------------------------------------------------

type WrapperUrlShape = { kind: 'whole'; param: ts.Symbol } | { kind: 'join'; template: string; param: ts.Symbol; paramName: string };

interface WrapperSpec {
  name: string;
  source: ts.SourceFile;
  declRange: CodeRange;
  params: ts.Symbol[];
  client: Client;
  urlShape: WrapperUrlShape;
  fixedMethod?: HttpMethod;
  configForwardedParam?: ts.Symbol;
  bodyForwardedParam?: ts.Symbol;
  callNode: ts.CallExpression;
  // The wrapper's own binding (undefined only for an anonymous `export default (...) => ...`,
  // which is exported by construction). Used to find every other same-file reference to it.
  symbol?: ts.Symbol;
  declNameNode?: ts.Node;
  // True when the wrapper is reachable from outside its own file: `export`, an `export { }` list,
  // a default export, or a CommonJS `module.exports`/`exports.x` assignment.
  exported: boolean;
  // Every same-file reference to `symbol` (other than the declaration) that is a direct call of it;
  // `selfReferencesDisqualified` is true if any same-file reference is NOT such a call (passed as a
  // value, stored, `.call`/`.apply`/`.bind`, etc.) — see suppressSafeWrapperDefinitions.
  selfReferenceCalls: ts.CallExpression[];
  selfReferencesDisqualified: boolean;
}

interface AxiosInstanceSpec { client: Client; declRange: CodeRange }

interface WrapperIndex {
  byDeclSymbol: Map<ts.Symbol, WrapperSpec>;
  byFileAndName: Map<string, Map<string, WrapperSpec>>;
  instanceByFileAndName: Map<string, Map<string, AxiosInstanceSpec>>;
  // Every wrapper spec created while building this index, each listed once regardless of how many
  // names/keys it is registered under (own name, 'default', re-export alias, ...).
  allSpecs: WrapperSpec[];
}

function unwrapTrivial(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return unwrapTrivial(node.expression);
  return node;
}

function paramRef(node: ts.Expression | undefined, paramSet: Set<ts.Symbol>, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!node) return undefined;
  const unwrapped = unwrapTrivial(node);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  return symbol && paramSet.has(symbol) ? symbol : undefined;
}

// The URL is exactly a wrapper parameter, or a resolvable base (literal/immutable constant)
// joined to exactly one parameter by `+` or a template literal.
function analyzeWrapperUrl(node: ts.Expression, checker: ts.TypeChecker, paramSet: Set<ts.Symbol>): WrapperUrlShape | undefined {
  const unwrapped = unwrapTrivial(node);
  const whole = paramRef(unwrapped, paramSet, checker);
  if (whole) return { kind: 'whole', param: whole };
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // Only `base + param`: a bare leading identifier (`param + base`) is already treated elsewhere
    // (evaluate()'s unknownPrefix case) as an unknown base, not a path variable — keep both conventions
    // aligned rather than letting a wrapper reinterpret the same shape as resolvable.
    const rightParam = paramRef(unwrapped.right, paramSet, checker);
    if (rightParam) {
      const base = evaluate(unwrapped.left, checker);
      const name = (unwrapTrivial(unwrapped.right) as ts.Identifier).text;
      if (base && !base.dynamic) return { kind: 'join', template: base.value + `{${name}}`, param: rightParam, paramName: name };
    }
    return undefined;
  }
  if (ts.isTemplateExpression(unwrapped)) {
    // A parameter as the very first, unprefixed span (`${base}/x`) is the same unknown-base shape
    // evaluate() already treats specially elsewhere; keep it unresolved rather than a path variable.
    if (!unwrapped.head.text && paramRef(unwrapped.templateSpans[0]?.expression, paramSet, checker)) return undefined;
    let template = unwrapped.head.text;
    let param: ts.Symbol | undefined;
    let paramName = '';
    for (const span of unwrapped.templateSpans) {
      const p = paramRef(span.expression, paramSet, checker);
      if (p) {
        if (param) return undefined; // at most one hole: soundness over coverage
        param = p;
        paramName = (unwrapTrivial(span.expression) as ts.Identifier).text;
        template += `{${paramName}}`;
      } else {
        const resolved = evaluate(span.expression, checker);
        if (!resolved || resolved.dynamic) return undefined;
        template += resolved.value;
      }
      template += span.literal.text;
    }
    if (!param) return undefined;
    return { kind: 'join', template, param, paramName };
  }
  return undefined;
}

function analyzeWrapperCall(call: ts.CallExpression, checker: ts.TypeChecker, paramSet: Set<ts.Symbol>): Pick<WrapperSpec, 'client' | 'urlShape' | 'fixedMethod' | 'configForwardedParam' | 'bodyForwardedParam' | 'callNode'> | undefined {
  const shape = extractCallShape(call, checker, undefined);
  if (!shape) return undefined;
  const { client, urlNode, config, configArgNode, body, method, methodUnknown } = shape;
  if (!urlNode) return undefined;
  const urlShape = analyzeWrapperUrl(urlNode, checker, paramSet);
  if (!urlShape) return undefined;
  const axiosShorthand = ts.isPropertyAccessExpression(call.expression) && client.kind === 'axios' ? call.expression.name.text : undefined;
  let fixedMethod: HttpMethod | undefined;
  let configForwardedParam: ts.Symbol | undefined;
  let bodyForwardedParam: ts.Symbol | undefined;
  if (axiosShorthand && axiosShorthand !== 'request') fixedMethod = normalizeMethod(axiosShorthand);
  else if (!methodUnknown && method) fixedMethod = method;
  if (configArgNode && !config) {
    const p = paramRef(configArgNode, paramSet, checker);
    if (p) configForwardedParam = p;
  }
  if (!configForwardedParam && body) {
    const p = paramRef(unwrapJsonStringify(body), paramSet, checker);
    if (p) bodyForwardedParam = p;
  }
  return { client, urlShape, fixedMethod, configForwardedParam, bodyForwardedParam, callNode: call };
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return !!ts.getModifiers(node)?.some(m => m.kind === kind);
}

function detectWrapperFromFunction(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, name: string, nameRangeNode: ts.Node, source: ts.SourceFile, checker: ts.TypeChecker): WrapperSpec | undefined {
  if (fn.parameters.some(p => p.dotDotDotToken || p.initializer || !ts.isIdentifier(p.name))) return undefined;
  const params: ts.Symbol[] = [];
  for (const p of fn.parameters) {
    const symbol = checker.getSymbolAtLocation(p.name as ts.Identifier);
    if (!symbol) return undefined;
    params.push(symbol);
  }
  const body = fn.body;
  if (!body) return undefined;
  let expr: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return undefined;
    const stmt = body.statements[0];
    if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) return undefined;
    expr = stmt.expression;
  } else {
    expr = body;
  }
  if (ts.isAwaitExpression(expr)) expr = expr.expression;
  if (!ts.isCallExpression(expr)) return undefined;
  const shape = analyzeWrapperCall(expr, checker, new Set(params));
  if (!shape) return undefined;
  const symbol = ts.isIdentifier(nameRangeNode) ? checker.getSymbolAtLocation(nameRangeNode) : undefined;
  return {
    name, source, declRange: range(source, nameRangeNode), params, ...shape,
    symbol, declNameNode: ts.isIdentifier(nameRangeNode) ? nameRangeNode : undefined,
    exported: false, selfReferenceCalls: [], selfReferencesDisqualified: false,
  };
}

// Finds every export of a module-local binding: an `export` modifier, an `export { name }` list
// (not a re-export), `export default name`, or a CommonJS `module.exports`/`exports.x = name`.
function collectExportedSymbols(source: ts.SourceFile, checker: ts.TypeChecker): Set<ts.Symbol> {
  const exported = new Set<ts.Symbol>();
  const addIdentifier = (expr: ts.Expression | undefined): void => {
    if (expr && ts.isIdentifier(expr)) { const symbol = checker.getSymbolAtLocation(expr); if (symbol) exported.add(symbol); }
  };
  for (const stmt of source.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isVariableStatement(stmt)) && hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(stmt)) addIdentifier(stmt.name);
      else for (const decl of stmt.declarationList.declarations) addIdentifier(ts.isIdentifier(decl.name) ? decl.name : undefined);
    }
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) addIdentifier(spec.propertyName ?? spec.name);
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) addIdentifier(stmt.expression);
  }
  const isExportsTarget = (expr: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(expr)) return false;
    if (ts.isIdentifier(expr.expression) && expr.expression.text === 'exports') return true;
    if (ts.isIdentifier(expr.expression) && expr.expression.text === 'module' && expr.name.text === 'exports') return true;
    return ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
      && expr.expression.expression.text === 'module' && expr.expression.name.text === 'exports';
  };
  function visitCjs(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isExportsTarget(node.left)) addIdentifier(node.right);
    ts.forEachChild(node, visitCjs);
  }
  visitCjs(source);
  return exported;
}

// Every same-file reference to `symbol` other than its own declaration, classified as a direct
// call of it or not (see WrapperSpec.selfReferencesDisqualified).
function findSelfReferences(source: ts.SourceFile, symbol: ts.Symbol, declNameNode: ts.Node, checker: ts.TypeChecker): { calls: ts.CallExpression[]; disqualified: boolean } {
  const calls: ts.CallExpression[] = [];
  let disqualified = false;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node !== declNameNode && checker.getSymbolAtLocation(node) === symbol) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) calls.push(parent);
      else disqualified = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { calls, disqualified };
}

function buildWrapperIndex(sourceFiles: ts.SourceFile[], checker: ts.TypeChecker, resolvableLetsByFile: Map<ts.SourceFile, Set<ts.Symbol>>): WrapperIndex {
  const index: WrapperIndex = { byDeclSymbol: new Map(), byFileAndName: new Map(), instanceByFileAndName: new Map(), allSpecs: [] };
  for (const source of sourceFiles) {
    resolvableLets = resolvableLetsByFile.get(source) ?? new Set();
    const wrapperNames = new Map<string, WrapperSpec>();
    const instanceNames = new Map<string, AxiosInstanceSpec>();
    const specsThisFile: WrapperSpec[] = [];
    for (const stmt of source.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
        const declName = stmt.name?.text ?? 'default';
        const spec = detectWrapperFromFunction(stmt, declName, stmt.name ?? stmt, source, checker);
        if (spec) {
          wrapperNames.set(declName, spec);
          if (isDefault) wrapperNames.set('default', spec);
          if (stmt.name) { const symbol = checker.getSymbolAtLocation(stmt.name); if (symbol) index.byDeclSymbol.set(symbol, spec); }
          specsThisFile.push(spec);
        }
        continue;
      }
      if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const name = decl.name.text;
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            const spec = detectWrapperFromFunction(decl.initializer, name, decl.name, source, checker);
            if (spec) {
              wrapperNames.set(name, spec);
              const symbol = checker.getSymbolAtLocation(decl.name);
              if (symbol) index.byDeclSymbol.set(symbol, spec);
              specsThisFile.push(spec);
            }
            continue;
          }
          const client = clientOf(decl.initializer, checker);
          if (client?.kind === 'axios') instanceNames.set(name, { client, declRange: range(source, decl.name) });
        }
        continue;
      }
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const expr = stmt.expression;
        if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
          const spec = detectWrapperFromFunction(expr, 'default', expr.name ?? stmt, source, checker);
          if (spec) { wrapperNames.set('default', spec); specsThisFile.push(spec); }
        } else if (ts.isIdentifier(expr)) {
          const existing = wrapperNames.get(expr.text);
          if (existing) wrapperNames.set('default', existing);
        }
      }
    }
    if (wrapperNames.size) index.byFileAndName.set(source.fileName, wrapperNames);
    if (instanceNames.size) index.instanceByFileAndName.set(source.fileName, instanceNames);
    if (specsThisFile.length) {
      const exportedSymbols = collectExportedSymbols(source, checker);
      for (const spec of specsThisFile) {
        spec.exported = spec.symbol ? exportedSymbols.has(spec.symbol) : true;
        if (spec.symbol && spec.declNameNode) {
          const { calls, disqualified } = findSelfReferences(source, spec.symbol, spec.declNameNode, checker);
          spec.selfReferenceCalls = calls;
          spec.selfReferencesDisqualified = disqualified;
        }
        index.allSpecs.push(spec);
      }
    }
  }
  return index;
}

interface ImportTarget { specifier: string; importedName: string; fromFile: string }

function importDeclarationOf(node: ts.Node): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  for (let i = 0; i < 4 && current; i++) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

// Resolves a same-file symbol to the one relative import (static ES import or CJS require
// destructure) that introduced it. Package imports and non-relative specifiers are rejected here.
function resolveImportTarget(symbol: ts.Symbol): ImportTarget | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
      const importDecl = importDeclarationOf(declaration);
      const specifier = importDecl && literal(importDecl.moduleSpecifier);
      if (!specifier || !(specifier.startsWith('./') || specifier.startsWith('../'))) continue;
      const importedName = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : 'default';
      return { specifier, importedName, fromFile: declaration.getSourceFile().fileName };
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const varDecl = declaration.parent.parent;
      if (ts.isVariableDeclaration(varDecl) && varDecl.initializer && ts.isCallExpression(varDecl.initializer)
        && ts.isIdentifier(varDecl.initializer.expression) && varDecl.initializer.expression.text === 'require'
        && varDecl.initializer.arguments.length === 1) {
        const specifier = literal(varDecl.initializer.arguments[0]!);
        const importedName = declaration.propertyName ?? declaration.name;
        if (!specifier || !(specifier.startsWith('./') || specifier.startsWith('../')) || !ts.isIdentifier(importedName)) continue;
        return { specifier, importedName: importedName.text, fromFile: declaration.getSourceFile().fileName };
      }
    }
  }
  return undefined;
}

// Minimal NodeNext-style resolver, matched only against files already loaded by this scan
// (so excluded, oversize or symlinked files and anything outside the repository are rejected).
function resolveModuleFile(fromFile: string, specifier: string, filesByPath: Map<string, ts.SourceFile>): ts.SourceFile | undefined {
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const ext = path.extname(resolved);
  const swap: Record<string, string[]> = { '.js': ['.ts', '.tsx', '.mts'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
  const candidates: string[] = [];
  if (ext && swap[ext]) candidates.push(...swap[ext].map(e => resolved.slice(0, -ext.length) + e));
  if (ext && EXTENSIONS.has(ext)) candidates.push(resolved);
  if (!ext) {
    for (const e of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(resolved + e);
    for (const e of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']) candidates.push(path.join(resolved, 'index' + e));
  }
  for (const candidate of candidates) { const found = filesByPath.get(candidate); if (found) return found; }
  return undefined;
}

function toRepoRelative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join('/');
}

function findWrapperForCallee(expr: ts.Expression, checker: ts.TypeChecker, index: WrapperIndex, filesByPath: Map<string, ts.SourceFile>): WrapperSpec | undefined {
  if (!ts.isIdentifier(expr)) return undefined;
  const symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  const direct = index.byDeclSymbol.get(symbol);
  if (direct) return direct;
  const imported = resolveImportTarget(symbol);
  if (!imported) return undefined;
  const target = resolveModuleFile(imported.fromFile, imported.specifier, filesByPath);
  if (!target) return undefined;
  return index.byFileAndName.get(target.fileName)?.get(imported.importedName);
}

function resolveImportedAxiosInstance(expr: ts.Expression, checker: ts.TypeChecker, index: WrapperIndex, filesByPath: Map<string, ts.SourceFile>, root: string): { client: Client; via: WrapperReference } | undefined {
  if (!ts.isIdentifier(expr)) return undefined;
  const symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  const imported = resolveImportTarget(symbol);
  if (!imported) return undefined;
  const target = resolveModuleFile(imported.fromFile, imported.specifier, filesByPath);
  if (!target) return undefined;
  const found = index.instanceByFileAndName.get(target.fileName)?.get(imported.importedName);
  if (!found) return undefined;
  return { client: found.client, via: { name: imported.importedName, file: toRepoRelative(root, target.fileName), range: found.declRange } };
}

function resolveWrapperCallDetails(spec: WrapperSpec, call: ts.CallExpression, checker: ts.TypeChecker, scanBaseUrl: string | undefined) {
  let config: ts.ObjectLiteralExpression | undefined;
  let configOpaque = false;
  let method = spec.fixedMethod;
  let methodUnknown = method === undefined;
  let body: ts.Expression | undefined;
  if (spec.configForwardedParam) {
    const index = spec.params.indexOf(spec.configForwardedParam);
    const argNode = index >= 0 ? call.arguments[index] : undefined;
    config = objectExpression(argNode, checker);
    configOpaque = !!argNode && !config;
    if (method === undefined) {
      const prop = configOpaque ? { kind: 'unknown' } as Property : property(config, 'method', checker);
      if (prop.kind === 'absent') { method = 'get'; methodUnknown = false; }
      else if (prop.kind === 'value') {
        const val = evaluate(prop.node, checker);
        method = val && !val.dynamic ? normalizeMethod(val.value) : undefined;
        methodUnknown = !method;
      } else methodUnknown = true;
    }
    body = configOpaque ? undefined : propertyValue(config, spec.client.kind === 'fetch' ? 'body' : 'data', checker);
  } else if (spec.bodyForwardedParam) {
    const index = spec.params.indexOf(spec.bodyForwardedParam);
    body = index >= 0 ? call.arguments[index] : undefined;
  }
  let base = scanBaseUrl;
  let baseUnknown = false;
  const baseUncertain = configOpaque;
  if (spec.client.kind === 'axios') {
    const requestBase = configOpaque ? { kind: 'unknown' } as Property : property(config, 'baseURL', checker);
    if (requestBase.kind === 'value') { base = staticBase(evaluate(requestBase.node, checker)); baseUnknown = base === undefined; }
    else if (requestBase.kind === 'unknown' && !configOpaque) baseUnknown = true;
    else if (spec.client.baseUnknown) { base = undefined; baseUnknown = true; }
    else base = spec.client.base ?? scanBaseUrl;
  }
  return { method, methodUnknown, config, body, base, baseUnknown, baseUncertain };
}

function resolveWrapperUrl(spec: WrapperSpec, call: ts.CallExpression, checker: ts.TypeChecker, sf: ts.SourceFile): { url: Eval | undefined; urlNode: ts.Expression | undefined; urlExpressionText: string } {
  const index = spec.params.indexOf(spec.urlShape.param);
  const argNode = index >= 0 ? call.arguments[index] : undefined;
  if (!argNode) return { url: undefined, urlNode: undefined, urlExpressionText: '' };
  if (spec.urlShape.kind === 'whole') return { url: evaluate(argNode, checker), urlNode: argNode, urlExpressionText: argNode.getText(sf) };
  const placeholder = `{${spec.urlShape.paramName}}`;
  const resolved = evaluate(argNode, checker);
  const combinedText = spec.urlShape.template.replace(placeholder, argNode.getText(sf));
  if (resolved) return { url: { value: spec.urlShape.template.replace(placeholder, resolved.value), dynamic: resolved.dynamic, parts: resolved.parts }, urlNode: undefined, urlExpressionText: combinedText };
  return { url: { value: spec.urlShape.template, dynamic: true, parts: [{ name: spec.urlShape.paramName, node: argNode }] }, urlNode: undefined, urlExpressionText: combinedText };
}

interface ResolvedViaCall {
  client: Client; method: HttpMethod | undefined; methodUnknown: boolean;
  urlNode: ts.Expression | undefined; url: Eval | undefined; urlExpressionText: string;
  base: string | undefined; baseUnknown: boolean; baseUncertain: boolean;
  config: ts.ObjectLiteralExpression | undefined; body: ts.Expression | undefined; via: WrapperReference;
}

function resolveWrapperCall(node: ts.CallExpression, sf: ts.SourceFile, checker: ts.TypeChecker, index: WrapperIndex, filesByPath: Map<string, ts.SourceFile>, root: string, scanBaseUrl: string | undefined): ResolvedViaCall | undefined {
  if (!ts.isIdentifier(node.expression)) return undefined;
  const spec = findWrapperForCallee(node.expression, checker, index, filesByPath);
  if (!spec) return undefined;
  const { url, urlNode, urlExpressionText } = resolveWrapperUrl(spec, node, checker, sf);
  const details = resolveWrapperCallDetails(spec, node, checker, scanBaseUrl);
  return {
    client: spec.client, method: details.method, methodUnknown: details.methodUnknown,
    urlNode, url, urlExpressionText, base: details.base, baseUnknown: details.baseUnknown, baseUncertain: details.baseUncertain,
    config: details.config, body: details.body,
    via: { name: spec.name, file: toRepoRelative(root, spec.source.fileName), range: spec.declRange },
  };
}

function resolveImportedAxiosInstanceCall(node: ts.CallExpression, sf: ts.SourceFile, checker: ts.TypeChecker, index: WrapperIndex, filesByPath: Map<string, ts.SourceFile>, root: string, scanBaseUrl: string | undefined): ResolvedViaCall | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const instance = resolveImportedAxiosInstance(node.expression.expression, checker, index, filesByPath, root);
  if (!instance) return undefined;
  const shape = extractCallShape(node, checker, scanBaseUrl, instance.client);
  if (!shape) return undefined;
  const url = evaluate(shape.urlNode, checker);
  return {
    client: shape.client, method: shape.method, methodUnknown: shape.methodUnknown,
    urlNode: shape.urlNode, url, urlExpressionText: shape.urlNode?.getText(sf) ?? '',
    base: shape.base, baseUnknown: shape.baseUnknown, baseUncertain: shape.baseUncertain,
    config: shape.config, body: shape.body, via: instance.via,
  };
}

// ---------------------------------------------------------------------------------------------

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
    'Repository-local wrappers are resolved only for a single recognized call, same file or one relative import hop, with confidence capped at medium; see src/scan/WRAPPERS.md.',
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
  const allCallUses = new Map<ts.CallExpression, ConsumerUse>();
  const operations = [...options.oldApi.operations, ...options.newApi.operations];
  const uniqueOperations = [...new Map(operations.map(operation => [operation.id, operation])).values()];
  const apiBase = httpUrl(options.baseUrl);
  const begin = Date.now();

  const sourceFiles = readableFiles.map(file => program.getSourceFile(file)).filter((sf): sf is ts.SourceFile => !!sf);
  const filesByPath = new Map(sourceFiles.map(sf => [sf.fileName, sf]));
  const resolvableLetsByFile = new Map(sourceFiles.map(sf => [sf, collectResolvableLets(sf, checker)]));
  const wrapperIndex = buildWrapperIndex(sourceFiles, checker, resolvableLetsByFile);

  for (const file of readableFiles) {
    if (options.signal?.aborted) throw new Error('Scan aborted');
    if (Date.now() - begin > limits.timeoutMs) { diagnostics.push({ code: 'SCAN_TIMEOUT', severity: 'warning', message: 'Analysis time limit reached' }); break; }
    const source = program.getSourceFile(file);
    if (!source) continue;
    const sf = source;
    resolvableLets = resolvableLetsByFile.get(sf) ?? new Set();
    const relative = path.relative(root, file).split(path.sep).join('/');
    const fileHash = sha256(contents.get(file)!);
    const callUses = new Map<ts.CallExpression, ConsumerUse>();
    for (const error of program.getSyntacticDiagnostics(sf)) diagnostics.push({ code: 'SCAN_PARSE_ERROR', severity: 'warning', message: ts.flattenDiagnosticMessageText(error.messageText, '\n'), file: relative });
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const shape = extractCallShape(node, checker, options.baseUrl);
        const resolvedVia = shape ? undefined
          : resolveWrapperCall(node, sf, checker, wrapperIndex, filesByPath, root, options.baseUrl)
          ?? resolveImportedAxiosInstanceCall(node, sf, checker, wrapperIndex, filesByPath, root, options.baseUrl);
        if (shape || resolvedVia) {
          const url = shape ? evaluate(shape.urlNode, checker) : resolvedVia!.url;
          const { use, findings: newFindings } = finalizeUse({
            sf, checker, relative, fileHash, node,
            client: (shape ?? resolvedVia!).client,
            method: (shape ?? resolvedVia!).method, methodUnknown: (shape ?? resolvedVia!).methodUnknown,
            urlNode: shape ? shape.urlNode : resolvedVia!.urlNode, url,
            urlExpressionText: shape ? (shape.urlNode?.getText(sf) ?? '') : resolvedVia!.urlExpressionText,
            base: (shape ?? resolvedVia!).base, baseUnknown: (shape ?? resolvedVia!).baseUnknown, baseUncertain: (shape ?? resolvedVia!).baseUncertain,
            scanBaseUrl: options.baseUrl,
            config: (shape ?? resolvedVia!).config, body: (shape ?? resolvedVia!).body,
            uniqueOperations, apiBase, changes: options.changes,
            ...(resolvedVia ? { via: resolvedVia.via } : {}),
          });
          uses.push(use);
          callUses.set(node, use);
          allCallUses.set(node, use);
          if (use.resolution !== 'resolved') diagnostics.push({ code: 'SCAN_REVIEW_REQUIRED', severity: 'warning', message: use.reason, file: relative });
          findings.push(...newFindings);
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
  suppressSafeWrapperDefinitions(wrapperIndex, allCallUses, findings, root);
  uses.sort((a, b) => a.file.localeCompare(b.file) || a.range.start - b.range.start);
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: SCHEMA_VERSION, uses, findings, diagnostics, limitations };
}

// For a module-local (never exported) wrapper whose every same-file reference is itself a call
// that resolved through this wrapper, the wrapper's own internal call cannot be reached any other
// way, so reporting it too would duplicate the finding(s) already attached to its call sites: its
// own use is downgraded to unresolved/low with no operation matches, and any findings already
// generated for it are dropped. An exported wrapper, one with no provably-covered callers, or one
// referenced any other way (stored, passed as a value, `.call`/`.apply`/`.bind`, ...) keeps exactly
// the same resolution/confidence/operationIds/findings a direct call of that shape would get — see
// "Duplicates" in src/scan/WRAPPERS.md.
function suppressSafeWrapperDefinitions(index: WrapperIndex, allCallUses: Map<ts.CallExpression, ConsumerUse>, findings: Finding[], root: string): void {
  for (const spec of index.allSpecs) {
    if (spec.exported || spec.selfReferencesDisqualified) continue;
    const specFile = toRepoRelative(root, spec.source.fileName);
    const allCoveredByThisWrapper = spec.selfReferenceCalls.every(call => {
      const use = allCallUses.get(call);
      return use?.resolution === 'resolved' && use.via?.name === spec.name && use.via?.file === specFile;
    });
    if (!allCoveredByThisWrapper) continue;
    const internalUse = allCallUses.get(spec.callNode);
    if (!internalUse || internalUse.via) continue;
    internalUse.operationIds = [];
    internalUse.resolution = 'unresolved';
    internalUse.confidence = 'low';
    internalUse.reason = `Call inside wrapper '${spec.name}'; every call site in this file already resolved through it, so findings are reported there instead`;
    for (let i = findings.length - 1; i >= 0; i--) if (findings[i]!.useId === internalUse.id) findings.splice(i, 1);
  }
}
