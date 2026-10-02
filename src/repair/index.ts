import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { createTwoFilesPatch } from 'diff';
import YAML from 'yaml';
import {
  ContractError, DEFAULT_LIMITS, SCHEMA_VERSION, sha256, stableId, validateDocument, validateMigrationConfig,
  type ApiChange, type ApiOperation, type ApplyResult, type ConsumerUse, type Diagnostic, type FilePatch,
  type Finding, type JsonValue, type MigrationConfig, type PlanRepairsOptions, type RenameMapping,
  type RepairPlan, type RequiredValueMapping, type RunReport, type TextEdit,
} from '../contracts/index.js';

/**
 * Repair planning and application.
 *
 * Identifier semantics (exact match only, never inferred):
 * - `operations[].from` is an `ApiOperation.id` of `report.snapshots.old`.
 * - `operations[].to` is an `ApiOperation.id` of `report.snapshots.new`.
 * - `renames[].operationId` and `values[].operationId` are `ApiOperation.id`s of `report.snapshots.new`
 *   (the destination operation). Their source operation is the old operation mapped to it, or the old
 *   operation with the same id when the route and method did not change.
 */

export type RepairErrorCode = 'INVALID_MIGRATION' | 'INVALID_REPORT' | 'INVALID_PLAN' | 'PLAN_TAMPERED' | 'INVALID_REPOSITORY';
export class RepairError extends Error {
  constructor(public readonly code: RepairErrorCode, public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'RepairError';
  }
}

/** Test seam: lets tests interleave filesystem changes or failures between validation and replacement. */
export interface ApplyOptions { beforeReplace?: (file: string) => void | Promise<void> }

const EDITABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const AXIOS_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'request']);
const BODY_METHODS = new Set(['post', 'put', 'patch']);
const MAX_MIGRATION_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// Migration loading and semantic validation

/** Parse a JSON or YAML migration document and validate its structure. */
export function parseMigration(text: string, source = 'migration'): MigrationConfig {
  if (text.length > MAX_MIGRATION_BYTES) throw new RepairError('INVALID_MIGRATION', source, `document exceeds ${MAX_MIGRATION_BYTES} bytes`);
  const document = YAML.parseDocument(text, { uniqueKeys: true, prettyErrors: true, strict: true, version: '1.2', merge: false });
  if (document.errors.length) throw new RepairError('INVALID_MIGRATION', source, document.errors[0]!.message);
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch (error) { throw new RepairError('INVALID_MIGRATION', source, (error as Error).message); }
  try { return validateMigrationConfig(value); } catch (error) {
    if (error instanceof ContractError) throw new RepairError('INVALID_MIGRATION', `${source}#${error.path}`, error.message.slice(error.path.length + 2));
    throw error;
  }
}

/** Read a migration file (JSON or YAML) without following it outside a regular file. */
export async function loadMigration(file: string): Promise<MigrationConfig> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RepairError('INVALID_MIGRATION', file, 'not a regular file');
    if (stat.size > MAX_MIGRATION_BYTES) throw new RepairError('INVALID_MIGRATION', file, `document exceeds ${MAX_MIGRATION_BYTES} bytes`);
    return parseMigration(await handle.readFile({ encoding: 'utf8' }), file);
  } finally { await handle.close(); }
}

type Location = 'query' | 'request' | 'response';

function successResponses(operation: ApiOperation) {
  return operation.responses.filter(response => /^2/.test(response.status));
}

/** Top-level object property names of a schema, or undefined when they cannot be established. */
function schemaProperties(schema: JsonValue | undefined, depth = 0): Map<string, JsonValue> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return undefined;
  const result = new Map<string, JsonValue>();
  let known = false;
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    known = true;
    for (const [name, value] of Object.entries(properties)) result.set(name, value);
  }
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      const nested = schemaProperties(member, depth + 1);
      if (!nested) continue;
      known = true;
      for (const [name, value] of nested) result.set(name, value);
    }
  }
  return known ? result : undefined;
}

function jsonSchemas(media: { mediaType: string; schema: JsonValue }[]): JsonValue[] {
  return media.filter(item => /^application\/(?:[\w.+-]+\+)?json\b/i.test(item.mediaType)).map(item => item.schema);
}

/** Field schema of `name` at `location`, `null` if the field is absent, undefined if it cannot be verified. */
function fieldSchema(operation: ApiOperation, location: Location, name: string): JsonValue | null | undefined {
  if (location === 'query') {
    const parameter = operation.parameters.find(item => item.in === 'query' && item.name === name);
    return parameter ? parameter.schema : null;
  }
  const schemas = location === 'request' ? jsonSchemas(operation.requestBody?.content ?? []) : successResponses(operation).flatMap(response => jsonSchemas(response.content));
  if (!schemas.length) return undefined;
  let unverifiable = false;
  for (const schema of schemas) {
    const properties = schemaProperties(schema);
    if (!properties) { unverifiable = true; continue; }
    if (properties.has(name)) return properties.get(name)!;
  }
  return unverifiable ? undefined : null;
}

const MAX_PARENT_DEPTH = 8;

/**
 * Properties of a nested object schema reached through `properties` (and object-only `allOf`). Anything
 * APIPatch cannot prove to be a plain object is unverifiable: composition with `oneOf`/`anyOf`/`not`,
 * arrays, `$ref` left unresolved, schemas with only `additionalProperties`, or a recursive path.
 */
function strictObjectProperties(schema: JsonValue | undefined, seen: Set<object>, depth = 0): Map<string, JsonValue> | string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'is not an object schema';
  if (seen.has(schema) || depth > MAX_PARENT_DEPTH) return 'is recursive or too deep';
  if (Object.hasOwn(schema, '$ref')) return 'uses an unresolved $ref (possibly recursive)';
  for (const keyword of ['oneOf', 'anyOf', 'not']) if (Object.hasOwn(schema, keyword)) return `uses ${keyword}`;
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  if (Object.hasOwn(schema, 'items') || types.includes('array')) return 'is an array';
  if (types.some(type => type !== 'object')) return `has type ${types.join('|')}`;
  const next = new Set(seen).add(schema);
  const result = new Map<string, JsonValue>();
  let known = false;
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    known = true;
    for (const [name, value] of Object.entries(properties)) result.set(name, value);
  }
  if (Object.hasOwn(schema, 'allOf')) {
    if (!Array.isArray(schema.allOf)) return 'has an invalid allOf';
    for (const member of schema.allOf) {
      const nested = strictObjectProperties(member, next, depth + 1);
      if (typeof nested === 'string') return `has an allOf member that ${nested}`;
      known = true;
      for (const [name, value] of nested) result.set(name, value);
    }
  }
  return known ? result : 'declares no properties (additionalProperties-only or untyped)';
}

type NestedLookup = { properties: Map<string, JsonValue> } | { absent: string } | { unverifiable: string };

/** Walk `parent` from a body schema; the top level follows today's rules, nested levels the strict ones. */
function nestedProperties(schema: JsonValue, parent: readonly string[]): NestedLookup {
  if (parent.length > MAX_PARENT_DEPTH) return { unverifiable: `parent path deeper than ${MAX_PARENT_DEPTH}` };
  let properties = schemaProperties(schema);
  if (!properties) return { unverifiable: 'top-level schema cannot be verified' };
  const seen = new Set<object>();
  if (schema && typeof schema === 'object') seen.add(schema);
  for (let i = 0; i < parent.length; i++) {
    const segment = parent[i]!;
    if (!properties.has(segment)) return { absent: `${parent.slice(0, i + 1).join('.')} does not exist` };
    const child = properties.get(segment)!;
    const nested = strictObjectProperties(child, seen);
    if (typeof nested === 'string') return { unverifiable: `${parent.slice(0, i + 1).join('.')} ${nested}` };
    if (child && typeof child === 'object') seen.add(child);
    properties = nested;
  }
  return { properties };
}

/**
 * Like `fieldSchema`, at the nested object named by `parent`. Returns the field schema, `null` when the
 * field (or its parent) is absent, or an `Unverifiable` with a reason.
 */
class Unverifiable { constructor(readonly reason: string) {} }

function fieldSchemaAt(operation: ApiOperation, location: Location, parent: readonly string[], name: string): JsonValue | null | Unverifiable {
  if (!parent.length) {
    const schema = fieldSchema(operation, location, name);
    return schema === undefined ? new Unverifiable(`${location} fields cannot be verified`) : schema;
  }
  if (location === 'query') return new Unverifiable('query fields have no parent path');
  const schemas = location === 'request' ? jsonSchemas(operation.requestBody?.content ?? []) : successResponses(operation).flatMap(response => jsonSchemas(response.content));
  if (!schemas.length) return new Unverifiable(`operation has no JSON ${location} body`);
  let unverifiable: string | undefined;
  for (const schema of schemas) {
    const lookup = nestedProperties(schema, parent);
    if ('unverifiable' in lookup) { unverifiable ??= lookup.unverifiable; continue; }
    if ('properties' in lookup && lookup.properties.has(name)) return lookup.properties.get(name)!;
  }
  return unverifiable ? new Unverifiable(unverifiable) : null;
}

const parentOf = (mapping: { parent?: string[] }): string[] => mapping.parent ?? [];
const dotted = (parent: readonly string[], name: string) => [...parent, name].join('.');

function valueMatchesSchema(value: JsonValue, schema: JsonValue): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return true;
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  if (!types.length) return true;
  return types.some(type => type === 'string' ? typeof value === 'string'
    : type === 'number' ? typeof value === 'number'
    : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : type === 'boolean' ? typeof value === 'boolean'
    : type === 'null' ? value === null : false);
}

interface MigrationIndex {
  oldOps: Map<string, ApiOperation>;
  newOps: Map<string, ApiOperation>;
  /** old operation id -> new operation id */
  targets: Map<string, string>;
  renames: Map<string, RenameMapping[]>;
  values: Map<string, RequiredValueMapping[]>;
}

function migrationFail(pointer: string, message: string): never {
  throw new RepairError('INVALID_MIGRATION', `migration#${pointer}`, message);
}

function sourcesOf(index: Pick<MigrationIndex, 'oldOps' | 'targets'>, targetId: string): ApiOperation[] {
  const result: ApiOperation[] = [];
  for (const [id, operation] of index.oldOps) {
    const target = index.targets.get(id) ?? id;
    if (target === targetId) result.push(operation);
  }
  return result;
}

