import type { ApiChange, JsonValue } from '../contracts/index.js';
import { canonicalJson } from '../contracts/index.js';

export type Direction = 'request' | 'response';
type Classification = ApiChange['classification'];
type Schema = { [key: string]: JsonValue };

/** One directional finding inside a schema, relative to the schema root given by the caller. */
export interface SchemaIssue { rule: string; classification: Classification; explanation: string; pointer: string; field: string; oldValue?: JsonValue; newValue?: JsonValue }
export interface SchemaContext {
  direction: Direction;
  /** Human description of the schema root, e.g. `request body (application/json)`. */
  scope: string;
  /** Name used for the root value in field paths, e.g. `body` or a parameter name. */
  root: string;
  oldVersion: string;
  newVersion: string;
  report(issue: SchemaIssue): void;
}

export const MAX_SCHEMA_DEPTH = 64;
const ANNOTATIONS = new Set(['title', 'description', 'example', 'examples', 'deprecated', '$comment', 'externalDocs', 'xml']);
/** Keywords whose directional effect is modelled below. `nullable` only belongs to OpenAPI 3.0. */
const HANDLED = new Set(['type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'items', 'minItems', 'maxItems', 'uniqueItems', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties', 'readOnly', 'writeOnly', 'default']);
/** Applicators that combine with sibling keywords by conjunction when they are unchanged. */
const COMPOSITION = new Set(['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'discriminator']);
/** Keywords whose meaning depends on sibling keywords, so no sibling change is provable. */
const SIBLING_DEPENDENT = new Set(['unevaluatedProperties', 'unevaluatedItems']);

const isObject = (value: JsonValue | undefined): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = (value: JsonValue | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const same = (a: JsonValue | undefined, b: JsonValue | undefined): boolean => a === b || (a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b));
const escape = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
const isAnnotation = (key: string): boolean => ANNOTATIONS.has(key) || key.startsWith('x-');
const annotationOnly = (value: JsonValue): boolean => isObject(value) && Object.keys(value).every(isAnnotation);
const render = (value: JsonValue): string => { const text = canonicalJson(value); return text.length > 120 ? `${text.slice(0, 117)}...` : text; };

/** Boolean schemas (3.1) and annotation-only `allOf` wrappers produced by 3.1 `$ref` siblings are unwrapped. */
function prepare(value: JsonValue | undefined): Schema {
  if (value === undefined || value === true) return {};
  if (value === false) return { not: {} };
  if (!isObject(value)) return { $apipatchInvalidSchema: value };
  if (Array.isArray(value.allOf) && Object.keys(value).every(key => key === 'allOf' || isAnnotation(key))) {
    const substantive = value.allOf.filter(member => !annotationOnly(member));
    if (substantive.length <= 1) return prepare(substantive[0]);
  }
  return value;
}
function isEmpty(schema: Schema): boolean { return Object.keys(schema).every(isAnnotation); }

function handled(key: string, version: string): boolean { return HANDLED.has(key) || (key === 'nullable' && version.startsWith('3.0.')); }
/** Keywords this comparator does not interpret (composition, unknown or dialect-foreign keywords). */
function opaque(schema: Schema, version: string): Schema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !isAnnotation(key) && !handled(key, version)));
}

/** Allowed JSON types; `undefined` means unconstrained. 3.0 `nullable: true` adds `null`. */
function typeSet(schema: Schema, version: string): Set<string> | undefined {
  const raw = schema.type;
  let types: Set<string>;
  if (typeof raw === 'string') types = new Set([raw]);
  else if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) types = new Set(raw as string[]);
  else return undefined;
  if (version.startsWith('3.0.') && schema.nullable === true) types.add('null');
  return types;
}
const coveredBy = (types: Set<string>, type: string): boolean => types.has(type) || (type === 'integer' && types.has('number'));

