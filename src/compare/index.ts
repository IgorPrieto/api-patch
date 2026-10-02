import type { ApiChange, ApiMediaType, ApiOperation, ApiParameter, ApiResponse, ApiSnapshot, ChangeLocation, Evidence, HttpMethod, JsonValue, SourceLocation } from '../contracts/index.js';
import { canonicalJson, stableId } from '../contracts/index.js';
import { compareSchemas, type Direction, type SchemaIssue } from './schema.js';

export { MAX_SCHEMA_DEPTH } from './schema.js';

/** Known limits of `compareApis`; callers should surface them next to the changes. */
export const COMPARE_LIMITATIONS: readonly string[] = Object.freeze([
  'Schema comparison covers a documented subset of JSON Schema; composition (allOf/anyOf/oneOf/not/if-then-else/discriminator) and uninterpreted keywords are reported as ambiguous when they change, never as safe.',
  'Operations are matched by HTTP method and path template; renamed operations, parameters and properties are reported as removal plus addition and never inferred from similar names.',
  'Security compares effective requirement names and scopes only; security scheme definitions (type, location, flows) are not part of the snapshot and are not compared.',
  'Parameter style/explode, encoding, response headers, links and callbacks are not part of the snapshot and are not compared.',
  'Evidence pointers inside schemas are relative to the normalized (dereferenced) schema; source locations point to the enclosing parameter, media type, response or operation.',
  'Recursive schema back-references are compared by reference text only.',
  'OpenAPI 3.0 nullable and boolean exclusiveMinimum/exclusiveMaximum are normalized against 3.1 type unions and numeric bounds; other dialect differences (for example nullable inside a 3.1 document) are treated as uninterpreted keywords.',
  'Several media type keys that collapse after removing parameters are reported as ambiguous instead of silently selecting one schema.',
]);

const METHODS: HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
type Classification = ApiChange['classification'];
type Direction4 = ApiChange['direction'];

interface Pair { key: string; old?: ApiOperation; new?: ApiOperation }
interface Draft {
  location: ChangeLocation; rule: string; direction: Direction4; classification: Classification; explanation: string;
  before?: SourceLocation; after?: SourceLocation; oldValue?: JsonValue; newValue?: JsonValue; fieldPath?: string[];
  /** Distinguishes several changes with the same rule on one operation; part of the stable ID. */
  scope: string; pointer?: string; notes?: string[];
}

const templateOf = (route: string): string => route.replace(/\{[^}/]*\}/g, '{}');
const pathNames = (route: string): string[] => [...route.matchAll(/\{([^}/]*)\}/g)].map(match => match[1]!);
const render = (value: JsonValue): string => { const text = canonicalJson(value); return text.length > 200 ? `${text.slice(0, 197)}...` : text; };
const sortedKeys = <T>(map: Map<string, T>): string[] => [...map.keys()].sort();

/** Extract only property paths the walker identifies structurally. Arrays and applicators stay manual. */
function schemaFieldPath(issue: SchemaIssue, root: string): string[] | undefined {
  const segments = issue.pointer.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const path: string[] = [];
  let index = 0;
  while (segments[index] === 'properties') {
    const name = segments[index + 1];
    if (name === undefined) return undefined;
    path.push(name);
    index += 2;
  }
  if (segments.slice(index).some(part => part === 'items' || part === 'additionalProperties' || part === 'allOf' || part === 'oneOf' || part === 'anyOf')) return undefined;
  if (segments[index] === 'required' && index === segments.length - 1) {
    const prefix = [root, ...path].join('.') + '.';
    if (!issue.field.startsWith(prefix)) return undefined;
    const name = issue.field.slice(prefix.length);
    return name ? [...path, name] : undefined;
  }
  if (issue.field === root && path.length) return undefined;
  return path;
}