/** Check migration identifiers and fields against the report snapshots; reject contradictions. */
export function validateMigrationForReport(report: RunReport, migration: MigrationConfig): MigrationIndex {
  const oldOps = new Map(report.snapshots.old.operations.map(operation => [operation.id, operation]));
  const newOps = new Map(report.snapshots.new.operations.map(operation => [operation.id, operation]));
  const targets = new Map<string, string>();
  migration.operations.forEach((mapping, i) => {
    if (!oldOps.has(mapping.from)) migrationFail(`/operations/${i}/from`, `unknown source operation ${mapping.from} in report.snapshots.old`);
    if (!newOps.has(mapping.to)) migrationFail(`/operations/${i}/to`, `unknown destination operation ${mapping.to} in report.snapshots.new`);
    targets.set(mapping.from, mapping.to);
  });
  const index = { oldOps, newOps, targets, renames: new Map<string, RenameMapping[]>(), values: new Map<string, RequiredValueMapping[]>() };
  // Contradictions are properties of the mapping itself: check them before consulting the snapshots.
  const renameTargets = new Map<string, number>();
  const renameSources = new Map<string, number>();
  migration.renames.forEach((mapping, i) => {
    const key = `${mapping.operationId}\0${mapping.location}\0${parentOf(mapping).join('\u0001')}`;
    if (mapping.from === mapping.to) migrationFail(`/renames/${i}`, 'rename must change the name');
    if (renameTargets.has(`${key}\0${mapping.to}`)) migrationFail(`/renames/${i}/to`, `contradictory renames: two fields renamed to ${mapping.to}`);
    renameTargets.set(`${key}\0${mapping.to}`, i);
    renameSources.set(`${key}\0${mapping.from}`, i);
  });
  for (const [key, i] of renameSources) if (renameTargets.has(key)) migrationFail(`/renames/${i}`, 'chained or swapped renames are order-dependent and rejected');
  migration.values.forEach((mapping, i) => {
    const key = `${mapping.operationId}\0${mapping.location}\0${parentOf(mapping).join('\u0001')}\0${mapping.name}`;
    if (renameTargets.has(key) || renameSources.has(key)) migrationFail(`/values/${i}`, `contradictory mappings: ${mapping.name} is both renamed and given a fixed value`);
  });
  migration.renames.forEach((mapping, i) => {
    const at = `/renames/${i}`;
    const target = newOps.get(mapping.operationId);
    if (!target) migrationFail(`${at}/operationId`, `unknown destination operation ${mapping.operationId} in report.snapshots.new`);
    if (!mapping.from || !mapping.to) migrationFail(at, 'names must not be empty');
    const sources = sourcesOf(index, mapping.operationId);
    if (!sources.length) migrationFail(`${at}/operationId`, 'destination operation has no source operation in report.snapshots.old');
    const parent = parentOf(mapping);
    if (!parent.length) {
      const destination = fieldSchema(target, mapping.location, mapping.to);
      if (destination === null) migrationFail(`${at}/to`, `${mapping.location} field ${mapping.to} does not exist in destination operation`);
      if (destination === undefined) migrationFail(`${at}/to`, `${mapping.location} fields of destination operation cannot be verified`);
      for (const source of sources) {
        const origin = fieldSchema(source, mapping.location, mapping.from);
        if (origin === null) migrationFail(`${at}/from`, `${mapping.location} field ${mapping.from} does not exist in source operation ${source.id}`);
        if (origin === undefined) migrationFail(`${at}/from`, `${mapping.location} fields of source operation ${source.id} cannot be verified`);
      }
    } else {
      if (parent.some(segment => !segment)) migrationFail(`${at}/parent`, 'parent path segments must not be empty');
      const destination = fieldSchemaAt(target, mapping.location, parent, mapping.to);
      if (destination === null) migrationFail(`${at}/to`, `${mapping.location} field ${dotted(parent, mapping.to)} does not exist in destination operation`);
      if (destination instanceof Unverifiable) migrationFail(`${at}/parent`, `${mapping.location} field path ${dotted(parent, mapping.to)} of destination operation cannot be verified: ${destination.reason}`);
      for (const source of sources) {
        const origin = fieldSchemaAt(source, mapping.location, parent, mapping.from);
        if (origin === null) migrationFail(`${at}/from`, `${mapping.location} field ${dotted(parent, mapping.from)} does not exist in source operation ${source.id}`);
        if (origin instanceof Unverifiable) migrationFail(`${at}/parent`, `${mapping.location} field path ${dotted(parent, mapping.from)} of source operation ${source.id} cannot be verified: ${origin.reason}`);
      }
    }
    index.renames.set(mapping.operationId, [...(index.renames.get(mapping.operationId) ?? []), mapping]);
  });
  migration.values.forEach((mapping, i) => {
    const at = `/values/${i}`;
    const target = newOps.get(mapping.operationId);
    if (!target) migrationFail(`${at}/operationId`, `unknown destination operation ${mapping.operationId} in report.snapshots.new`);
    if (!sourcesOf(index, mapping.operationId).length) migrationFail(`${at}/operationId`, 'destination operation has no source operation in report.snapshots.old');
    if (!['string', 'number', 'boolean'].includes(typeof mapping.value)) migrationFail(`${at}/value`, 'only string, number and boolean values are supported');
    const parent = parentOf(mapping);
    let schema: JsonValue | null | undefined | Unverifiable;
    if (!parent.length) {
      schema = fieldSchema(target, mapping.location, mapping.name);
      if (schema === null) migrationFail(`${at}/name`, `${mapping.location} field ${mapping.name} does not exist in destination operation`);
      if (schema === undefined) migrationFail(`${at}/name`, `${mapping.location} fields of destination operation cannot be verified`);
    } else {
      if (parent.some(segment => !segment)) migrationFail(`${at}/parent`, 'parent path segments must not be empty');
      schema = fieldSchemaAt(target, mapping.location, parent, mapping.name);
      if (schema === null) migrationFail(`${at}/name`, `${mapping.location} field ${dotted(parent, mapping.name)} does not exist in destination operation`);
      if (schema instanceof Unverifiable) migrationFail(`${at}/parent`, `${mapping.location} field path ${dotted(parent, mapping.name)} of destination operation cannot be verified: ${schema.reason}`);
    }
    if (!valueMatchesSchema(mapping.value, schema)) migrationFail(`${at}/value`, `value does not satisfy the declared type/enum of ${mapping.name}`);
    index.values.set(mapping.operationId, [...(index.values.get(mapping.operationId) ?? []), mapping]);
  });
  return index;
}

// ---------------------------------------------------------------------------
// Repository access

class FileAccessError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

interface RepoFile { full: string; content: string; dev: number; ino: number; mode: number }

function isSafeRelative(file: string): boolean {
  return !!file && !file.includes('\0') && !file.includes('\\') && !path.isAbsolute(file) && !/^[a-z]:/i.test(file)
    && file.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Read a repository file, refusing escapes, symlinks in any component, special files and binary content. */
async function readRepoFile(root: string, file: string): Promise<RepoFile> {
  if (!isSafeRelative(file)) throw new FileAccessError('REPAIR_UNSAFE_PATH', 'Path is not a safe relative path');
  if (!EDITABLE_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new FileAccessError('REPAIR_UNSUPPORTED_FILE', 'Only JavaScript/TypeScript sources are editable');
  let current = root;
  for (const part of file.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current); } catch { throw new FileAccessError('REPAIR_MISSING_FILE', 'File does not exist'); }
    if (stat.isSymbolicLink()) throw new FileAccessError('REPAIR_SYMLINK', 'Path contains a symbolic link');
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(root + path.sep)) throw new FileAccessError('REPAIR_PATH_ESCAPE', 'File resolves outside the repository');
  let handle;
  try { handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new FileAccessError('REPAIR_SYMLINK', 'File could not be opened without following links'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new FileAccessError('REPAIR_NOT_REGULAR', 'Not a regular file');
    if (stat.size > DEFAULT_LIMITS.maxFileBytes) throw new FileAccessError('REPAIR_FILE_TOO_LARGE', `File exceeds ${DEFAULT_LIMITS.maxFileBytes} bytes`);
    const buffer = await handle.readFile();
    if (buffer.includes(0)) throw new FileAccessError('REPAIR_BINARY_FILE', 'File contains NUL bytes');
    const content = buffer.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(buffer)) throw new FileAccessError('REPAIR_BINARY_FILE', 'File is not valid UTF-8');
    return { full: current, content, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 };
  } finally { await handle.close(); }
}

// ---------------------------------------------------------------------------
// Text edits and diffs

function applyEdits(content: string, edits: readonly TextEdit[]): string {
  let output = '';
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (edit.start < cursor || edit.end > content.length) throw new FileAccessError('REPAIR_EDIT_RANGE', 'Edit range is invalid or overlapping');
    if (content.slice(edit.start, edit.end) !== edit.oldText) throw new FileAccessError('REPAIR_EDIT_MISMATCH', `Edit at ${edit.start} does not match the original text`);
    output += content.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  return output + content.slice(cursor);
}

/** If `content` is `original` with all edits applied, return the reconstructed original; otherwise undefined. */
function revertEdits(content: string, edits: readonly TextEdit[]): string | undefined {
  let output = '';
  let cursor = 0;
  let delta = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = edit.start + delta;
    if (start < cursor || content.slice(start, start + edit.newText.length) !== edit.newText) return undefined;
    output += content.slice(cursor, start) + edit.oldText;
    cursor = start + edit.newText.length;
    delta += edit.newText.length - (edit.end - edit.start);
  }
  return output + content.slice(cursor);
}

function fileDiff(file: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, undefined, undefined, { context: 3 });
  return `diff --git a/${file} b/${file}\n${patch.slice(patch.indexOf('\n') + 1)}`;
}

function planId(plan: Pick<RepairPlan, 'reportId' | 'migration' | 'files'>): string {
  return stableId('repair', { reportId: plan.reportId, migration: plan.migration, files: plan.files });
}

function scriptKind(file: string): ts.ScriptKind {
  const ext = path.extname(file).toLowerCase();
  return ext === '.ts' || ext === '.mts' || ext === '.cts' ? ts.ScriptKind.TS : ext === '.tsx' ? ts.ScriptKind.TSX
    : ext === '.jsx' ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}

function syntaxErrors(file: string, content: string): number {
  const parsed = parseFile(file, content);
  return parsed.program.getSyntacticDiagnostics(parsed.source).length;
}

// ---------------------------------------------------------------------------
// AST analysis of one consumer call

interface ParsedFile { source: ts.SourceFile; checker: ts.TypeChecker; program: ts.Program }

function parseFile(file: string, content: string): ParsedFile {
  const fileName = path.posix.join('/__apipatch__', file);
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind(file));
  const options: ts.CompilerOptions = { allowJs: true, checkJs: false, noEmit: true, noResolve: true, noLib: true, types: [] };
  const host: ts.CompilerHost = {
    getSourceFile: name => name === fileName ? source : undefined,
    getDefaultLibFileName: () => 'lib.d.ts', writeFile: () => undefined, getCurrentDirectory: () => '/',
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    fileExists: name => name === fileName, readFile: name => name === fileName ? content : undefined,
  };
  const program = ts.createProgram([fileName], options, host);
  return { source, checker: program.getTypeChecker(), program };
}