interface Bound { value: number; exclusive: boolean }
/** Supports both 3.0 boolean and 3.1 numeric `exclusiveMinimum`/`exclusiveMaximum`; keeps the tightest bound. */
function numericBound(schema: Schema, side: 'lower' | 'upper'): Bound | undefined {
  const [inclusiveKey, exclusiveKey] = side === 'lower' ? ['minimum', 'exclusiveMinimum'] : ['maximum', 'exclusiveMaximum'];
  const inclusive = schema[inclusiveKey], exclusive = schema[exclusiveKey];
  const bounds: Bound[] = [];
  if (isNumber(inclusive)) bounds.push({ value: inclusive, exclusive: exclusive === true });
  if (isNumber(exclusive)) bounds.push({ value: exclusive, exclusive: true });
  bounds.sort((a, b) => side === 'lower' ? b.value - a.value || Number(b.exclusive) - Number(a.exclusive) : a.value - b.value || Number(b.exclusive) - Number(a.exclusive));
  return bounds[0];
}
function countBound(schema: Schema, key: string): Bound | undefined {
  const value = schema[key];
  if (!isNumber(value) || (key.startsWith('min') && value <= 0)) return undefined;
  return { value, exclusive: false };
}
/** `narrow` when the new bound admits fewer values than the old one. */
function compareBounds(before: Bound | undefined, after: Bound | undefined, side: 'lower' | 'upper'): 'narrow' | 'widen' | undefined {
  if (!before && !after) return undefined;
  if (!before) return 'narrow';
  if (!after) return 'widen';
  if (before.value !== after.value) return (after.value > before.value) === (side === 'lower') ? 'narrow' : 'widen';
  if (before.exclusive !== after.exclusive) return after.exclusive ? 'narrow' : 'widen';
  return undefined;
}

function requiredSet(schema: Schema, direction: Direction): Set<string> {
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
  const properties = isObject(schema.properties) ? schema.properties : {};
  // OpenAPI: required readOnly properties only bind responses, required writeOnly properties only bind requests.
  const ignored = direction === 'request' ? 'readOnly' : 'writeOnly';
  return new Set(required.filter(name => { const property = properties[name]; return !(isObject(property) && property[ignored] === true); }));
}

type AdditionalKind = 'open' | 'closed' | 'schema';
function additionalKind(value: JsonValue | undefined): AdditionalKind {
  if (value === false) return 'closed';
  if (value === undefined || value === true || (isObject(value) && isEmpty(prepare(value)))) return 'open';
  return 'schema';
}

/**
 * Exact merge of object-like allOf branches: every branch only uses type object, properties, required and
 * additionalProperties; a property defined twice must be identical; at most one branch restricts additional
 * properties, and then every other branch's properties must be declared by it. Otherwise undefined.
 */
function mergeObjects(branches: Schema[], version: string): Schema | undefined {
  const properties: Schema = {};
  const required = new Set<string>();
  let typed = false, restricted: Schema | undefined;
  for (const branch of branches) {
    for (const key of Object.keys(branch)) if (!isAnnotation(key) && !OBJECT_KEYWORDS.has(key) && !(key === 'nullable' && branch.nullable === false && version.startsWith('3.0.'))) return undefined;
    const types = typeSet(branch, version);
    if (branch.type !== undefined && !(types && types.size === 1 && types.has('object'))) return undefined;
    typed ||= types !== undefined;
    if (branch.properties !== undefined && !isObject(branch.properties)) return undefined;
    if (branch.required !== undefined && !(Array.isArray(branch.required) && branch.required.every(item => typeof item === 'string'))) return undefined;
    for (const [name, schema] of Object.entries(isObject(branch.properties) ? branch.properties : {})) {
      if (Object.hasOwn(properties, name) && !same(properties[name], schema)) return undefined;
      Object.defineProperty(properties, name, { value: schema, writable: true, enumerable: true, configurable: true });
    }
    for (const name of (branch.required as string[] | undefined) ?? []) required.add(name);
    if (additionalKind(branch.additionalProperties) !== 'open') { if (restricted) return undefined; restricted = branch; }
  }
  if (restricted) {
    const declared = isObject(restricted.properties) ? restricted.properties : {};
    if (Object.keys(properties).some(name => !Object.hasOwn(declared, name))) return undefined;
  }
  return {
    ...(typed ? { type: 'object' } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required.size ? { required: [...required].sort() } : {}),
    ...(restricted ? { additionalProperties: restricted.additionalProperties! } : {}),
  };
}

/** Mirrors `RECURSION_ANCHOR` in `src/openapi`: `[{ key, refs }]` on the expansion of a recursion target. */
const ANCHOR = 'x-apipatch-recursion-anchor';
const OBJECT_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties']);
type Side = 'old' | 'new';
interface Anchor { key: string; refs: string[] }
interface Frame { anchors: Anchor[]; schema: JsonValue }
interface Resolved { schema: JsonValue | undefined; id?: string; unresolved?: string }