function indexOperations(api: ApiSnapshot): Map<string, ApiOperation> {
  const counts = new Map<string, number>();
  for (const op of api.operations) { const key = `${op.method} ${templateOf(op.path)}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const result = new Map<string, ApiOperation>();
  // Templates that collide inside one document (invalid OpenAPI) fall back to the literal path.
  for (const op of api.operations) { const key = `${op.method} ${templateOf(op.path)}`; result.set((counts.get(key) ?? 0) > 1 ? `${op.method} =${op.path}` : key, op); }
  return result;
}

class Collector {
  private readonly changes: { change: ApiChange; order: number }[] = [];
  private readonly ids = new Set<string>();
  constructor(private readonly pair: Pair) {}
  private get op(): ApiOperation { return (this.pair.old ?? this.pair.new)!; }
  add(draft: Draft): void {
    const op = this.op;
    const identity = { operation: `${op.method} ${op.path}`, rule: draft.rule, location: draft.location, scope: draft.scope, pointer: draft.pointer ?? '' };
    let id = stableId('change', identity);
    for (let n = 1; this.ids.has(id); n++) id = stableId('change', { ...identity, n });
    this.ids.add(id);
    const evidence: Evidence[] = [];
    const at = draft.pointer !== undefined ? ` (normalized schema ${draft.pointer || '/'})` : '';
    if (draft.before) evidence.push({ kind: 'schema', message: `Old contract${at}: ${draft.oldValue === undefined ? 'see source' : render(draft.oldValue)}`, source: draft.before });
    if (draft.after) evidence.push({ kind: 'schema', message: `New contract${at}: ${draft.newValue === undefined ? 'see source' : render(draft.newValue)}`, source: draft.after });
    for (const note of draft.notes ?? []) evidence.push({ kind: 'schema', message: note });
    this.changes.push({
      order: this.changes.length,
      change: {
        id, operationId: op.id, method: op.method, path: op.path, location: draft.location, rule: draft.rule, direction: draft.direction,
        classification: draft.classification, explanation: draft.explanation,
        ...(draft.before ? { before: draft.before } : {}), ...(draft.after ? { after: draft.after } : {}),
        ...(draft.oldValue !== undefined ? { oldValue: draft.oldValue } : {}), ...(draft.newValue !== undefined ? { newValue: draft.newValue } : {}),
        ...(draft.fieldPath !== undefined ? { fieldPath: draft.fieldPath } : {}),
        evidence,
      },
    });
  }
  /** Adapts schema issues to the enclosing parameter, body or response. */
  schema(oldSchema: JsonValue, newSchema: JsonValue, base: { direction: Direction; location: ChangeLocation; scope: string; label: string; root: string; before: SourceLocation; after: SourceLocation; oldVersion: string; newVersion: string }): void {
    compareSchemas(oldSchema, newSchema, {
      direction: base.direction, scope: base.label, root: base.root, oldVersion: base.oldVersion, newVersion: base.newVersion,
      report: (issue: SchemaIssue) => this.add({
        location: base.location, direction: base.direction, rule: issue.rule, classification: issue.classification, explanation: issue.explanation,
        before: base.before, after: base.after, scope: `${base.scope}|${issue.field}`, pointer: issue.pointer,
        ...(schemaFieldPath(issue, base.root) !== undefined ? { fieldPath: schemaFieldPath(issue, base.root) } : {}),
        ...(issue.oldValue !== undefined ? { oldValue: issue.oldValue } : {}), ...(issue.newValue !== undefined ? { newValue: issue.newValue } : {}),
      }),
    });
  }
  result(): ApiChange[] { return this.changes.sort((a, b) => a.order - b.order).map(item => item.change); }
}

class Comparison {
  constructor(private readonly oldApi: ApiSnapshot, private readonly newApi: ApiSnapshot) {}

  run(): ApiChange[] {
    const oldOps = indexOperations(this.oldApi), newOps = indexOperations(this.newApi);
    const keys = [...new Set([...oldOps.keys(), ...newOps.keys()])];
    const pairs: Pair[] = keys.map(key => ({ key, ...(oldOps.has(key) ? { old: oldOps.get(key)! } : {}), ...(newOps.has(key) ? { new: newOps.get(key)! } : {}) }));
    const opOf = (pair: Pair) => (pair.old ?? pair.new)!;
    pairs.sort((a, b) => opOf(a).path.localeCompare(opOf(b).path) || METHODS.indexOf(opOf(a).method) - METHODS.indexOf(opOf(b).method) || a.key.localeCompare(b.key));
    return pairs.flatMap(pair => this.operation(pair));
  }

  private operation(pair: Pair): ApiChange[] {
    const out = new Collector(pair);
    const { old: before, new: after } = pair;
    if (before && !after) this.removed(before, out);
    else if (!before && after) out.add({ location: 'path', direction: 'operation', rule: 'operation.added', classification: 'compatible', explanation: `New operation ${after.method.toUpperCase()} ${after.path}.`, after: after.source, scope: '' });
    else if (before && after) {
      if (before.path !== after.path) out.add({ location: 'path', direction: 'operation', rule: 'operation.path-template.renamed', classification: 'compatible', explanation: `Path parameter names changed from ${before.path} to ${after.path}; the request URL is unchanged on the wire, only code that refers to parameter names may need updates.`, before: before.source, after: after.source, oldValue: before.path, newValue: after.path, scope: '' });
      this.servers(before, after, out);
      this.parameters(before, after, out);
      this.requestBody(before, after, out);
      this.responses(before, after, out);
      this.security(before, after, out);
    }
    return out.result();
  }

  private removed(op: ApiOperation, out: Collector): void {
    const notes: string[] = [];
    const sameTemplate = this.newApi.operations.filter(other => templateOf(other.path) === templateOf(op.path)).map(other => other.method.toUpperCase()).sort();
    if (sameTemplate.length) notes.push(`The path still exists in the new contract with ${sameTemplate.join(', ')}; a method change is reported as removal plus addition unless an explicit migration maps it.`);
    if (op.operationId) for (const other of this.newApi.operations) if (other.operationId === op.operationId) notes.push(`operationId "${op.operationId}" is used by ${other.method.toUpperCase()} ${other.path} in the new contract; correspondence is not assumed.`);
    out.add({ location: 'path', direction: 'operation', rule: 'operation.removed', classification: 'breaking', explanation: `Operation ${op.method.toUpperCase()} ${op.path} no longer exists in the new contract; requests to it may fail.`, before: op.source, scope: '', notes });
  }

  private servers(before: ApiOperation, after: ApiOperation, out: Collector): void {
    const kept = new Set(after.servers);
    const removed = before.servers.filter(url => !kept.has(url));
    if (!removed.length || !before.servers.length) return;
    out.add({ location: 'path', direction: 'operation', rule: 'operation.servers.removed', classification: 'ambiguous', explanation: `Server URLs ${removed.join(', ')} are no longer listed for this operation; consumers using them as base URL may need a new origin.`, before: before.source, after: after.source, oldValue: before.servers, newValue: after.servers, scope: '' });
  }

  private parameters(before: ApiOperation, after: ApiOperation, out: Collector): void {
    // Path parameters are matched by template position because their names never reach the wire.
    const keyed = (op: ApiOperation) => {
      const names = pathNames(op.path), map = new Map<string, ApiParameter>();
      for (const parameter of op.parameters) {
        const position = names.indexOf(parameter.name);
        const key = parameter.in === 'path' && position >= 0 ? `path#${position}` : `${parameter.in}:${parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name}`;
        map.set(key, parameter);
      }
      return map;
    };
    const oldParams = keyed(before), newParams = keyed(after);
    for (const key of [...new Set([...sortedKeys(oldParams), ...sortedKeys(newParams)])].sort()) {
      const p = oldParams.get(key), q = newParams.get(key);
      if (p && !q) {
        out.add({ location: p.in, direction: 'request', rule: 'parameter.removed', classification: 'ambiguous', explanation: `${p.in} parameter "${p.name}" is no longer documented; the specification does not prove whether the server ignores or rejects it.`, before: p.source, oldValue: p.required, scope: key });
      } else if (!p && q) {
        out.add(q.required
          ? { location: q.in, direction: 'request', rule: 'parameter.added.required', classification: 'breaking', explanation: `New required ${q.in} parameter "${q.name}"; existing requests do not send it.`, after: q.source, newValue: q.schema, scope: key }
          : { location: q.in, direction: 'request', rule: 'parameter.added.optional', classification: 'compatible', explanation: `New optional ${q.in} parameter "${q.name}".`, after: q.source, newValue: q.schema, scope: key });
      } else if (p && q) {
        if (!p.required && q.required) out.add({ location: q.in, direction: 'request', rule: 'parameter.became-required', classification: 'breaking', explanation: `${q.in} parameter "${q.name}" became required; requests that omit it may be rejected.`, before: p.source, after: q.source, oldValue: false, newValue: true, scope: key });
        if (p.required && !q.required) out.add({ location: q.in, direction: 'request', rule: 'parameter.became-optional', classification: 'compatible', explanation: `${q.in} parameter "${q.name}" is no longer required.`, before: p.source, after: q.source, oldValue: true, newValue: false, scope: key });
        out.schema(p.schema, q.schema, { direction: 'request', location: q.in, scope: key, label: `${q.in} parameter "${q.name}"`, root: q.name, before: p.source, after: q.source, oldVersion: this.oldApi.openapi, newVersion: this.newApi.openapi });
      }
    }
  }

  private requestBody(before: ApiOperation, after: ApiOperation, out: Collector): void {
    const p = before.requestBody, q = after.requestBody;
    if (!p && !q) return;
    if (!p && q) {
      out.add(q.required
        ? { location: 'request', direction: 'request', rule: 'request.body.added-required', classification: 'breaking', explanation: 'A required request body was added; existing requests do not send it.', after: q.source, scope: 'body' }
        : { location: 'request', direction: 'request', rule: 'request.body.added-optional', classification: 'compatible', explanation: 'An optional request body was added.', after: q.source, scope: 'body' });
      return;
    }
    if (p && !q) { out.add({ location: 'request', direction: 'request', rule: 'request.body.removed', classification: 'ambiguous', explanation: 'The request body is no longer documented; the specification does not prove whether the server ignores or rejects it.', before: p.source, scope: 'body' }); return; }
    if (!p || !q) return;
    if (!p.required && q.required) out.add({ location: 'request', direction: 'request', rule: 'request.body.became-required', classification: 'breaking', explanation: 'The request body became required; requests without a body may be rejected.', before: p.source, after: q.source, oldValue: false, newValue: true, scope: 'body' });
    if (p.required && !q.required) out.add({ location: 'request', direction: 'request', rule: 'request.body.became-optional', classification: 'compatible', explanation: 'The request body is no longer required.', before: p.source, after: q.source, oldValue: true, newValue: false, scope: 'body' });
    this.media(p.content, q.content, 'request', 'request body', 'request', out);
  }

  private responses(before: ApiOperation, after: ApiOperation, out: Collector): void {
    const oldResponses = new Map(before.responses.map(r => [r.status.toUpperCase(), r])), newResponses = new Map(after.responses.map(r => [r.status.toUpperCase(), r]));
    const isError = (status: string) => status === 'DEFAULT' || /^[45]/.test(status);
    const matched = new Set<string>();
    for (const status of sortedKeys(oldResponses)) {
      const p = oldResponses.get(status)!;
      let q = newResponses.get(status);
      if (q) matched.add(status);
      else if (/^[1-5][0-9]{2}$/.test(status) && newResponses.has(`${status[0]}XX`) && !oldResponses.has(`${status[0]}XX`)) {
        const range = `${status[0]}XX`;
        q = newResponses.get(range)!; matched.add(range);
        out.add({ location: 'response', direction: 'response', rule: 'response.status.generalized', classification: 'ambiguous', explanation: `Response ${status} is now documented only as ${range}; consumers that check the exact status code may see other codes.`, before: p.source, after: q.source, oldValue: status, newValue: range, scope: status });
      }
      if (!q) {
        out.add(isError(status)
          ? { location: 'response', direction: 'response', rule: 'response.status.removed', classification: 'compatible', explanation: `Error response ${status} is no longer documented; consumers receive fewer documented variants.`, before: p.source, oldValue: status, scope: status }
          : { location: 'response', direction: 'response', rule: 'response.status.removed', classification: 'ambiguous', explanation: `Response ${status} is no longer documented; consumers that depend on this status code or its body need review.`, before: p.source, oldValue: status, scope: status });
        continue;
      }
      this.responseContent(p, q, status, out);
    }
    for (const status of sortedKeys(newResponses)) {
      if (matched.has(status) || oldResponses.has(status)) continue;
      const q = newResponses.get(status)!;
      out.add(isError(status)
        ? { location: 'response', direction: 'response', rule: 'response.status.added', classification: 'compatible', explanation: `Error response ${status} is now documented.`, after: q.source, newValue: status, scope: status }
        : { location: 'response', direction: 'response', rule: 'response.status.added', classification: 'ambiguous', explanation: `New non-error response ${status}; consumers that handle status codes exhaustively may not expect it.`, after: q.source, newValue: status, scope: status });
    }
  }

  private responseContent(p: ApiResponse, q: ApiResponse, status: string, out: Collector): void {
    if (p.content.length && !q.content.length) { out.add({ location: 'response', direction: 'response', rule: 'response.body.removed', classification: 'breaking', explanation: `Response ${status} no longer documents a body; consumers that read it may fail.`, before: p.source, after: q.source, oldValue: p.content.map(m => m.mediaType), newValue: [], scope: status }); return; }
    if (!p.content.length && q.content.length) { out.add({ location: 'response', direction: 'response', rule: 'response.body.added', classification: 'compatible', explanation: `Response ${status} now documents a body.`, before: p.source, after: q.source, oldValue: [], newValue: q.content.map(m => m.mediaType), scope: status }); return; }
    this.media(p.content, q.content, 'response', `response ${status}`, `${status}`, out);
  }

  private media(oldContent: ApiMediaType[], newContent: ApiMediaType[], direction: Direction, label: string, scope: string, out: Collector): void {
    const key = (mediaType: string) => mediaType.split(';')[0]!.trim().toLowerCase();
    const covers = (range: string, type: string) => range === '*/*' || (range.endsWith('/*') && type.startsWith(range.slice(0, -1)));
    const oldMap = new Map(oldContent.map(m => [key(m.mediaType), m])), newMap = new Map(newContent.map(m => [key(m.mediaType), m]));
    const location: ChangeLocation = direction;
    if (oldMap.size !== oldContent.length || newMap.size !== newContent.length) {
      out.add({ location, direction, rule: `${direction}.media-type.collision`, classification: 'ambiguous',
        explanation: `${label} lists multiple media types that normalize to the same type; schema comparison cannot choose one safely. Review each variant manually.`,
        before: oldContent[0]?.source, after: newContent[0]?.source,
        oldValue: oldContent.map(item => item.mediaType), newValue: newContent.map(item => item.mediaType), scope });
      return;
    }
    const used = new Set<string>();
    for (const type of sortedKeys(oldMap)) {
      const p = oldMap.get(type)!;
      let q = newMap.get(type);
      if (q) used.add(type);
      else {
        const range = sortedKeys(newMap).find(candidate => !oldMap.has(candidate) && covers(candidate, type));
        if (range) {
          q = newMap.get(range)!; used.add(range);
          out.add({ location, direction, rule: `${direction}.media-type.generalized`, classification: direction === 'request' ? 'compatible' : 'ambiguous', explanation: direction === 'request' ? `${label} media type ${type} is now accepted through range ${range}.` : `${label} media type ${type} is now documented only as ${range}; consumers may receive other content types.`, before: p.source, after: q.source, oldValue: type, newValue: range, scope: `${scope}|${type}` });
        }
      }
      if (!q) {
        out.add({ location, direction, rule: `${direction}.media-type.removed`, classification: 'breaking', explanation: direction === 'request' ? `${label} no longer accepts ${type}; requests sending it may be rejected.` : `${label} no longer produces ${type}; consumers that parse it may fail.`, before: p.source, oldValue: type, scope: `${scope}|${type}` });
        continue;
      }
      out.schema(p.schema, q.schema, { direction, location, scope: `${scope}|${type}`, label: `${label} (${type})`, root: 'body', before: p.source, after: q.source, oldVersion: this.oldApi.openapi, newVersion: this.newApi.openapi });
    }
    for (const type of sortedKeys(newMap)) {
      if (used.has(type) || oldMap.has(type)) continue;
      const q = newMap.get(type)!;
      out.add(direction === 'request'
        ? { location, direction, rule: 'request.media-type.added', classification: 'compatible', explanation: `${label} now also accepts ${type}.`, after: q.source, newValue: type, scope: `${scope}|${type}` }
        : { location, direction, rule: 'response.media-type.added', classification: 'ambiguous', explanation: `${label} may now also produce ${type}; consumers that do not negotiate content types may receive it.`, after: q.source, newValue: type, scope: `${scope}|${type}` });
    }
  }

  private security(before: ApiOperation, after: ApiOperation, out: Collector): void {
    type Requirement = Map<string, string[]>;
    const parse = (list: JsonValue[]): Requirement[] | undefined => {
      const result: Requirement[] = [];
      for (const item of list) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
        const requirement: Requirement = new Map();
        for (const [scheme, scopes] of Object.entries(item)) {
          if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string')) return undefined;
          requirement.set(scheme, [...new Set(scopes as string[])].sort());
        }
        result.push(requirement);
      }
      return result;
    };
    const show = (requirement: Requirement): JsonValue => Object.fromEntries([...requirement].sort(([a], [b]) => a.localeCompare(b)));
    const describe = (requirement: Requirement) => requirement.size ? [...requirement].map(([scheme, scopes]) => scopes.length ? `${scheme} [${scopes.join(', ')}]` : scheme).join(' + ') : 'anonymous';
    const normalize = (list: Requirement[]): JsonValue[] => [...new Map(list.map(r => [canonicalJson(show(r)), show(r)])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
    const oldList = parse(before.security), newList = parse(after.security);
    const base = { location: 'security' as const, direction: 'security' as const, before: before.source, after: after.source };
    if (!oldList || !newList) {
      if (canonicalJson(before.security) !== canonicalJson(after.security)) out.add({ ...base, rule: 'security.unparsed', classification: 'ambiguous', explanation: 'Security requirements changed but could not be interpreted as requirement objects.', oldValue: before.security, newValue: after.security, scope: '' });
      return;
    }
    // An empty list, or an empty requirement object, permits anonymous access.
    const oldAlternatives = oldList.length ? oldList : [new Map()], newAlternatives = newList.length ? newList : [new Map()];
    if (canonicalJson(normalize(oldAlternatives)) === canonicalJson(normalize(newAlternatives))) return;
    const satisfies = (required: Requirement, held: Requirement) => [...required].every(([scheme, scopes]) => held.has(scheme) && scopes.every(scope => held.get(scheme)!.includes(scope)));
    const options = newAlternatives.map(describe).join(' OR ');
    let unsatisfied = false;
    for (const held of oldAlternatives) {
      if (newAlternatives.some(required => satisfies(required, held))) continue;
      unsatisfied = true;
      const scope = canonicalJson(show(held));
      if (!held.size) out.add({ ...base, rule: 'security.authentication.required', classification: 'breaking', explanation: `The operation previously allowed anonymous access and now requires ${options}; manual intervention is needed to provision credentials (APIPatch never creates them).`, oldValue: normalize(oldAlternatives), newValue: normalize(newAlternatives), scope });
      else if (newAlternatives.some(required => [...required.keys()].every(scheme => held.has(scheme)) && required.size === held.size)) out.add({ ...base, rule: 'security.scopes.added', classification: 'ambiguous', explanation: `Credentials for ${describe(held)} now need additional scopes (${options}); existing tokens may or may not already carry them.`, oldValue: show(held), newValue: normalize(newAlternatives), scope });
      else out.add({ ...base, rule: 'security.requirement.unsatisfied', classification: 'breaking', explanation: `Credentials for ${describe(held)} no longer satisfy any accepted alternative (${options}); manual intervention is needed to provision credentials (APIPatch never creates them).`, oldValue: show(held), newValue: normalize(newAlternatives), scope });
    }
    if (!unsatisfied) out.add({ ...base, rule: 'security.relaxed', classification: 'compatible', explanation: `Security alternatives changed to ${options}; every previously accepted credential set is still accepted.`, oldValue: normalize(oldAlternatives), newValue: normalize(newAlternatives), scope: '' });
  }
}

/**
 * Compare two normalized snapshots and classify each change by the direction in which data flows.
 * Output order and IDs are deterministic for the same pair of snapshots. Change `operationId` is the
 * `ApiOperation.id` of the old operation, or of the new one for additions.
 */
export function compareApis(oldApi: ApiSnapshot, newApi: ApiSnapshot): ApiChange[] {
  return new Comparison(oldApi, newApi).run();
}