function findCall(source: ts.SourceFile, start: number, end: number): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (found || node.getEnd() < start || node.getStart(source) > end) return;
    if (ts.isCallExpression(node) && node.getStart(source) === start && node.getEnd() === end) { found = node; return; }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function findIdentifier(source: ts.SourceFile, start: number, end: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  function visit(node: ts.Node): void {
    if (found || node.getEnd() < start || node.getStart(source) > end) return;
    if (ts.isIdentifier(node) && node.getStart(source) === start && node.getEnd() === end) { found = node; return; }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined;
}

function property(object: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  for (const member of object?.properties ?? []) {
    if (ts.isPropertyAssignment(member) && propertyName(member.name) === name) return member.initializer;
    if (ts.isShorthandPropertyAssignment(member) && member.name.text === name) return member.name;
  }
  return undefined;
}

interface CallShape { url?: ts.Expression; body?: ts.Expression; params?: ts.Expression }

function callShape(call: ts.CallExpression, client: ConsumerUse['client']): CallShape {
  const args = call.arguments;
  const literalObject = (node: ts.Expression | undefined) => node && ts.isObjectLiteralExpression(unwrap(node)) ? unwrap(node) as ts.ObjectLiteralExpression : undefined;
  if (client === 'fetch') {
    const options = literalObject(args[1]);
    let body = property(options, 'body');
    if (body) {
      const inner = unwrap(body);
      if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && ts.isIdentifier(inner.expression.expression)
        && inner.expression.expression.text === 'JSON' && inner.expression.name.text === 'stringify' && inner.arguments.length === 1) body = inner.arguments[0];
    }
    // Options that are not an inline literal (or contain spreads) may hide a body: report the body as non-editable.
    if (args[1] && (!options || (!body && options.properties.some(member => ts.isSpreadAssignment(member))))) body = args[1];
    return { url: args[0], ...(body ? { body } : {}) };
  }
  let config: ts.ObjectLiteralExpression | undefined;
  let shape: CallShape = {};
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && AXIOS_METHODS.has(callee.name.text)) {
    const name = callee.name.text;
    if (name === 'request') config = literalObject(args[0]);
    else if (BODY_METHODS.has(name)) { shape = { url: args[0], ...(args[1] ? { body: args[1] } : {}) }; config = literalObject(args[2]); if (args[2] && !config) shape.params = args[2]; }
    else { shape = { url: args[0] }; config = literalObject(args[1]); if (args[1] && !config) shape.params = args[1]; }
  } else if (args[0] && literalObject(args[0])) config = literalObject(args[0]);
  else { shape = { url: args[0] }; config = literalObject(args[1]); if (args[1] && !config) shape.params = args[1]; }
  if (config) {
    shape.url ??= property(config, 'url');
    const data = property(config, 'data');
    if (data) shape.body ??= data;
    const params = property(config, 'params');
    if (params) shape.params = params;
    if (config.properties.some(member => !ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member))) shape.params ??= config;
  }
  return shape;
}

// URL literal tokenization ---------------------------------------------------

type Token = { kind: 'char'; ch: string; pos: number } | { kind: 'expr'; start: number; end: number };
interface UrlLiteral { tokens: Token[]; quote: string }

function tokenStart(token: Token): number { return token.kind === 'char' ? token.pos : token.start; }
function tokenEnd(token: Token): number { return token.kind === 'char' ? token.pos + 1 : token.end; }

function tokenizeUrl(source: ts.SourceFile, node: ts.Expression | undefined): UrlLiteral | string {
  if (!node) return 'call has no URL expression';
  const text = source.text;
  const chars = (from: number, to: number, out: Token[]): string | undefined => {
    const raw = text.slice(from, to);
    if (raw.includes('\\')) return 'URL literal contains escape sequences';
    for (let i = 0; i < raw.length; i++) out.push({ kind: 'char', ch: raw[i]!, pos: from + i });
    return undefined;
  };
  const tokens: Token[] = [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const start = node.getStart(source);
    const problem = chars(start + 1, node.getEnd() - 1, tokens);
    return problem ?? { tokens, quote: text[start]! };
  }
  if (ts.isTemplateExpression(node)) {
    let problem = chars(node.head.getStart(source) + 1, node.head.getEnd() - 2, tokens);
    if (problem) return problem;
    let exprStart = node.head.getEnd() - 2;
    for (const span of node.templateSpans) {
      const literalStart = span.literal.getStart(source);
      tokens.push({ kind: 'expr', start: exprStart, end: literalStart + 1 });
      const tail = ts.isTemplateTail(span.literal);
      problem = chars(literalStart + 1, span.literal.getEnd() - (tail ? 1 : 2), tokens);
      if (problem) return problem;
      exprStart = span.literal.getEnd() - 2;
    }
    return { tokens, quote: '`' };
  }
  return 'URL is not an inline string or template literal';
}

function literalSafe(text: string, quote: string): boolean {
  return !/[\\\n\r\u2028\u2029]/.test(text) && !text.includes(quote) && !(quote === '`' && text.includes('${'));
}

interface PathMatch { regionStart: number; regionEnd: number; paramText: Map<string, string>; pathEnd: number }

function isChar(token: Token | undefined, ch: string): boolean { return token?.kind === 'char' && token.ch === ch; }

/** Match the operation route against the tail of the URL path, using source tokens. */
function matchPath(source: ts.SourceFile, url: UrlLiteral, route: string): PathMatch | string {
  const tokens = url.tokens;
  let pathEnd = tokens.findIndex(token => isChar(token, '?') || isChar(token, '#'));
  if (pathEnd < 0) pathEnd = tokens.length;
  if (!route.endsWith('/') && isChar(tokens[pathEnd - 1], '/')) pathEnd--;
  const segments = route.split('/').slice(1);
  const paramText = new Map<string, string>();
  let cursor = pathEnd;
  for (const segment of [...segments].reverse()) {
    let slash = cursor - 1;
    while (slash >= 0 && !isChar(tokens[slash], '/')) slash--;
    if (slash < 0) return `URL path does not contain the route segment "${segment}" as an editable literal`;
    const segmentTokens = tokens.slice(slash + 1, cursor);
    const param = /^\{([^{}/]+)\}$/.exec(segment);
    if (param) {
      const exprs = segmentTokens.filter(token => token.kind === 'expr');
      if (!segmentTokens.length || (exprs.length && segmentTokens.length !== 1)) return `path parameter {${param[1]}} is not a single literal or template expression`;
      paramText.set(param[1]!, source.text.slice(tokenStart(segmentTokens[0]!), tokenEnd(segmentTokens[segmentTokens.length - 1]!)));
    } else {
      const textValue = segmentTokens.every(token => token.kind === 'char') ? segmentTokens.map(token => (token as { ch: string }).ch).join('') : undefined;
      if (textValue !== segment) return `route segment "${segment}" is not a literal in the URL expression`;
    }
    cursor = slash;
  }
  return { regionStart: cursor, regionEnd: pathEnd, paramText, pathEnd };
}

interface QueryParam { name?: string; nameStart: number; nameEnd: number; value?: string }
interface QueryInfo { params: QueryParam[]; dynamicNames: boolean; question?: number; end: number }

function parseQuery(url: UrlLiteral): QueryInfo {
  const tokens = url.tokens;
  const question = tokens.findIndex(token => isChar(token, '?'));
  let end = tokens.findIndex(token => isChar(token, '#'));
  if (end < 0) end = tokens.length;
  if (question < 0 || question > end) return { params: [], dynamicNames: false, end };
  const params: QueryParam[] = [];
  let dynamicNames = false;
  let i = question + 1;
  while (i < end) {
    let j = i;
    while (j < end && !isChar(tokens[j], '&')) j++;
    const part = tokens.slice(i, j);
    if (part.length) {
      const eq = part.findIndex(token => isChar(token, '='));
      const nameTokens = eq < 0 ? part : part.slice(0, eq);
      const valueTokens = eq < 0 ? [] : part.slice(eq + 1);
      const decode = (items: Token[]) => {
        if (!items.every(token => token.kind === 'char')) return undefined;
        try { return decodeURIComponent(items.map(token => (token as { ch: string }).ch).join('').replaceAll('+', ' ')); } catch { return undefined; }
      };
      const name = nameTokens.length ? decode(nameTokens) : undefined;
      if (name === undefined) dynamicNames = true;
      const value = decode(valueTokens);
      params.push({ ...(name !== undefined ? { name } : {}), nameStart: nameTokens.length ? tokenStart(nameTokens[0]!) : -1, nameEnd: nameTokens.length ? tokenEnd(nameTokens[nameTokens.length - 1]!) : -1, ...(value !== undefined ? { value } : {}) });
    }
    i = j + 1;
  }
  return { params, dynamicNames, question, end };
}

function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Object literal editing -------------------------------------------------------

interface ObjectInfo { node: ts.ObjectLiteralExpression; keys: Map<string, ts.ObjectLiteralElementLike[]>; opaque: boolean }

function objectInfo(node: ts.Expression | undefined, call: ts.CallExpression, source: ts.SourceFile): ObjectInfo | string | undefined {
  if (!node) return undefined;
  const object = unwrap(node);
  if (!ts.isObjectLiteralExpression(object)) return 'object is not an inline object literal in the call';
  if (object.getStart(source) < call.getStart(source) || object.getEnd() > call.getEnd()) return 'object is declared outside the call';
  const keys = new Map<string, ts.ObjectLiteralElementLike[]>();
  let opaque = false;
  for (const member of object.properties) {
    const name = ts.isPropertyAssignment(member) ? propertyName(member.name) : ts.isShorthandPropertyAssignment(member) ? member.name.text : undefined;
    if (name === undefined) { opaque = true; continue; }
    keys.set(name, [...(keys.get(name) ?? []), member]);
  }
  return { node: object, keys, opaque };
}

function preferredQuote(source: ts.SourceFile, node: ts.Node): string {
  let quote = '"';
  let decided = false;
  function visit(child: ts.Node): void {
    if (decided) return;
    if (ts.isStringLiteral(child)) { quote = source.text[child.getStart(source)] === "'" ? "'" : '"'; decided = true; return; }
    ts.forEachChild(child, visit);
  }
  visit(node);
  if (!decided) visit(source);
  return quote;
}