function anchorsOf(value: JsonValue | undefined): Anchor[] {
  const raw = isObject(value) ? value[ANCHOR] : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Schema => isObject(item) && typeof item.key === 'string' && Array.isArray(item.refs))
    .map(item => ({ key: item.key as string, refs: (item.refs as JsonValue[]).filter((ref): ref is string => typeof ref === 'string') }));
}
const refOf = (value: JsonValue | undefined): string | undefined => isObject(value) && typeof value.$ref === 'string' && Object.keys(value).every(key => key === '$ref' || isAnnotation(key)) ? value.$ref : undefined;
const refCache = new WeakMap<object, boolean>();
function mentionsRef(value: JsonValue | undefined): boolean {
  if (value === null || typeof value !== 'object') return false;
  let known = refCache.get(value);
  if (known === undefined) { known = Array.isArray(value) ? value.some(mentionsRef) : Object.hasOwn(value, '$ref') || Object.values(value).some(mentionsRef); refCache.set(value, known); }
  return known;
}
/** 3.1 `$ref` + annotation siblings arrive as an annotation-only allOf; expose the bare reference so it can be resolved. */
function bareRef(value: JsonValue | undefined): JsonValue | undefined {
  if (!isObject(value) || !Array.isArray(value.allOf)) return value;
  const prepared = prepare(value);
  return refOf(prepared) !== undefined ? prepared : value;
}

class Walker {
  /** Coinductive hypothesis: (old target, new target, direction, composed) pairs already being or already compared. */
  private readonly visited = new Set<string>();
  private readonly frames: Record<Side, Frame[]> = { old: [], new: [] };
  constructor(private readonly ctx: SchemaContext) {}

  /**
   * A retained recursive `$ref` points back to an enclosing expansion of its target, which the loader marks with an
   * anchor listing the reference texts. The nearest enclosing frame wins; frames with different keys claiming the
   * same text make the reference unresolvable.
   */
  private resolve(value: JsonValue | undefined, side: Side): Resolved {
    const ref = refOf(value);
    if (ref === undefined) { const anchors = anchorsOf(value); return { schema: value, ...(anchors.length ? { id: anchors.map(a => a.key).sort().join('\n') } : {}) }; }
    const frames = this.frames[side];
    const keys = new Set<string>();
    let target: Frame | undefined;
    for (let i = frames.length - 1; i >= 0; i--) {
      const matching = frames[i]!.anchors.filter(anchor => anchor.refs.includes(ref));
      if (!matching.length) continue;
      target ??= frames[i];
      for (const anchor of matching) keys.add(anchor.key);
    }
    if (!target || keys.size !== 1) return { schema: value, unresolved: ref };
    return { schema: target.schema, id: [...keys][0]! };
  }
  private push(side: Side, value: JsonValue | undefined): number {
    const anchors = anchorsOf(value);
    if (anchors.length) this.frames[side].push({ anchors, schema: value! });
    return anchors.length ? 1 : 0;
  }

  private subject(field: string): string { return field === this.ctx.root ? `the ${this.ctx.scope} schema` : `"${field}" in ${this.ctx.scope}`; }

  /** Narrowing rejects values accepted before: breaks requests, is safe for responses. Widening is the reverse. */
  private directional(kind: 'narrow' | 'widen', composed: boolean): { classification: Classification; consequence: string } {
    const breaks = (kind === 'narrow') === (this.ctx.direction === 'request');
    const consequence = !breaks
      ? (this.ctx.direction === 'request' ? 'requests valid under the old contract remain valid' : 'responses stay within what consumers already handle')
      : (this.ctx.direction === 'request' ? 'requests valid under the old contract may now be rejected' : 'consumers may now receive responses the old contract did not allow');
    if (breaks && composed) return { classification: 'ambiguous', consequence: `${consequence}; unchanged composition keywords may already exclude those values, so the break is not provable` };
    return { classification: breaks ? 'breaking' : 'compatible', consequence };
  }

  private emit(rule: string, classification: Classification, explanation: string, pointer: string, field: string, oldValue?: JsonValue, newValue?: JsonValue): void {
    this.ctx.report({ rule, classification, explanation, pointer, field, ...(oldValue !== undefined ? { oldValue } : {}), ...(newValue !== undefined ? { newValue } : {}) });
  }
  /** `subjectField` names the schema described in the explanation when it differs from the reported field. */
  private change(rule: string, kind: 'narrow' | 'widen', what: string, pointer: string, field: string, composed: boolean, oldValue?: JsonValue, newValue?: JsonValue, subjectField = field): void {
    const { classification, consequence } = this.directional(kind, composed);
    this.emit(rule, classification, `${what} for ${this.subject(subjectField)}: ${consequence}.`, pointer, field, oldValue, newValue);
  }

