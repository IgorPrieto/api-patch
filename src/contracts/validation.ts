import { canonicalJson, ContractError, SCHEMA_VERSION } from './core.js';
import type { ApiSnapshot, RunReport, RepairPlan, MigrationConfig, ScanResult, VerificationReport, ApplyResult } from './index.js';

type Check = (value: unknown, path: string) => void;
const fail = (path: string, message: string): never => { throw new ContractError(path, message); };
const string: Check = (v, p) => { if (typeof v !== 'string') fail(p, 'expected string'); };
const number: Check = (v, p) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(p, 'expected nonnegative finite number'); };
const integer: Check = (v, p) => { number(v,p); if (!Number.isSafeInteger(v)) fail(p, 'expected safe integer'); };
const bool: Check = (v,p) => { if (typeof v !== 'boolean') fail(p, 'expected boolean'); };
const json: Check = (v,p) => { try { canonicalJson(v); } catch { fail(p, 'expected JSON data'); } };
const choice = (...items: unknown[]): Check => (v,p) => { if (!items.includes(v)) fail(p, `expected one of ${items.join(', ')}`); };
const array = (check: Check): Check => (v,p) => { if (!Array.isArray(v)) fail(p, 'expected array'); (v as unknown[]).forEach((item,i) => check(item, `${p}[${i}]`)); };
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v,p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'expected object');
  const record = v as Record<string, unknown>;
  for (const [key,check] of Object.entries(required)) { if (!Object.hasOwn(record,key)) fail(`${p}.${key}`, 'required property'); check(record[key], `${p}.${key}`); }
  for (const key of Object.keys(record)) { if (Object.hasOwn(required,key)) continue; const check = Object.hasOwn(optional,key) ? optional[key] : undefined; if (!check) return fail(`${p}.${key}`, 'unknown property'); check(record[key], `${p}.${key}`); }
};
const strings = array(string);
const hash: Check = (v,p) => { string(v,p); if (!/^[a-f0-9]{64}$/.test(v as string)) fail(p, 'expected SHA-256 hex digest'); };
const relativePath: Check = (v,p) => { string(v,p); if (!(v as string) || /^(?:[/\\]|[a-z]:)/i.test(v as string) || (v as string).split(/[/\\]/).some(x => x === '..' || x === '.') || (v as string).includes('\0')) fail(p, 'expected safe relative file path'); };
const source = object({file:string,pointer:string});
const range: Check = (v,p) => { object({start:integer,end:integer,line:integer,column:integer})(v,p); const r=v as {start:number;end:number;line:number;column:number}; if(r.end<r.start || r.line<1 || r.column<1) fail(p,'invalid source range'); };
const diagnostic = object({code:string,severity:choice('info','warning','error'),message:string},{source,file:string});
const evidence = object({kind:choice('schema','ast','mapping','check'),message:string},{source,file:string,range});
const method=choice('get','put','post','delete','options','head','patch','trace');
const confidence=choice('high','medium','low');
const version=choice(SCHEMA_VERSION);
const media=object({mediaType:string,schema:json,source});
const operation=object({id:string,method,path:string,servers:strings,parameters:array(object({name:string,in:choice('path','query','header','cookie'),required:bool,schema:json,source})),responses:array(object({status:string,content:array(media),source})),security:array(json),source},{operationId:string,requestBody:object({required:bool,content:array(media),source})});
const snapshot=object({schemaVersion:version,id:string,openapi:string,digest:hash,documents:array(object({file:string,digest:hash})),operations:array(operation),references:array(object({from:source,to:source,recursive:bool})),diagnostics:array(diagnostic)});
const change=object({id:string,operationId:string,method,path:string,location:choice('path','query','header','cookie','request','response','security'),rule:string,direction:choice('request','response','operation','security'),classification:choice('breaking','compatible','ambiguous'),explanation:string,evidence:array(evidence)},{before:source,after:source,oldValue:json,newValue:json,fieldPath:strings});
const use=object({id:string,file:relativePath,fileHash:hash,range,client:choice('fetch','axios'),urlExpression:string,operationIds:strings,bindings:array(object({kind:choice('url','query','request-property','response-property'),name:string,range},{value:json})),resolution:choice('resolved','partial','unresolved'),confidence,reason:string},{url:string,method,origin:string});
const finding=object({id:string,changeId:string,useId:string,consequence:string,evidence:array(evidence),confidence,reviewStatus:choice('pending','accepted','rejected')});
const migrationShape=object({schemaVersion:version,allowedOrigins:strings,operations:array(object({from:string,to:string})),renames:array(object({operationId:string,location:choice('query','request','response'),from:string,to:string})),values:array(object({operationId:string,location:choice('query','request'),name:string,value:json}))});
const migration: Check=(v,p)=>{migrationShape(v,p); const m=v as MigrationConfig; for(const origin of m.allowedOrigins){try{const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)fail(p,'allowedOrigins must contain HTTP(S) origins without paths or credentials');}catch{fail(p,'invalid allowed origin');}} const keys=new Set<string>(); for(const item of m.operations){const key=`operation:${item.from}`;if(keys.has(key))fail(p,'duplicate operation mapping');keys.add(key);} for(const item of m.renames){const key=`${item.operationId}:${item.location}:${item.from}`;if(keys.has(key))fail(p,'duplicate rename mapping');keys.add(key);} for(const item of m.values){const key=`value:${item.operationId}:${item.location}:${item.name}`;if(keys.has(key))fail(p,'duplicate required value mapping');keys.add(key);} };
const edit=object({start:integer,end:integer,oldText:string,newText:string,findingIds:strings,reason:string});
const patch: Check=(v,p)=>{object({file:relativePath,originalHash:hash,edits:array(edit)})(v,p);const edits=(v as {edits:{start:number;end:number;oldText:string}[]}).edits;let end=-1;for(const e of [...edits].sort((a,b)=>a.start-b.start)){if(e.end<e.start||e.end-e.start!==e.oldText.length||e.start<end)fail(p,'invalid or overlapping edits');end=Math.max(e.end,e.start+1);}};
const application=choice('proposed','applied','conflict');
const plan=object({schemaVersion:version,id:string,reportId:string,migration,applicationStatus:application,files:array(patch),resolvedFindingIds:strings,partialFindingIds:strings,pendingFindingIds:strings,unifiedDiff:string,explanations:strings,diagnostics:array(diagnostic)});
const environment: Check=(v,p)=>{if(typeof v!=='object'||v===null||Array.isArray(v))fail(p,'expected string record');for(const [k,item]of Object.entries(v as object))string(item,`${p}.${k}`);};
const verification=object({id:string,level:choice(1,2,3,4,5),status:choice('passed','failed','skipped','blocked'),properties:strings,evidence:array(evidence),durationMs:number,environment},{authorization:object({command:string,args:strings,cwd:string,consent:choice(true)}),reason:string});
const report=object({schemaVersion:version,id:string,inputs:object({old:object({file:string,digest:hash}),new:object({file:string,digest:hash})},{repository:string}),snapshots:object({old:snapshot,new:snapshot}),changes:array(change),uses:array(use),findings:array(finding),repairs:array(plan),verification:array(verification),limitations:strings,diagnostics:array(diagnostic)});
export interface DocumentTypes { ApiSnapshot: ApiSnapshot; MigrationConfig: MigrationConfig; RepairPlan: RepairPlan; RunReport: RunReport; ScanResult: ScanResult; VerificationReport: VerificationReport; ApplyResult: ApplyResult }
const validators: Record<keyof DocumentTypes,Check>={ApiSnapshot:snapshot,MigrationConfig:migration,RepairPlan:plan,RunReport:report,ScanResult:object({schemaVersion:version,uses:array(use),findings:array(finding),diagnostics:array(diagnostic),limitations:strings}),VerificationReport:object({schemaVersion:version,planId:string,results:array(verification),limitations:strings}),ApplyResult:object({schemaVersion:version,planId:string,status:application,files:strings,diagnostics:array(diagnostic)})};
/** Structural validation only. Filesystem hashes, AST binding and destination existence must be rechecked by services. */
export function validateDocument<K extends keyof DocumentTypes>(kind: K, value: unknown): DocumentTypes[K] { canonicalJson(value); validators[kind](value,'$'); return value as DocumentTypes[K]; }
export function parseDocument<K extends keyof DocumentTypes>(kind: K, text: string): DocumentTypes[K] { let value:unknown;try{value=JSON.parse(text);}catch{throw new ContractError('$','invalid JSON');}return validateDocument(kind,value); }
export function serializeDocument<K extends keyof DocumentTypes>(kind: K, value: DocumentTypes[K]): string { return canonicalJson(validateDocument(kind,value))+'\n'; }
export function validateMigrationConfig(value:unknown): MigrationConfig { return validateDocument('MigrationConfig',value); }