function stringLiteral(value: string, quote: string): string {
  const json = JSON.stringify(value);
  return quote === '"' ? json : `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

/** ASCII identifier names only; reserved words are valid property names since ES5. */
function isIdentifierName(name: string): boolean { return /^[A-Za-z_$][\w$]*$/.test(name); }

function keyText(name: string, quote: string): string {
  return isIdentifierName(name) ? name : stringLiteral(name, quote);
}

function valueText(value: JsonValue, quote: string): string {
  return typeof value === 'string' ? stringLiteral(value, quote) : JSON.stringify(value);
}

function literalValue(node: ts.Expression): JsonValue | undefined {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isNumericLiteral(inner)) return Number(inner.text);
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(inner.operand)) return -Number(inner.operand.text);
  return undefined;
}

function lineIndent(source: ts.SourceFile, position: number): string {
  const lineStart = source.text.lastIndexOf('\n', position - 1) + 1;
  return /^[ \t]*/.exec(source.text.slice(lineStart))![0];
}

// ---------------------------------------------------------------------------
// Planning

interface Draft { start: number; end: number; newText: string; reason: string }
interface MappingOutcome {
  kind: 'operation' | 'rename' | 'value';
  location?: Location;
  names: string[];
  /** Property path of the object holding the field (request/response); empty or omitted means top level. */
  parent?: string[];
  status: 'applied' | 'absent' | 'failed';
  reason: string;
  edits: Draft[];
  caveat?: string;
}

function pointerSegments(pointer: string): string[] {
  return pointer.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * Names a change is about, derived only from structured data: parameter source pointers, `properties`
 * segments of source pointers and the optional `fieldPath` (top-level fields only). Prose is never parsed.
 */
function changeSubjects(change: ApiChange, report: RunReport): { names: Set<string>; parent?: string[]; unsupported?: string } {
  const names = new Set<string>();
  const fieldPath = (change as { fieldPath?: unknown }).fieldPath;
  if ((change.location === 'request' || change.location === 'response') && Array.isArray(fieldPath) && fieldPath.every(item => typeof item === 'string')) {
    if (fieldPath.length === 1) names.add(fieldPath[0]!);
    // Nested: linked only to mappings whose parent equals the path prefix and whose name is the last segment.
    else if (fieldPath.length > 1) return { names: new Set([fieldPath[fieldPath.length - 1]!]), parent: fieldPath.slice(0, -1) };
    else return { names, unsupported: 'change affects the whole body schema' };
  }
  const operations = [...report.snapshots.old.operations, ...report.snapshots.new.operations];
  for (const location of [change.before, change.after]) {
    if (!location) continue;
    for (const operation of operations) for (const parameter of operation.parameters) {
      if (parameter.source.file === location.file && (location.pointer === parameter.source.pointer || location.pointer.startsWith(parameter.source.pointer + '/'))) names.add(parameter.name);
    }
    const segments = pointerSegments(location.pointer);
    const last = segments.lastIndexOf('properties');
    if (last >= 0 && segments[last + 1] !== undefined) names.add(segments[last + 1]!);
  }
  return { names };
}

function isOperationLevel(change: ApiChange): boolean {
  return change.direction === 'operation' || change.location === 'path';
}

function requiredNames(schema: JsonValue | undefined, depth = 0): Set<string> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return undefined;
  const result = new Set<string>();
  if (Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === 'string') result.add(name);
  if (Array.isArray(schema.allOf)) for (const member of schema.allOf) for (const name of requiredNames(member, depth + 1) ?? []) result.add(name);
  return result;
}

const sameSchema = (a: JsonValue | null | undefined, b: JsonValue | null | undefined) => a != null && b != null && JSON.stringify(a) === JSON.stringify(b);

/** JSON with sorted object keys and sorted `required` lists: order is not meaningful in either. */
function canonical(value: JsonValue | undefined, key?: string): string {
  if (Array.isArray(value)) {
    const items = value.map(item => canonical(item));
    return `[${(key === 'required' ? items.sort() : items).join(',')}]`;
  }
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name], name)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The source schema of top-level field `name` with the applied nested renames under it replayed. Only plain
 * `properties` paths are rewritten; anything else returns undefined (not demonstrated).
 */
function replayNestedRenames(schema: JsonValue, renames: MappingOutcome[]): JsonValue | undefined {
  const copy = structuredClone(schema);
  for (const outcome of renames) {
    let node: JsonValue = copy;
    for (const segment of outcome.parent!.slice(1)) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || typeof strictObjectProperties(node, new Set()) === 'string' || Object.hasOwn(node, 'allOf')) return undefined;
      const properties = node.properties as Record<string, JsonValue> | undefined;
      if (!properties || !Object.hasOwn(properties, segment)) return undefined;
      node = properties[segment]!;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof strictObjectProperties(node, new Set()) === 'string' || Object.hasOwn(node, 'allOf')) return undefined;
    const properties = node.properties as Record<string, JsonValue> | undefined;
    const [from, to] = outcome.names as [string, string];
    if (!properties || !Object.hasOwn(properties, from) || Object.hasOwn(properties, to)) return undefined;
    properties[to] = properties[from]!;
    delete properties[from];
    if (Array.isArray(node.required)) node.required = node.required.map(item => item === from ? to : item);
  }
  return copy;
}

/**
 * Obligations a moved operation imposes on the call, checked only against explicit mappings and the two
 * snapshots (never by name similarity). Returns the obligations that are not demonstrated.
 */
function unmetMoveObligations(source: ApiOperation, target: ApiOperation, outcomes: MappingOutcome[]): string[] {
  const unmet: string[] = [];
  const done = (location: Location, pick: (outcome: MappingOutcome) => boolean, allowAbsent = false) =>
    outcomes.find(outcome => outcome.kind !== 'operation' && outcome.location === location && !outcome.parent?.length && pick(outcome) && (outcome.status === 'applied' || (allowAbsent && outcome.status === 'absent')) && !outcome.caveat);
  // A top-level field whose schema changed only by explicit nested renames (replayed on the source schema) is
  // demonstrated; nested values and anything not reproducible from the snapshots stay undemonstrated.
  const nestedExplains = (location: Location, name: string, before: JsonValue, after: JsonValue | null | undefined, allowAbsent: boolean) => {
    if (after === null || after === undefined) return false;
    const renames = outcomes.filter(outcome => outcome.kind === 'rename' && outcome.location === location && outcome.parent?.[0] === name);
    if (!renames.length || renames.some(outcome => !(outcome.status === 'applied' || (allowAbsent && outcome.status === 'absent')) || outcome.caveat)) return false;
    const replayed = replayNestedRenames(before, renames);
    return replayed !== undefined && canonical(replayed) === canonical(after);
  };
  // A field the destination requires must either exist unchanged in the source or be produced by an applied mapping.
  const produced = (location: 'query' | 'request', name: string): string | undefined => {
    const before = fieldSchema(source, location, name);
    const after = fieldSchema(target, location, name);
    if (before !== null && before !== undefined) return sameSchema(before, after) || (location === 'request' && nestedExplains(location, name, before, after, false)) ? undefined : `${location} field ${name} has a different schema in the destination`;
    const value = done(location, outcome => outcome.kind === 'value' && outcome.names[0] === name);
    if (value) return undefined;
    const rename = done(location, outcome => outcome.kind === 'rename' && outcome.names[1] === name);
    if (!rename) return `destination requires ${location} field ${name} and no applied explicit mapping provides it`;
    return sameSchema(fieldSchema(source, location, rename.names[0]!), after) ? undefined : `renamed ${location} field ${rename.names[0]} → ${name} has a different schema`;
  };
  for (const parameter of target.parameters) {
    if (!parameter.required || parameter.in === 'path') continue;
    if (parameter.in !== 'query') {
      if (!source.parameters.some(item => item.in === parameter.in && item.name === parameter.name && sameSchema(item.schema, parameter.schema))) unmet.push(`destination requires ${parameter.in} parameter ${parameter.name}, which is not repaired automatically`);
      continue;
    }
    const note = produced('query', parameter.name);
    if (note) unmet.push(note);
  }
  if (target.requestBody?.required || target.requestBody?.content.length) {
    for (const schema of jsonSchemas(target.requestBody.content)) {
      const required = requiredNames(schema);
      if (!required || !schemaProperties(schema)) { unmet.push('destination request body schema cannot be verified'); continue; }
      for (const name of required) { const note = produced('request', name); if (note) unmet.push(note); }
    }
  }
  const sourceResponses = successResponses(source).flatMap(response => jsonSchemas(response.content));
  const targetResponses = successResponses(target).flatMap(response => jsonSchemas(response.content));
  if (sourceResponses.length || targetResponses.length) {
    const before = sourceResponses.map(schema => schemaProperties(schema));
    if (!targetResponses.length || before.some(item => !item) || targetResponses.some(schema => !schemaProperties(schema))) unmet.push('success response schemas cannot be compared');
    else for (const [name, schema] of before.flatMap(item => [...item!])) {
      const after = fieldSchema(target, 'response', name);
      if (after !== null) { if (!sameSchema(schema, after) && !nestedExplains('response', name, schema, after, true)) unmet.push(`response field ${name} has a different schema in the destination`); continue; }
      const rename = done('response', outcome => outcome.kind === 'rename' && outcome.names[0] === name, true);
      if (!rename) unmet.push(`response field ${name} is missing in the destination and no explicit mapping covers the call's reads of it`);
      else if (!sameSchema(schema, fieldSchema(target, 'response', rename.names[1]!))) unmet.push(`renamed response field ${name} → ${rename.names[1]} has a different schema`);
    }
  }
  return [...new Set(unmet)];
}

interface UseContext {
  use: ConsumerUse;
  parsed: ParsedFile;
  call: ts.CallExpression;
  source: ApiOperation;
  target: ApiOperation;
}

function planOperation(ctx: UseContext, url: UrlLiteral | string, match: PathMatch | string): MappingOutcome {
  const names = [ctx.source.path, ctx.target.path];
  const fail = (reason: string): MappingOutcome => ({ kind: 'operation', names, status: 'failed', reason, edits: [] });
  if (ctx.source.method !== ctx.target.method) return fail(`HTTP method changes (${ctx.source.method} → ${ctx.target.method}) are not repaired automatically`);
  if (JSON.stringify(ctx.source.servers) !== JSON.stringify(ctx.target.servers)) return fail('server/base URL changes are not repaired automatically');
  if (typeof url === 'string') return fail(url);
  if (typeof match === 'string') return fail(match);
  const params = (route: string) => [...route.matchAll(/\{([^{}/]+)\}/g)].map(item => item[1]!).sort();
  if (JSON.stringify(params(ctx.source.path)) !== JSON.stringify(params(ctx.target.path))) return fail('path parameter names differ; no explicit parameter mapping is supported');
  let text = '';
  for (const segment of ctx.target.path.split('/').slice(1)) {
    const param = /^\{([^{}/]+)\}$/.exec(segment);
    if (param) text += '/' + match.paramText.get(param[1]!)!;
    else if (/[{}]/.test(segment) || !literalSafe(segment, url.quote)) return fail(`destination segment "${segment}" cannot be written safely into the literal`);
    else text += '/' + segment;
  }
  const start = tokenStart(url.tokens[match.regionStart]!);
  const end = tokenEnd(url.tokens[match.regionEnd - 1]!);
  return { kind: 'operation', names, status: 'applied', reason: `operation mapping ${ctx.source.id} → ${ctx.target.id}: ${ctx.source.method.toUpperCase()} ${ctx.source.path} → ${ctx.target.path}`, edits: [{ start, end, newText: text, reason: `Route ${ctx.source.path} → ${ctx.target.path} (explicit operation mapping)` }] };
}