  compare(oldInput: JsonValue | undefined, newInput: JsonValue | undefined, pointer: string, field: string, composed: boolean, depth: number): void {
    // Identical text proves nothing when it contains recursive references: their targets may differ.
    if (same(oldInput, newInput) && !mentionsRef(oldInput)) return;
    if (depth > MAX_SCHEMA_DEPTH) { this.emit('schema.depth-limit', 'ambiguous', `Schema nesting for ${this.subject(field)} exceeds ${MAX_SCHEMA_DEPTH} levels; differences below are not analysed.`, pointer, field); return; }
    const oldResolved = this.resolve(bareRef(oldInput), 'old'), newResolved = this.resolve(bareRef(newInput), 'new');
    if (oldResolved.unresolved !== undefined || newResolved.unresolved !== undefined) {
      if (same(oldInput, newInput)) {
        this.emit('schema.recursion.unresolved', 'ambiguous', `Recursive reference ${oldResolved.unresolved ?? newResolved.unresolved} for ${this.subject(field)} cannot be resolved to its enclosing schema, so an unchanged reference does not prove an unchanged target.`, pointer, field, oldInput ?? null, newInput ?? null);
        return;
      }
    }
    if (oldResolved.id !== undefined && newResolved.id !== undefined) {
      const pair = JSON.stringify([oldResolved.id, newResolved.id, this.ctx.direction, composed]);
      if (this.visited.has(pair)) return;
      this.visited.add(pair);
    }
    const oldRaw = oldResolved.schema, newRaw = newResolved.schema;
    const pushedOld = this.push('old', oldRaw), pushedNew = this.push('new', newRaw);
    try { this.compareResolved(oldRaw, newRaw, pointer, field, composed, depth); }
    finally { this.frames.old.length -= pushedOld; this.frames.new.length -= pushedNew; }
  }

  private compareResolved(oldRaw: JsonValue | undefined, newRaw: JsonValue | undefined, pointer: string, field: string, composed: boolean, depth: number): void {
    let before = prepare(oldRaw), after = prepare(newRaw);
    if (same(before, after) && !mentionsRef(before)) return;
    const merged = this.mergeBoth(before, after);
    if (merged) {
      const { pushed } = merged; before = merged.before; after = merged.after;
      try { this.compareSchema(before, after, pointer, field, composed, depth); }
      finally { this.frames.old.length -= pushed.old; this.frames.new.length -= pushed.new; }
      return;
    }
    this.compareSchema(before, after, pointer, field, composed, depth);
  }

  /**
   * Replaces object-like `allOf`s by their exact merge (property union, required union) so changes inside get precise
   * rules. Returns undefined when neither side merges or a side with `allOf` cannot be merged exactly.
   */
  private mergeBoth(before: Schema, after: Schema): { before: Schema; after: Schema; pushed: Record<Side, number> } | undefined {
    if (!Array.isArray(before.allOf) && !Array.isArray(after.allOf)) return undefined;
    const pushed = { old: 0, new: 0 };
    const mergeSide = (schema: Schema, side: Side): Schema | undefined => {
      if (!Array.isArray(schema.allOf)) return schema;
      const branches: Schema[] = [];
      if (!this.flatten(schema, side, branches, pushed, 0)) return undefined;
      return mergeObjects(branches, side === 'old' ? this.ctx.oldVersion : this.ctx.newVersion);
    };
    const mergedBefore = mergeSide(before, 'old');
    const mergedAfter = mergedBefore ? mergeSide(after, 'new') : undefined;
    if (!mergedBefore || !mergedAfter) { this.frames.old.length -= pushed.old; this.frames.new.length -= pushed.new; return undefined; }
    return { before: mergedBefore, after: mergedAfter, pushed };
  }
  private flatten(schema: Schema, side: Side, out: Schema[], pushed: Record<Side, number>, level: number): boolean {
    if (level > 8) return false;
    const { allOf, ...rest } = schema;
    if (allOf === undefined) { out.push(schema); return true; }
    if (!Array.isArray(allOf)) return false;
    out.push(rest);
    for (const member of allOf) {
      const resolved = this.resolve(member, side);
      if (resolved.unresolved !== undefined) return false;
      // Recursive references inside a branch resolve against the branch itself, not the merged object.
      pushed[side] += this.push(side, resolved.schema);
      const prepared = prepare(resolved.schema);
      if (prepared.$apipatchInvalidSchema !== undefined || !this.flatten(prepared, side, out, pushed, level + 1)) return false;
    }
    return true;
  }

  private compareSchema(before: Schema, after: Schema, pointer: string, field: string, composed: boolean, depth: number): void {
    if (same(before, after) && !mentionsRef(before)) return;

    const opaqueBefore = opaque(before, this.ctx.oldVersion), opaqueAfter = opaque(after, this.ctx.newVersion);
    const opaqueKeys = [...new Set([...Object.keys(opaqueBefore), ...Object.keys(opaqueAfter)])].sort();
    if (!same(opaqueBefore, opaqueAfter) || (mentionsRef(opaqueBefore.anyOf) && Array.isArray(opaqueAfter.anyOf))) {
      const changed = opaqueKeys.filter(key => !same(opaqueBefore[key], opaqueAfter[key]) || (key === 'anyOf' && mentionsRef(opaqueBefore[key])));
      if (changed.length === 1 && changed[0] === 'anyOf' && this.anyOf(before, after, pointer, field, composed, depth)) {
        // The remaining keywords combine with anyOf by conjunction.
        if (opaqueKeys.some(key => SIBLING_DEPENDENT.has(key)) || !opaqueKeys.every(key => COMPOSITION.has(key))) {
          const { anyOf: _a, ...restBefore } = before, { anyOf: _b, ...restAfter } = after;
          if (!same(restBefore, restAfter)) this.emit('schema.keyword.unsupported', 'ambiguous', `Schema for ${this.subject(field)} changed next to keywords APIPatch does not interpret (${opaqueKeys.join(', ')}); compatibility is not provable.`, pointer, field, before, after);
          return;
        }
        composed = true;
        this.siblings(before, after, pointer, field, composed, depth);
        return;
      }
      const composition = changed.some(key => COMPOSITION.has(key));
      this.emit(composition ? 'schema.composition.changed' : 'schema.keyword.unsupported', 'ambiguous',
        `${composition ? 'Composition keywords' : 'Keywords not interpreted by APIPatch'} changed for ${this.subject(field)} (${changed.join(', ')}); compatibility is not provable and requires manual review.`,
        pointer, field, before, after);
      return;
    }
    if (opaqueKeys.length) {
      if (!opaqueKeys.every(key => COMPOSITION.has(key)) || opaqueKeys.some(key => SIBLING_DEPENDENT.has(key))) {
        this.emit('schema.keyword.unsupported', 'ambiguous', `Schema for ${this.subject(field)} changed next to keywords APIPatch does not interpret (${opaqueKeys.join(', ')}); compatibility is not provable.`, pointer, field, before, after);
        return;
      }
      composed = true;
    }
    this.siblings(before, after, pointer, field, composed, depth);
  }

  private siblings(before: Schema, after: Schema, pointer: string, field: string, composed: boolean, depth: number): void {
    if (!this.types(before, after, pointer, field, composed)) return;
    this.enums(before, after, pointer, field, composed);
    this.constraints(before, after, pointer, field, composed);
    this.object(before, after, pointer, field, composed, depth);
    this.items(before, after, pointer, field, composed, depth);
  }

  /**
   * anyOf is a union: moving every branch in the safe direction moves the union in the safe direction, but a
   * breaking move of one branch may be covered by another, so branch-level breaks are reported as composed
   * (ambiguous). Returns false when the change is not one of the provable shapes.
   */
  private anyOf(before: Schema, after: Schema, pointer: string, field: string, composed: boolean, depth: number): boolean {
    const oldBranches = before.anyOf, newBranches = after.anyOf;
    if (!Array.isArray(oldBranches) || !Array.isArray(newBranches) || !oldBranches.length || !newBranches.length) return false;
    const at = `${pointer}/anyOf`;
    if (oldBranches.length === newBranches.length) {
      oldBranches.forEach((branch, i) => this.compare(branch, newBranches[i], `${at}/${i}`, field, true, depth + 1));
      return true;
    }
    // Branch addition/removal needs the surviving branches to be unchanged without recursive references.
    if ([...oldBranches, ...newBranches].some(branch => mentionsRef(branch))) return false;
    const key = (items: JsonValue[]) => items.map(item => canonicalJson(item));
    const oldKeys = key(oldBranches), newKeys = key(newBranches);
    const added = newBranches.filter((_, i) => !oldKeys.includes(newKeys[i]!)), removed = oldBranches.filter((_, i) => !newKeys.includes(oldKeys[i]!));
    if (added.length && removed.length) return false;
    if (added.length) this.change('schema.any-of.branch-added', 'widen', `${added.length} anyOf branch${added.length > 1 ? 'es were' : ' was'} added`, at, field, composed, oldBranches, newBranches);
    else if (removed.length) this.change('schema.any-of.branch-removed', 'narrow', `${removed.length} anyOf branch${removed.length > 1 ? 'es were' : ' was'} removed`, at, field, composed, oldBranches, newBranches);
    else return false;
    return true;
  }