function renameInObject(info: ObjectInfo, mapping: RenameMapping, source: ts.SourceFile, label: string): MappingOutcome {
  const base = { kind: 'rename' as const, location: mapping.location, names: [mapping.from, mapping.to], ...(parentOf(mapping).length ? { parent: parentOf(mapping) } : {}) };
  const members = info.keys.get(mapping.from) ?? [];
  if (info.opaque && !members.length) return { ...base, status: 'failed', reason: `${label} has spread/computed members; ${mapping.from} cannot be ruled out`, edits: [] };
  if (!members.length) return { ...base, status: 'absent', reason: `${label} has no ${mapping.from} property`, edits: [] };
  if (info.opaque) return { ...base, status: 'failed', reason: `${label} has spread/computed members that may also define ${mapping.from}`, edits: [] };
  if (members.length > 1) return { ...base, status: 'failed', reason: `${label} defines ${mapping.from} more than once`, edits: [] };
  if (info.keys.has(mapping.to)) return { ...base, status: 'failed', reason: `${label} already defines ${mapping.to}`, edits: [] };
  const member = members[0]!;
  const quote = preferredQuote(source, info.node);
  const reason = parentOf(mapping).length
    ? `Rename ${mapping.location} field ${dotted(parentOf(mapping), mapping.from)} → ${dotted(parentOf(mapping), mapping.to)} (explicit nested rename mapping, parent ${parentOf(mapping).join('.')})`
    : `Rename ${mapping.location} field ${mapping.from} → ${mapping.to} (explicit rename mapping)`;
  if (ts.isShorthandPropertyAssignment(member)) {
    return { ...base, status: 'applied', reason, edits: [{ start: member.name.getStart(source), end: member.name.getEnd(), newText: `${keyText(mapping.to, quote)}: ${member.name.text}`, reason }] };
  }
  const name = (member as ts.PropertyAssignment).name;
  const original = source.text[name.getStart(source)];
  const text = ts.isStringLiteral(name) && (original === '"' || original === "'") ? stringLiteral(mapping.to, original) : keyText(mapping.to, quote);
  return { ...base, status: 'applied', reason, edits: [{ start: name.getStart(source), end: name.getEnd(), newText: text, reason }] };
}

function valueInObject(info: ObjectInfo, mapping: RequiredValueMapping, source: ts.SourceFile, label: string): MappingOutcome {
  const base = { kind: 'value' as const, location: mapping.location, names: [mapping.name], ...(parentOf(mapping).length ? { parent: parentOf(mapping) } : {}) };
  const members = info.keys.get(mapping.name) ?? [];
  if (members.length) {
    const member = members[0]!;
    const existing = members.length === 1 && ts.isPropertyAssignment(member) ? literalValue(member.initializer) : undefined;
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(mapping.value)) return { ...base, status: 'applied', reason: `${label} already sets ${mapping.name} to the configured value`, edits: [] };
    return { ...base, status: 'failed', reason: `${label} already sets ${mapping.name} to a different or non-literal value`, edits: [] };
  }
  if (info.opaque) return { ...base, status: 'failed', reason: `${label} has spread/computed members that may define ${mapping.name}`, edits: [] };
  const quote = preferredQuote(source, info.node);
  const entry = `${keyText(mapping.name, quote)}: ${valueText(mapping.value, quote)}`;
  const reason = parentOf(mapping).length
    ? `Add required ${mapping.location} field ${dotted(parentOf(mapping), mapping.name)} = ${JSON.stringify(mapping.value)} (explicit nested value mapping, parent ${parentOf(mapping).join('.')})`
    : `Add required ${mapping.location} field ${mapping.name} = ${JSON.stringify(mapping.value)} (explicit value mapping)`;
  const properties = info.node.properties;
  if (!properties.length) {
    const open = info.node.getStart(source) + 1;
    return { ...base, status: 'applied', reason, edits: [{ start: open, end: open, newText: ` ${entry} `, reason }] };
  }
  const last = properties[properties.length - 1]!;
  const multiline = source.getLineAndCharacterOfPosition(last.getStart(source)).line !== source.getLineAndCharacterOfPosition(info.node.getStart(source)).line;
  const text = multiline ? `,\n${lineIndent(source, last.getStart(source))}${entry}` : `, ${entry}`;
  return { ...base, status: 'applied', reason, edits: [{ start: last.getEnd(), end: last.getEnd(), newText: text, reason }] };
}

/**
 * Follow `parent` through nested inline object literals by static keys. Every object on the path must be
 * free of spread/computed members and duplicate keys; anything else is reported as a reason.
 */
function nestedObject(info: ObjectInfo, parent: readonly string[], call: ts.CallExpression, source: ts.SourceFile, label: string): { info: ObjectInfo; label: string } | { absent: string } | { failed: string } {
  let current = info;
  let currentLabel = label;
  for (const segment of parent) {
    const members = current.keys.get(segment) ?? [];
    if (current.opaque) return { failed: `${currentLabel} has spread/computed members; nested path ${parent.join('.')} cannot be followed safely` };
    if (!members.length) return { absent: `${currentLabel} has no ${segment} property` };
    if (members.length > 1) return { failed: `${currentLabel} defines ${segment} more than once` };
    const member = members[0]!;
    if (!ts.isPropertyAssignment(member)) return { failed: `${currentLabel}.${segment} is not an inline object literal` };
    const next = objectInfo(member.initializer, call, source);
    if (typeof next === 'string' || !next) return { failed: `${currentLabel}.${segment} is not an inline object literal` };
    current = next;
    currentLabel = `${currentLabel}.${segment}`;
  }
  if (current.opaque && parent.length) return { failed: `${currentLabel} has spread/computed members` };
  return { info: current, label: currentLabel };
}

function renameInUrl(url: UrlLiteral, query: QueryInfo, mapping: RenameMapping): MappingOutcome {
  const base = { kind: 'rename' as const, location: mapping.location, names: [mapping.from, mapping.to] };
  const matches = query.params.filter(param => param.name === mapping.from);
  if (!matches.length) return query.dynamicNames
    ? { ...base, status: 'failed', reason: `URL query has dynamic parameter names; ${mapping.from} cannot be ruled out`, edits: [] }
    : { ...base, status: 'absent', reason: `URL query has no ${mapping.from} parameter`, edits: [] };
  if (matches.length > 1) return { ...base, status: 'failed', reason: `URL query repeats ${mapping.from}`, edits: [] };
  if (query.params.some(param => param.name === mapping.to)) return { ...base, status: 'failed', reason: `URL query already contains ${mapping.to}`, edits: [] };
  const text = encodeQueryComponent(mapping.to);
  if (!literalSafe(text, url.quote)) return { ...base, status: 'failed', reason: `${mapping.to} cannot be written safely into the literal`, edits: [] };
  const reason = `Rename query parameter ${mapping.from} → ${mapping.to} (explicit rename mapping)`;
  return { ...base, status: 'applied', reason, edits: [{ start: matches[0]!.nameStart, end: matches[0]!.nameEnd, newText: text, reason }] };
}

function valueInUrl(url: UrlLiteral, query: QueryInfo, match: PathMatch | string, mapping: RequiredValueMapping): MappingOutcome {
  const base = { kind: 'value' as const, location: mapping.location, names: [mapping.name] };
  const existing = query.params.filter(param => param.name === mapping.name);
  if (existing.length) {
    return existing.length === 1 && existing[0]!.value === String(mapping.value)
      ? { ...base, status: 'applied', reason: `URL query already sets ${mapping.name} to the configured value`, edits: [] }
      : { ...base, status: 'failed', reason: `URL query already sets ${mapping.name} to a different or dynamic value`, edits: [] };
  }
  if (query.dynamicNames) return { ...base, status: 'failed', reason: `URL query has dynamic parameter names; ${mapping.name} cannot be ruled out`, edits: [] };
  const pair = `${encodeQueryComponent(mapping.name)}=${encodeQueryComponent(String(mapping.value))}`;
  if (!literalSafe(pair, url.quote)) return { ...base, status: 'failed', reason: `${mapping.name} cannot be written safely into the literal`, edits: [] };
  const reason = `Add required query parameter ${mapping.name}=${String(mapping.value)} (explicit value mapping)`;
  let position: number;
  let text: string;
  if (query.question !== undefined) {
    const last = url.tokens[query.end - 1]!;
    position = tokenEnd(last);
    text = query.end - 1 === query.question || isChar(last, '&') ? pair : `&${pair}`;
  } else {
    if (typeof match === 'string') return { ...base, status: 'failed', reason: `cannot locate the end of the URL path: ${match}`, edits: [] };
    if (match.pathEnd === 0) return { ...base, status: 'failed', reason: 'URL has no editable path', edits: [] };
    // Path end is either the end of the URL or a trailing slash right before it.
    if (match.pathEnd < url.tokens.length - 1 || (match.pathEnd === url.tokens.length - 1 && !isChar(url.tokens[match.pathEnd], '/'))) return { ...base, status: 'failed', reason: 'URL has a fragment; query insertion is not supported', edits: [] };
    position = tokenEnd(url.tokens[url.tokens.length - 1]!);
    text = `?${pair}`;
  }
  return { ...base, status: 'applied', reason, edits: [{ start: position, end: position, newText: text, reason }] };
}

/**
 * Response variables of the call: the symbols behind the scanner's `response-property` bindings, plus the
 * variables the scanner binds the same way (`const res = await call; const data = await res.json()` for
 * fetch, `const response = await call` for axios) so that a variable read only through destructuring is
 * found as well. For axios the root is the response object and reads must go through `.data`.
 */