  /** Returns false when the types are disjointly changed and deeper comparison would only add noise. */
  private types(before: Schema, after: Schema, pointer: string, field: string, composed: boolean): boolean {
    const oldTypes = typeSet(before, this.ctx.oldVersion), newTypes = typeSet(after, this.ctx.newVersion);
    if (!oldTypes && !newTypes) return true;
    const oldValue = oldTypes ? [...oldTypes].sort() : null, newValue = newTypes ? [...newTypes].sort() : null;
    if (!newTypes) { this.change('schema.type.widened', 'widen', 'Type restriction was removed', `${pointer}/type`, field, composed, oldValue, newValue); return true; }
    if (!oldTypes) { this.change('schema.type.narrowed', 'narrow', 'A type restriction was added', `${pointer}/type`, field, composed, oldValue, newValue); return true; }
    const lost = [...oldTypes].filter(type => !coveredBy(newTypes, type)), gained = [...newTypes].filter(type => !coveredBy(oldTypes, type));
    if (lost.length && gained.length) {
      this.emit('schema.type.changed', composed ? 'ambiguous' : 'breaking', `Type of ${this.subject(field)} changed from ${oldValue!.join('|')} to ${newValue!.join('|')}: values are incompatible in both directions.`, `${pointer}/type`, field, oldValue, newValue);
      return false;
    }
    if (lost.length) {
      const nullOnly = lost.length === 1 && lost[0] === 'null';
      this.change(nullOnly ? 'schema.nullable.removed' : 'schema.type.narrowed', 'narrow', nullOnly ? 'null is no longer allowed' : `Types ${lost.join(', ')} are no longer allowed`, `${pointer}/type`, field, composed, oldValue, newValue);
    } else if (gained.length) {
      const nullOnly = gained.length === 1 && gained[0] === 'null';
      this.change(nullOnly ? 'schema.nullable.added' : 'schema.type.widened', 'widen', nullOnly ? 'null is now allowed' : `Types ${gained.join(', ')} are now allowed`, `${pointer}/type`, field, composed, oldValue, newValue);
    }
    return true;
  }

  private enums(before: Schema, after: Schema, pointer: string, field: string, composed: boolean): void {
    const values = (schema: Schema): JsonValue[] | undefined => Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : undefined;
    const oldValues = values(before), newValues = values(after);
    if (!oldValues && !newValues) return;
    const at = `${pointer}/${Object.hasOwn(after, 'enum') || Object.hasOwn(before, 'enum') ? 'enum' : 'const'}`;
    if (!oldValues) { this.change('schema.enum.narrowed', 'narrow', 'An enumeration constraint was added', at, field, composed, null, newValues!); return; }
    if (!newValues) { this.change('schema.enum.widened', 'widen', 'The enumeration constraint was removed', at, field, composed, oldValues, null); return; }
    const key = (items: JsonValue[]) => new Set(items.map(item => canonicalJson(item)));
    const oldKeys = key(oldValues), newKeys = key(newValues);
    const removed = oldValues.filter(item => !newKeys.has(canonicalJson(item))), added = newValues.filter(item => !oldKeys.has(canonicalJson(item)));
    if (removed.length) this.change('schema.enum.values-removed', 'narrow', `Enumerated values ${removed.map(render).join(', ')} were removed`, at, field, composed, removed, newValues);
    if (!added.length) return;
    const what = `Enumerated values ${added.map(render).join(', ')} were added`;
    if (this.ctx.direction === 'request') { this.change('schema.enum.values-added', 'widen', what, at, field, composed, oldValues, added); return; }
    const { classification, consequence } = this.directional('widen', composed);
    this.emit('schema.enum.values-added', classification, `${what} for ${this.subject(field)}: ${consequence}; consumers that handle the enumeration exhaustively may not expect them.`, at, field, oldValues, added);
  }

  private constraints(before: Schema, after: Schema, pointer: string, field: string, composed: boolean): void {
    const bound = (rule: string, label: string, side: 'lower' | 'upper', oldBound: Bound | undefined, newBound: Bound | undefined, keyword: string) => {
      const kind = compareBounds(oldBound, newBound, side);
      if (!kind) return;
      const show = (b: Bound | undefined): JsonValue => b ? { value: b.value, exclusive: b.exclusive } : null;
      this.change(`${rule}.${kind === 'narrow' ? 'narrowed' : 'widened'}`, kind, `${side === 'lower' ? 'Lower' : 'Upper'} ${label} bound ${kind === 'narrow' ? 'tightened' : 'relaxed'}`, `${pointer}/${keyword}`, field, composed, show(oldBound), show(newBound));
    };
    bound('schema.range', 'numeric', 'lower', numericBound(before, 'lower'), numericBound(after, 'lower'), 'minimum');
    bound('schema.range', 'numeric', 'upper', numericBound(before, 'upper'), numericBound(after, 'upper'), 'maximum');
    for (const [label, rule, min, max] of [['length', 'schema.length', 'minLength', 'maxLength'], ['item count', 'schema.item-count', 'minItems', 'maxItems'], ['property count', 'schema.property-count', 'minProperties', 'maxProperties']] as const) {
      bound(rule, label, 'lower', countBound(before, min), countBound(after, min), min);
      bound(rule, label, 'upper', countBound(before, max), countBound(after, max), max);
    }
    const oldMultiple = before.multipleOf, newMultiple = after.multipleOf;
    if (!same(oldMultiple, newMultiple)) {
      const at = `${pointer}/multipleOf`;
      const divides = (a: number, b: number) => Math.abs(b / a - Math.round(b / a)) < 1e-9;
      if (!isNumber(oldMultiple) && isNumber(newMultiple)) this.change('schema.multiple-of.narrowed', 'narrow', 'multipleOf was added', at, field, composed, null, newMultiple);
      else if (isNumber(oldMultiple) && !isNumber(newMultiple)) this.change('schema.multiple-of.widened', 'widen', 'multipleOf was removed', at, field, composed, oldMultiple, null);
      else if (isNumber(oldMultiple) && isNumber(newMultiple) && divides(oldMultiple, newMultiple)) this.change('schema.multiple-of.narrowed', 'narrow', 'multipleOf became stricter', at, field, composed, oldMultiple, newMultiple);
      else if (isNumber(oldMultiple) && isNumber(newMultiple) && divides(newMultiple, oldMultiple)) this.change('schema.multiple-of.widened', 'widen', 'multipleOf became looser', at, field, composed, oldMultiple, newMultiple);
      else this.emit('schema.multiple-of.changed', 'ambiguous', `multipleOf changed for ${this.subject(field)} without a provable inclusion relation.`, at, field, oldMultiple ?? null, newMultiple ?? null);
    }
    if (!same(before.pattern, after.pattern)) {
      const at = `${pointer}/pattern`;
      if (before.pattern === undefined) this.change('schema.pattern.narrowed', 'narrow', 'A pattern was added', at, field, composed, null, after.pattern!);
      else if (after.pattern === undefined) this.change('schema.pattern.widened', 'widen', 'The pattern was removed', at, field, composed, before.pattern, null);
      else this.emit('schema.pattern.changed', 'ambiguous', `Pattern changed for ${this.subject(field)}; regular expression inclusion is not analysed.`, at, field, before.pattern, after.pattern);
    }
    if (!same(before.format, after.format)) {
      this.emit('schema.format.changed', 'ambiguous', `Format changed for ${this.subject(field)}; format assertion is implementation-defined in JSON Schema, so the effect is not provable.`, `${pointer}/format`, field, before.format ?? null, after.format ?? null);
    }
    if ((before.uniqueItems === true) !== (after.uniqueItems === true)) {
      const narrow = after.uniqueItems === true;
      this.change(narrow ? 'schema.unique-items.narrowed' : 'schema.unique-items.widened', narrow ? 'narrow' : 'widen', narrow ? 'Array items must now be unique' : 'Array items no longer need to be unique', `${pointer}/uniqueItems`, field, composed, before.uniqueItems === true, after.uniqueItems === true);
    }
    const accessKeyword = this.ctx.direction === 'request' ? 'readOnly' : 'writeOnly';
    if ((before[accessKeyword] === true) !== (after[accessKeyword] === true)) {
      this.emit(`schema.${accessKeyword === 'readOnly' ? 'read-only' : 'write-only'}.changed`, 'ambiguous', `${accessKeyword} changed for ${this.subject(field)}; whether the ${this.ctx.direction === 'request' ? 'server ignores or rejects the value' : 'value is still returned'} is not specified.`, `${pointer}/${accessKeyword}`, field, before[accessKeyword] === true, after[accessKeyword] === true);
    }
    if (this.ctx.direction === 'request' && !same(before.default, after.default)) {
      this.emit('schema.default.changed', 'ambiguous', `Default value changed for ${this.subject(field)}; requests that omit it may now behave differently.`, `${pointer}/default`, field, before.default ?? null, after.default ?? null);
    }
  }