function responseRoots(ctx: UseContext): Set<ts.Symbol> {
  const { source, checker } = ctx.parsed;
  const roots = new Set<ts.Symbol>();
  for (const binding of ctx.use.bindings) {
    if (binding.kind !== 'response-property') continue;
    const access = findIdentifier(source, binding.range.start, binding.range.end)?.parent;
    if (!access || !ts.isPropertyAccessExpression(access)) continue;
    let root: ts.Expression = access.expression;
    if (ctx.use.client === 'axios' && ts.isPropertyAccessExpression(root) && root.name.text === 'data') root = root.expression;
    const symbol = ts.isIdentifier(root) ? checker.getSymbolAtLocation(root) : undefined;
    if (symbol) roots.add(symbol);
  }
  const constDeclaration = (node: ts.Node): node is ts.VariableDeclaration & { name: ts.Identifier; initializer: ts.Expression } =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !!node.initializer && !!(node.parent.flags & ts.NodeFlags.Const);
  const awaited = (node: ts.Expression) => ts.isAwaitExpression(node) ? node.expression : node;
  const responses = new Set<ts.Symbol>();
  function findResponses(node: ts.Node): void {
    if (constDeclaration(node) && awaited(node.initializer) === ctx.call) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) responses.add(symbol);
    }
    ts.forEachChild(node, findResponses);
  }
  findResponses(source);
  if (ctx.use.client === 'axios') { for (const symbol of responses) roots.add(symbol); return roots; }
  function findData(node: ts.Node): void {
    if (constDeclaration(node)) {
      const initializer = awaited(node.initializer);
      if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === 'json'
        && ts.isIdentifier(initializer.expression.expression) && responses.has(checker.getSymbolAtLocation(initializer.expression.expression)!)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) roots.add(symbol);
      }
    }
    ts.forEachChild(node, findData);
  }
  findData(source);
  return roots;
}

/**
 * Rename reads of response field `parent.from` reached from the call's response variable: property-access
 * chains (including optional chaining) and `const`/`let` object destructuring from the variable. Only the leaf
 * name changes. Element access, aliasing, rest/computed patterns, destructuring assignments and any other use
 * of an object on the path are never edited and leave a caveat.
 */