  private object(before: Schema, after: Schema, pointer: string, field: string, composed: boolean, depth: number): void {
    const oldProps = isObject(before.properties) ? before.properties : {}, newProps = isObject(after.properties) ? after.properties : {};
    const oldRequired = requiredSet(before, this.ctx.direction), newRequired = requiredSet(after, this.ctx.direction);
    const names = [...new Set([...Object.keys(oldProps), ...Object.keys(newProps), ...oldRequired, ...newRequired])].sort();
    const oldAdditional = additionalKind(before.additionalProperties), newAdditional = additionalKind(after.additionalProperties);
    const request = this.ctx.direction === 'request';
    for (const name of names) {
      const childField = `${field}.${name}`, childPointer = `${pointer}/properties/${escape(name)}`;
      const inOld = Object.hasOwn(oldProps, name), inNew = Object.hasOwn(newProps, name);
      const wasRequired = oldRequired.has(name), isRequired = newRequired.has(name);
      if (inOld && inNew) this.compare(oldProps[name], newProps[name], childPointer, childField, composed, depth + 1);
      if (!wasRequired && isRequired) {
        const what = !request ? `Property "${name}" is now guaranteed` : inOld ? `Optional property "${name}" became required` : `New required property "${name}"`;
        this.change('schema.required.added', 'narrow', what, `${pointer}/required`, childField, composed, false, true, field);
      }
      if (wasRequired && !isRequired) {
        if (request && inOld && !inNew) { /* reported once below as a removed property */ }
        else if (request) this.change('schema.required.removed', 'widen', `Property "${name}" is no longer required`, `${pointer}/required`, childField, composed, true, false, field);
        else if (inOld && !inNew) this.change('schema.property.removed', 'widen', `Required property "${name}" was removed, so its presence is no longer guaranteed`, childPointer, childField, composed, oldProps[name] ?? null, null, field);
        else this.change('schema.required.removed', 'widen', `Property "${name}" is no longer guaranteed to be present`, `${pointer}/required`, childField, composed, true, false, field);
      }
      if (inOld && !inNew && !(wasRequired && !request) && !isRequired) {
        const formerly = wasRequired ? 'Formerly required property' : 'Property';
        if (request && newAdditional === 'closed') this.change('schema.property.removed', 'narrow', `${formerly} "${name}" was removed and additionalProperties is false`, childPointer, childField, composed, oldProps[name] ?? null, null, field);
        else this.emit('schema.property.removed', 'ambiguous', request
          ? `${formerly} "${name}" is no longer documented for ${this.subject(field)}; the specification does not prove whether the server ignores or rejects it.`
          : `Optional property "${name}" is no longer documented for ${this.subject(field)}; consumers that read it may receive nothing or an undocumented value.`, childPointer, childField, oldProps[name] ?? null, null);
      }
      if (!inOld && inNew && !isRequired) {
        if (!request && oldAdditional === 'closed') this.emit('schema.property.added', 'ambiguous', `Property "${name}" was added to ${this.subject(field)}, which previously disallowed additional properties; strict consumers may reject it.`, childPointer, childField, null, newProps[name] ?? null);
        else this.emit('schema.property.added', 'compatible', `Optional property "${name}" was added to ${this.subject(field)}.`, childPointer, childField, null, newProps[name] ?? null);
      }
    }
    if (oldAdditional === 'schema' && newAdditional === 'schema') {
      this.compare(before.additionalProperties, after.additionalProperties, `${pointer}/additionalProperties`, `${field}.*`, composed, depth + 1);
    } else if (oldAdditional !== newAdditional) {
      const rank = { closed: 0, schema: 1, open: 2 } as const;
      const narrow = rank[newAdditional] < rank[oldAdditional];
      const breaks = narrow === request;
      // Only consumers that send or validate undocumented properties are affected, which the contract cannot show.
      this.emit(`schema.additional-properties.${narrow ? 'narrowed' : 'widened'}`, breaks ? 'ambiguous' : 'compatible',
        `additionalProperties changed from ${oldAdditional} to ${newAdditional} for ${this.subject(field)}${breaks ? (request ? '; requests that send undocumented properties may be rejected' : '; consumers that validate strictly may reject undocumented properties') : ''}.`,
        `${pointer}/additionalProperties`, field, before.additionalProperties ?? null, after.additionalProperties ?? null);
    }
  }

  private items(before: Schema, after: Schema, pointer: string, field: string, composed: boolean, depth: number): void {
    const has = (schema: Schema) => schema.items !== undefined && !isEmpty(prepare(schema.items));
    const oldHas = has(before), newHas = has(after);
    if (oldHas && newHas) this.compare(before.items, after.items, `${pointer}/items`, `${field}[]`, composed, depth + 1);
    else if (newHas) this.change('schema.items.narrowed', 'narrow', 'An items schema was added', `${pointer}/items`, field, composed, null, after.items!);
    else if (oldHas) this.change('schema.items.widened', 'widen', 'The items schema was removed', `${pointer}/items`, field, composed, before.items!, null);
  }
}

/** Compare two normalized schemas directionally. Pointers are relative to the normalized schema root, not the source document. */
export function compareSchemas(oldSchema: JsonValue, newSchema: JsonValue, ctx: SchemaContext): void {
  new Walker(ctx).compare(oldSchema, newSchema, '', ctx.root, false, 0);
}