function renameResponse(ctx: UseContext, mapping: RenameMapping): MappingOutcome {
  const parent = parentOf(mapping);
  const target = [...parent, mapping.from];
  const base = { kind: 'rename' as const, location: mapping.location, names: [mapping.from, mapping.to], ...(parent.length ? { parent } : {}) };
  const { source, checker } = ctx.parsed;
  const roots = responseRoots(ctx);
  if (!roots.size) return { ...base, status: 'absent', reason: `no statically bound access to response field ${dotted(parent, mapping.from)}`, edits: [] };
  const reason = parent.length
    ? `Rename response field access ${dotted(parent, mapping.from)} → ${dotted(parent, mapping.to)} (explicit nested rename mapping, parent ${parent.join('.')})`
    : `Rename response field access ${mapping.from} → ${mapping.to} (explicit rename mapping)`;
  const edits: Draft[] = [];
  const caveats = new Set<string>();
  /** Caveats that only exist since nested/destructuring support; they make a no-edit outcome partial. */
  let specific = false;
  let invalid: string | undefined;
  const quote = preferredQuote(source, source);
  const label = (depth: number) => ['response', ...target.slice(0, depth)].join('.');

  function destructure(declaration: ts.VariableDeclaration, pattern: ts.ObjectBindingPattern, depth: number): void {
    specific = true;
    if (!(declaration.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) { caveats.add(`${label(depth)} is destructured in a var declaration, which is not edited`); return; }
    for (let k = depth; k < target.length; k++) {
      const segment = target[k]!;
      const keyOf = (element: ts.BindingElement) => element.propertyName ? propertyName(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (pattern.elements.some(element => element.dotDotDotToken)) { caveats.add(`destructuring of ${label(k)} uses a rest element that may hold ${dotted(parent, mapping.from)}`); return; }
      if (pattern.elements.some(element => keyOf(element) === undefined)) { caveats.add(`destructuring of ${label(k)} uses computed keys`); return; }
      const matches = pattern.elements.filter(element => keyOf(element) === segment);
      if (!matches.length) return;
      if (matches.length > 1) { caveats.add(`destructuring of ${label(k)} reads ${segment} more than once`); return; }
      const element = matches[0]!;
      if (k === target.length - 1) {
        if (pattern.elements.some(item => keyOf(item) === mapping.to)) { caveats.add(`destructuring of ${label(k)} already reads ${mapping.to}`); return; }
        if (element.propertyName) {
          const name = element.propertyName;
          const original = source.text[name.getStart(source)];
          const text = ts.isStringLiteral(name) && (original === '"' || original === "'") ? stringLiteral(mapping.to, original) : keyText(mapping.to, quote);
          edits.push({ start: name.getStart(source), end: name.getEnd(), newText: text, reason });
        } else {
          const name = element.name as ts.Identifier;
          edits.push({ start: name.getStart(source), end: name.getEnd(), newText: `${keyText(mapping.to, quote)}: ${name.text}`, reason });
        }
        return;
      }
      if (!ts.isObjectBindingPattern(element.name)) { caveats.add(`${label(k + 1)} is bound to a variable or array pattern; its reads are not followed`); return; }
      pattern = element.name;
    }
  }

  function follow(start: ts.Expression): void {
    let current: ts.Node = start;
    let depth = 0;
    for (;;) {
      let up: ts.Node = current.parent;
      while ((ts.isParenthesizedExpression(up) || ts.isNonNullExpression(up)) && up.expression === current) { current = up; up = up.parent; }
      if (ts.isPropertyAccessExpression(up) && up.expression === current) {
        if (up.name.text !== target[depth]) return; // a different field: not affected
        depth++;
        if (depth === target.length) {
          if (!isIdentifierName(mapping.to)) { invalid = `${mapping.to} is not a valid identifier for property access`; return; }
          edits.push({ start: up.name.getStart(source), end: up.name.getEnd(), newText: mapping.to, reason });
          return;
        }
        current = up;
        continue;
      }
      if (ts.isElementAccessExpression(up) && up.expression === current) {
        if (depth) specific = true;
        caveats.add(`element access on ${label(depth)} is not followed`);
        return;
      }
      if (ts.isVariableDeclaration(up) && up.initializer === current && ts.isObjectBindingPattern(up.name)) { destructure(up, up.name, depth); return; }
      if (ts.isBinaryExpression(up) && up.right === current && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(up.left) || ts.isArrayLiteralExpression(up.left))) {
        specific = true;
        caveats.add(`${label(depth)} is destructured in an assignment, which is not edited`);
        return;
      }
      if (depth) specific = true;
      caveats.add(depth
        ? `${label(depth)} is also used in ways APIPatch cannot follow; other reads of ${dotted(parent, mapping.from)} may remain`
        : `the response object is also used in ways APIPatch cannot follow; other reads of ${dotted(parent, mapping.from)} may remain`);
      return;
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && roots.has(checker.getSymbolAtLocation(node)!)) {
      const parentNode = node.parent;
      const declaration = ts.isVariableDeclaration(parentNode) && parentNode.name === node;
      if (!declaration) {
        if (ctx.use.client !== 'axios') follow(node);
        else if (ts.isPropertyAccessExpression(parentNode) && parentNode.expression === node) {
          // axios: response.status is harmless; reads of the body go through response.data.
          if (parentNode.name.text === 'data') follow(parentNode);
        } else caveats.add(`the response object is also used in ways APIPatch cannot follow; other reads of ${dotted(parent, mapping.from)} may remain`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (invalid) return { ...base, status: 'failed', reason: invalid, edits: [] };
  const caveat = caveats.size ? [...caveats].join('; ') : undefined;
  if (!edits.length) {
    if (caveat && (specific || parent.length)) return { ...base, status: 'applied', reason: `no response read of ${dotted(parent, mapping.from)} could be edited`, edits: [], caveat };
    return { ...base, status: 'absent', reason: `no statically bound access to response field ${dotted(parent, mapping.from)}`, edits: [] };
  }
  return { ...base, status: 'applied', reason, edits, ...(caveat ? { caveat } : {}) };
}

function planUse(ctx: UseContext, index: MigrationIndex): { outcomes: MappingOutcome[]; fatal?: string } {
  const outcomes: MappingOutcome[] = [];
  const shape = callShape(ctx.call, ctx.use.client);
  const url = tokenizeUrl(ctx.parsed.source, shape.url ? unwrap(shape.url) : undefined);
  const match = typeof url === 'string' ? url : matchPath(ctx.parsed.source, url, ctx.source.path);
  if (ctx.source.id !== ctx.target.id) {
    const outcome = planOperation(ctx, url, match);
    outcomes.push(outcome);
    if (outcome.status !== 'applied') return { outcomes, fatal: outcome.reason };
  }
  const query = typeof url === 'string' ? undefined : parseQuery(url);
  const params = objectInfo(shape.params, ctx.call, ctx.parsed.source);
  const body = objectInfo(shape.body, ctx.call, ctx.parsed.source);
  for (const mapping of index.renames.get(ctx.target.id) ?? []) {
    if (mapping.location === 'response') { outcomes.push(renameResponse(ctx, mapping)); continue; }
    const names = [mapping.from, mapping.to];
    if (mapping.location === 'request') {
      const parent = parentOf(mapping);
      const at = parent.length ? { parent } : {};
      if (typeof body === 'string') outcomes.push({ kind: 'rename', location: 'request', names, ...at, status: 'failed', reason: `request body ${body}`, edits: [] });
      else if (!body) outcomes.push({ kind: 'rename', location: 'request', names, ...at, status: 'absent', reason: 'call has no request body', edits: [] });
      else {
        const nested = nestedObject(body, parent, ctx.call, ctx.parsed.source, 'request body');
        if ('absent' in nested) outcomes.push({ kind: 'rename', location: 'request', names, ...at, status: 'absent', reason: nested.absent, edits: [] });
        else if ('failed' in nested) outcomes.push({ kind: 'rename', location: 'request', names, ...at, status: 'failed', reason: nested.failed, edits: [] });
        else outcomes.push(renameInObject(nested.info, mapping, ctx.parsed.source, nested.label));
      }
      continue;
    }
    if (typeof params === 'string') { outcomes.push({ kind: 'rename', location: 'query', names, status: 'failed', reason: `request options ${params}`, edits: [] }); continue; }
    if (!query) { outcomes.push({ kind: 'rename', location: 'query', names, status: 'failed', reason: url as string, edits: [] }); continue; }
    const inUrl = renameInUrl(url as UrlLiteral, query, mapping);
    const inParams = params ? renameInObject(params, mapping, ctx.parsed.source, 'axios params') : undefined;
    if (inParams && inParams.status !== 'absent' && inUrl.status !== 'absent') outcomes.push({ kind: 'rename', location: 'query', names, status: 'failed', reason: `${mapping.from} is set both in the URL and in params`, edits: [] });
    else outcomes.push(inParams && inParams.status !== 'absent' ? inParams : inUrl);
  }
  for (const mapping of index.values.get(ctx.target.id) ?? []) {
    const names = [mapping.name];
    if (mapping.location === 'request') {
      const parent = parentOf(mapping);
      const at = parent.length ? { parent } : {};
      if (typeof body === 'string') outcomes.push({ kind: 'value', location: 'request', names, ...at, status: 'failed', reason: `request body ${body}`, edits: [] });
      else if (!body) outcomes.push({ kind: 'value', location: 'request', names, ...at, status: 'failed', reason: 'call has no request body object to extend', edits: [] });
      else {
        const nested = nestedObject(body, parent, ctx.call, ctx.parsed.source, 'request body');
        if ('absent' in nested) outcomes.push({ kind: 'value', location: 'request', names, ...at, status: 'failed', reason: `${nested.absent}; no nested object to extend`, edits: [] });
        else if ('failed' in nested) outcomes.push({ kind: 'value', location: 'request', names, ...at, status: 'failed', reason: nested.failed, edits: [] });
        else outcomes.push(valueInObject(nested.info, mapping, ctx.parsed.source, nested.label));
      }
      continue;
    }
    if (typeof params === 'string') { outcomes.push({ kind: 'value', location: 'query', names, status: 'failed', reason: `request options ${params}`, edits: [] }); continue; }
    if (params && params.keys.has(mapping.name)) { outcomes.push(valueInObject(params, mapping, ctx.parsed.source, 'axios params')); continue; }
    if (!query) { outcomes.push({ kind: 'value', location: 'query', names, status: 'failed', reason: url as string, edits: [] }); continue; }
    if (params) outcomes.push(valueInObject(params, mapping, ctx.parsed.source, 'axios params'));
    else outcomes.push(valueInUrl(url as UrlLiteral, query, match, mapping));
  }
  return { outcomes };
}

/** Combine touching edits (e.g. a replacement followed by an insertion) and reject overlaps. */
function mergeDrafts(drafts: Draft[]): Draft[] | undefined {
  const sorted = [...drafts].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Draft[] = [];
  for (const draft of sorted) {
    const previous = result[result.length - 1];
    if (previous && draft.start < previous.end) return undefined;
    if (previous && draft.start === previous.end && (previous.start === previous.end || draft.start === draft.end)) {
      result[result.length - 1] = { start: previous.start, end: draft.end, newText: previous.newText + draft.newText, reason: `${previous.reason}; ${draft.reason}` };
      continue;
    }
    result.push(draft);
  }
  return result;
}

/** Edits from different calls conflict when they intersect or an insertion touches the other edit. */
function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  if (a.start < b.end && b.start < a.end) return true;
  const touches = (insert: { start: number; end: number }, other: { start: number; end: number }) => insert.start === insert.end && insert.start >= other.start && insert.start <= other.end;
  return touches(a, b) || touches(b, a);
}

type FindingState = { status: 'resolved' | 'partial' | 'pending'; reason: string };

/** Build a reviewable repair plan. Never writes to the repository. */
export async function planRepairs(options: PlanRepairsOptions): Promise<RepairPlan> {
  let report: RunReport;
  try { report = validateDocument('RunReport', options.report); } catch (error) {
    throw new RepairError('INVALID_REPORT', error instanceof ContractError ? `report#${error.path}` : 'report', (error as Error).message);
  }
  let migration: MigrationConfig;
  try { migration = validateMigrationConfig(options.migration); } catch (error) {
    throw new RepairError('INVALID_MIGRATION', error instanceof ContractError ? `migration#${error.path}` : 'migration', (error as Error).message);
  }
  const index = validateMigrationForReport(report, migration);
  let root: string;
  try { root = await realpath(options.repository); } catch { throw new RepairError('INVALID_REPOSITORY', options.repository, 'repository does not exist'); }

  const diagnostics: Diagnostic[] = [];
  const states = new Map<string, FindingState>();
  const changes = new Map(report.changes.map(change => [change.id, change]));
  const uses = new Map(report.uses.map(use => [use.id, use]));
  const byUse = new Map<string, Finding[]>();
  const explanations: string[] = [];
  for (const finding of [...report.findings].sort((a, b) => a.id.localeCompare(b.id))) {
    const change = changes.get(finding.changeId);
    if (finding.reviewStatus === 'rejected') { explanations.push(`Finding ${finding.id}: rejected in review; not repaired.`); continue; }
    if (!change || !uses.has(finding.useId)) { states.set(finding.id, { status: 'pending', reason: 'finding references a change or use missing from the report' }); continue; }
    if (change.classification === 'ambiguous') { states.set(finding.id, { status: 'pending', reason: 'ambiguous change requires manual review' }); continue; }
    if (change.classification === 'compatible') { states.set(finding.id, { status: 'pending', reason: 'change is classified compatible; nothing to repair automatically' }); continue; }
    byUse.set(finding.useId, [...(byUse.get(finding.useId) ?? []), finding]);
  }

  const files = new Map<string, { content: string; parsed: ParsedFile } | { error: FileAccessError }>();
  const accepted = new Map<string, TextEdit[]>();
  const useOrder = [...byUse.keys()].map(id => uses.get(id)!).sort((a, b) => a.file.localeCompare(b.file) || a.range.start - b.range.start);
  for (const use of useOrder) {
    const findings = byUse.get(use.id)!;
    const pendAll = (reason: string) => { for (const finding of findings) states.set(finding.id, { status: 'pending', reason }); };
    if (use.via) { pendAll(`call is made through wrapper ${use.via.name} (${use.via.file}:${use.via.range.line}); wrapper calls are not edited in this release`); continue; }
    if (use.resolution === 'unresolved' || use.confidence === 'low') { pendAll('call target is unresolved or low confidence; review the API origin and URL before editing'); continue; }
    if (!use.method) { pendAll('HTTP method of the call is unknown'); continue; }
    if (migration.allowedOrigins.length && (!use.origin || !migration.allowedOrigins.includes(use.origin))) { pendAll(use.origin ? `origin ${use.origin} is not in migration.allowedOrigins` : 'origin of the call is unknown and migration.allowedOrigins is restricted'); continue; }
    const sources = use.operationIds.filter(id => index.oldOps.has(id));
    if (sources.length !== 1) { pendAll(sources.length ? 'call matches several source operations' : 'call is not bound to a source operation'); continue; }
    const source = index.oldOps.get(sources[0]!)!;
    if (source.method !== use.method) { pendAll('call method does not match the source operation'); continue; }
    const targetId = index.targets.get(source.id) ?? (index.newOps.has(source.id) ? source.id : undefined);
    if (!targetId) { pendAll('source operation was removed and the migration has no explicit operation mapping for it'); continue; }

    let file = files.get(use.file);
    if (!file) {
      try {
        const read = await readRepoFile(root, use.file);
        file = { content: read.content, parsed: parseFile(use.file, read.content) };
      } catch (error) {
        if (!(error instanceof FileAccessError)) throw error;
        file = { error };
      }
      files.set(use.file, file);
    }
    if ('error' in file) {
      diagnostics.push({ code: file.error.code, severity: 'error', message: file.error.message, file: use.file });
      pendAll(`file cannot be edited safely: ${file.error.message}`);
      continue;
    }
    if (sha256(file.content) !== use.fileHash) {
      diagnostics.push({ code: 'REPAIR_STALE_FILE', severity: 'warning', message: 'File changed after analysis; rescan before repairing', file: use.file });
      pendAll('file changed after analysis');
      continue;
    }
    const call = findCall(file.parsed.source, use.range.start, use.range.end);
    if (!call) { pendAll('reported call range no longer matches a call expression'); continue; }
    const ctx: UseContext = { use, parsed: file.parsed, call, source, target: index.newOps.get(targetId)! };
    const { outcomes, fatal } = planUse(ctx, index);

    // Attribute outcomes to findings.
    const failures = outcomes.filter(outcome => outcome.status === 'failed');
    const attribution = new Map<MappingOutcome, string[]>();
    const authorizedBy = new Map<string, string>();
    for (const finding of findings) {
      const change = changes.get(finding.changeId)!;
      if (fatal) { states.set(finding.id, { status: 'pending', reason: fatal }); continue; }
      if (isOperationLevel(change)) {
        const operation = outcomes.find(outcome => outcome.kind === 'operation');
        if (!operation) { states.set(finding.id, { status: 'pending', reason: 'operation-level change without an explicit operation mapping' }); continue; }
        const caveats = outcomes.filter(outcome => outcome.caveat).map(outcome => outcome.caveat!);
        const notes = [...new Set([...failures.map(outcome => outcome.reason), ...caveats, ...unmetMoveObligations(ctx.source, ctx.target, outcomes)])];
        states.set(finding.id, notes.length ? { status: 'partial', reason: `route updated; not demonstrated: ${notes.join('; ')}` } : { status: 'resolved', reason: `all destination obligations covered: ${outcomes.filter(o => o.status === 'applied').map(o => o.reason).join('; ')}` });
        // The explicit operation mapping authorizes the destination's explicit mappings for this call, even
        // when compare reported no field change for the removed/added pair.
        for (const outcome of outcomes) attribution.set(outcome, [...(attribution.get(outcome) ?? []), finding.id]);
        authorizedBy.set(finding.id, operation.reason);
        continue;
      }
      if (!['query', 'request', 'response'].includes(change.location)) { states.set(finding.id, { status: 'pending', reason: `${change.location} changes are not repaired automatically` }); continue; }
      const { names: subjects, parent: subjectParent, unsupported } = changeSubjects(change, report);
      if (unsupported) { states.set(finding.id, { status: 'pending', reason: unsupported }); continue; }
      if (!subjects.size) { states.set(finding.id, { status: 'pending', reason: 'the changed field is not identified structurally (no parameter pointer or fieldPath)' }); continue; }
      const wanted = JSON.stringify(subjectParent ?? []);
      const relevant = outcomes.filter(outcome => outcome.location === change.location && JSON.stringify(outcome.parent ?? []) === wanted && outcome.names.some(name => subjects.has(name)));
      if (!relevant.length) { states.set(finding.id, { status: 'pending', reason: subjectParent ? `nested field ${dotted(subjectParent, [...subjects][0]!)} is outside the supported repair scope: no explicit nested migration mapping with parent ${subjectParent.join('.')}` : `no explicit migration mapping for ${[...subjects].join(', ')}` }); continue; }
      const applied = relevant.filter(outcome => outcome.status === 'applied');
      const failed = relevant.filter(outcome => outcome.status === 'failed');
      for (const outcome of applied) attribution.set(outcome, [...(attribution.get(outcome) ?? []), finding.id]);
      if (!applied.length) states.set(finding.id, { status: 'pending', reason: relevant.map(outcome => outcome.reason).join('; ') });
      else if (failed.length || applied.some(outcome => outcome.caveat)) states.set(finding.id, { status: 'partial', reason: [...failed.map(o => o.reason), ...applied.filter(o => o.caveat).map(o => o.caveat!)].join('; ') });
      else states.set(finding.id, { status: 'resolved', reason: applied.map(outcome => outcome.reason).join('; ') });
    }
    if (fatal) continue;
    // Only edits attributed to a finding (directly, or through an explicit operation mapping) are planned.
    // Applied mappings without a related finding are reported as migration-only and left out of the patch.
    const drafts: { draft: Draft; findingIds: string[] }[] = [];
    for (const outcome of outcomes) {
      if (outcome.status !== 'applied' || !outcome.edits.length) continue;
      const ids = (attribution.get(outcome) ?? []).filter(id => states.get(id)?.status !== 'pending');
      if (!ids.length) { explanations.push(`Migration-only mapping on ${use.file}:${use.range.line} not applied: ${outcome.reason} — no non-pending finding of this call concerns ${outcome.names.join(' / ')}.`); continue; }
      const via = outcome.kind === 'operation' ? [] : ids.filter(id => authorizedBy.has(id));
      const suffix = via.length ? ` [authorized by ${authorizedBy.get(via[0]!)}]` : '';
      for (const draft of outcome.edits) drafts.push({ draft: { ...draft, reason: draft.reason + suffix }, findingIds: ids });
    }
    const merged = mergeDrafts(drafts.map(item => item.draft));
    const useFindingIds = findings.map(finding => finding.id).filter(id => states.get(id)?.status !== 'pending');
    if (!merged) { pendAll('planned edits for this call overlap'); diagnostics.push({ code: 'REPAIR_EDIT_OVERLAP', severity: 'warning', message: 'Planned edits overlap', file: use.file }); continue; }
    const edits: TextEdit[] = merged.map(draft => {
      const ids = [...new Set(drafts.filter(item => item.draft.start >= draft.start && item.draft.end <= draft.end).flatMap(item => item.findingIds))].sort();
      return { start: draft.start, end: draft.end, oldText: file.content.slice(draft.start, draft.end), newText: draft.newText, findingIds: ids.length ? ids : useFindingIds, reason: draft.reason };
    });
    const existing = accepted.get(use.file) ?? [];
    if (edits.some(edit => existing.some(other => overlaps(edit, other)))) {
      pendAll('edits for this call overlap edits planned for another call');
      diagnostics.push({ code: 'REPAIR_EDIT_OVERLAP', severity: 'warning', message: 'Edits for different calls overlap; second call left pending', file: use.file });
      continue;
    }
    if (edits.length) accepted.set(use.file, [...existing, ...edits]);
  }

  // Build patches; refuse any file whose patched text gains syntax errors.
  const patches: FilePatch[] = [];
  const diffs: string[] = [];
  for (const file of [...accepted.keys()].sort()) {
    const entry = files.get(file) as { content: string };
    const edits = accepted.get(file)!.sort((a, b) => a.start - b.start || a.end - b.end);
    const after = applyEdits(entry.content, edits);
    if (syntaxErrors(file, after) > syntaxErrors(file, entry.content)) {
      diagnostics.push({ code: 'REPAIR_SYNTAX_REGRESSION', severity: 'error', message: 'Patched file would not parse; edits discarded', file });
      for (const id of edits.flatMap(edit => edit.findingIds)) states.set(id, { status: 'pending', reason: 'patched file would not parse' });
      continue;
    }
    patches.push({ file, originalHash: sha256(entry.content), edits });
    diffs.push(fileDiff(file, entry.content, after));
  }

  const resolvedFindingIds: string[] = [], partialFindingIds: string[] = [], pendingFindingIds: string[] = [];
  for (const [id, state] of [...states].sort((a, b) => a[0].localeCompare(b[0]))) {
    (state.status === 'resolved' ? resolvedFindingIds : state.status === 'partial' ? partialFindingIds : pendingFindingIds).push(id);
    const finding = report.findings.find(item => item.id === id)!;
    const use = uses.get(finding.useId);
    explanations.push(`Finding ${id}${use ? ` (${use.file}:${use.range.line})` : ''}: ${state.status} — ${state.reason}`);
  }
  for (const patch of patches) for (const edit of patch.edits) explanations.push(`Edit ${patch.file}@${edit.start}-${edit.end}: ${edit.reason} [${edit.findingIds.join(', ')}]`);
  const plan: RepairPlan = {
    schemaVersion: SCHEMA_VERSION, id: '', reportId: report.id, migration, applicationStatus: 'proposed', files: patches,
    resolvedFindingIds, partialFindingIds, pendingFindingIds, unifiedDiff: diffs.join(''), explanations, diagnostics,
  };
  plan.id = planId(plan);
  return validateDocument('RepairPlan', plan);
}

// ---------------------------------------------------------------------------
// Application

interface Prepared { patch: FilePatch; file: RepoFile; after: string }

async function writeReplacing(target: RepoFile, content: string, expectedHash: string, hook?: () => void | Promise<void>): Promise<void> {
  const dir = path.dirname(target.full);
  const temp = path.join(dir, `.${path.basename(target.full)}.apipatch-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, target.mode);
  try {
    try { await handle.writeFile(content, 'utf8'); await handle.chmod(target.mode); await handle.sync(); } finally { await handle.close(); }
    await hook?.();
    // Re-check identity and content immediately before replacing.
    const stat = await lstat(target.full);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== target.dev || stat.ino !== target.ino) throw new FileAccessError('REPAIR_CONFLICT', 'File was replaced after validation');
    const current = await readFile(target.full);
    if (sha256(current) !== expectedHash) throw new FileAccessError('REPAIR_CONFLICT', 'File changed after validation');
    await rename(temp, target.full);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  try { const dirHandle = await open(dir, constants.O_RDONLY); try { await dirHandle.sync(); } finally { await dirHandle.close(); } } catch { /* directory fsync is best effort */ }
}

/**
 * Apply a reviewed plan to `repository`. All files are validated before any write; each file is replaced
 * atomically via temporary file + rename. Across files the operation is not atomic: on failure, files
 * already replaced are restored when they still contain exactly what APIPatch wrote.
 */
export async function applyRepairPlan(plan: RepairPlan, repository: string, options: ApplyOptions = {}): Promise<ApplyResult> {
  try { validateDocument('RepairPlan', plan); } catch (error) {
    throw new RepairError('INVALID_PLAN', error instanceof ContractError ? `plan#${error.path}` : 'plan', (error as Error).message);
  }
  if (planId(plan) !== plan.id) throw new RepairError('PLAN_TAMPERED', 'plan#$.id', 'plan id does not match its migration and edits');
  const names = plan.files.map(patch => patch.file);
  if (new Set(names).size !== names.length) throw new RepairError('INVALID_PLAN', 'plan#$.files', 'duplicate file entries');
  if (plan.files.some(patch => patch.edits.some(edit => edit.newText.includes('\0')))) throw new RepairError('INVALID_PLAN', 'plan#$.files', 'edits contain NUL bytes');
  let root: string;
  try { root = await realpath(repository); } catch { throw new RepairError('INVALID_REPOSITORY', repository, 'repository does not exist'); }

  const diagnostics: Diagnostic[] = [];
  const conflicts: string[] = [];
  const pending: Prepared[] = [];
  const done: string[] = [];
  const diffs = new Map<string, string>();
  for (const patch of [...plan.files].sort((a, b) => a.file.localeCompare(b.file))) {
    let file: RepoFile;
    try { file = await readRepoFile(root, patch.file); } catch (error) {
      if (!(error instanceof FileAccessError)) throw error;
      diagnostics.push({ code: error.code, severity: 'error', message: error.message, file: patch.file });
      conflicts.push(patch.file);
      continue;
    }
    const hash = sha256(file.content);
    if (hash === patch.originalHash) {
      let after: string;
      try { after = applyEdits(file.content, patch.edits); } catch (error) {
        if (!(error instanceof FileAccessError)) throw error;
        throw new RepairError('PLAN_TAMPERED', `plan#$.files[${patch.file}]`, error.message);
      }
      pending.push({ patch, file, after });
      diffs.set(patch.file, fileDiff(patch.file, file.content, after));
      continue;
    }
    const original = revertEdits(file.content, patch.edits);
    if (original !== undefined && sha256(original) === patch.originalHash) {
      done.push(patch.file);
      diffs.set(patch.file, fileDiff(patch.file, original, file.content));
      continue;
    }
    diagnostics.push({ code: 'REPAIR_CONFLICT', severity: 'error', message: 'File changed after analysis; not overwritten', file: patch.file });
    conflicts.push(patch.file);
  }
  if (conflicts.length) return { schemaVersion: SCHEMA_VERSION, planId: plan.id, status: 'conflict', files: conflicts, diagnostics };
  // What is applied must be exactly what was reviewed.
  const expectedDiff = plan.files.map(patch => patch.file).sort().map(file => diffs.get(file)!).join('');
  if (expectedDiff !== plan.unifiedDiff) throw new RepairError('PLAN_TAMPERED', 'plan#$.unifiedDiff', 'unified diff does not match the planned edits');
  for (const file of done) diagnostics.push({ code: 'REPAIR_ALREADY_APPLIED', severity: 'info', message: 'Edits already present; file left unchanged', file });
  if (!plan.files.length) diagnostics.push({ code: 'REPAIR_EMPTY_PLAN', severity: 'info', message: 'Plan contains no edits' });
  if (!pending.length) return { schemaVersion: SCHEMA_VERSION, planId: plan.id, status: 'applied', files: done, diagnostics };

  const replaced: Prepared[] = [];
  for (const item of pending) {
    try {
      await writeReplacing(item.file, item.after, item.patch.originalHash, options.beforeReplace && (() => options.beforeReplace!(item.patch.file)));
      replaced.push(item);
    } catch (error) {
      const code = error instanceof FileAccessError ? error.code : 'REPAIR_WRITE_FAILED';
      diagnostics.push({ code, severity: 'error', message: `Application stopped: ${(error as Error).message}`, file: item.patch.file });
      for (const previous of replaced.reverse()) {
        try {
          const current = await readRepoFile(root, previous.patch.file);
          if (sha256(current.content) !== sha256(previous.after)) throw new FileAccessError('REPAIR_ROLLBACK_SKIPPED', 'File modified after APIPatch wrote it; not restored');
          await writeReplacing(current, previous.file.content, sha256(previous.after));
          diagnostics.push({ code: 'REPAIR_ROLLED_BACK', severity: 'warning', message: 'Restored original content after failure', file: previous.patch.file });
        } catch (rollbackError) {
          diagnostics.push({ code: rollbackError instanceof FileAccessError ? rollbackError.code : 'REPAIR_ROLLBACK_FAILED', severity: 'error', message: `Rollback failed: ${(rollbackError as Error).message}`, file: previous.patch.file });
        }
      }
      return { schemaVersion: SCHEMA_VERSION, planId: plan.id, status: 'conflict', files: [item.patch.file], diagnostics };
    }
  }
  for (const item of replaced) diagnostics.push({ code: 'REPAIR_APPLIED', severity: 'info', message: `${item.patch.edits.length} edit(s) applied`, file: item.patch.file });
  return { schemaVersion: SCHEMA_VERSION, planId: plan.id, status: 'applied', files: [...replaced.map(item => item.patch.file), ...done].sort(), diagnostics };
}
