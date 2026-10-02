import { SCHEMA_VERSION } from './core.js';
export { SCHEMA_VERSION, ContractError, sha256, canonicalJson, stableId } from './core.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
export type Confidence = 'high' | 'medium' | 'low';
export type ReviewStatus = 'pending' | 'accepted' | 'rejected';
export type ApplicationStatus = 'proposed' | 'applied' | 'conflict';
export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'blocked';
export type ChangeLocation = 'path' | 'query' | 'header' | 'cookie' | 'request' | 'response' | 'security';
export interface Versioned { schemaVersion: typeof SCHEMA_VERSION }
export interface SourceLocation { file: string; pointer: string }
/** Offsets are zero-based UTF-16, end-exclusive; lines/columns are one-based. */
export interface CodeRange { start: number; end: number; line: number; column: number }
export interface Diagnostic { code: string; severity: 'info' | 'warning' | 'error'; message: string; source?: SourceLocation; file?: string }
export interface Evidence { kind: 'schema' | 'ast' | 'mapping' | 'check'; message: string; source?: SourceLocation; file?: string; range?: CodeRange }
export interface ApiParameter { name: string; in: 'path' | 'query' | 'header' | 'cookie'; required: boolean; schema: JsonValue; source: SourceLocation }
export interface ApiMediaType { mediaType: string; schema: JsonValue; source: SourceLocation }
export interface ApiResponse { status: string; content: ApiMediaType[]; source: SourceLocation }
export interface ApiOperation { id: string; operationId?: string; method: HttpMethod; path: string; servers: string[]; parameters: ApiParameter[]; requestBody?: { required: boolean; content: ApiMediaType[]; source: SourceLocation }; responses: ApiResponse[]; security: JsonValue[]; source: SourceLocation }
export interface ApiSnapshot extends Versioned { id: string; openapi: string; digest: string; documents: { file: string; digest: string }[]; operations: ApiOperation[]; references: { from: SourceLocation; to: SourceLocation; recursive: boolean }[]; diagnostics: Diagnostic[] }
export interface ApiChange { id: string; operationId: string; method: HttpMethod; path: string; location: ChangeLocation; rule: string; direction: 'request' | 'response' | 'operation' | 'security'; classification: 'breaking' | 'compatible' | 'ambiguous'; explanation: string; before?: SourceLocation; after?: SourceLocation; oldValue?: JsonValue; newValue?: JsonValue; /** Property path inside a comparable schema; empty means the root. Omitted means no reliable path. */ fieldPath?: string[]; evidence: Evidence[] }
/** Bindings identify exact source spans supported by the scanner, never speculative edits. */
export interface ConsumerBinding { kind: 'url' | 'query' | 'request-property' | 'response-property'; name: string; range: CodeRange; value?: JsonValue }
export interface ConsumerUse { id: string; file: string; fileHash: string; range: CodeRange; client: 'fetch' | 'axios'; urlExpression: string; url?: string; method?: HttpMethod; origin?: string; operationIds: string[]; bindings: ConsumerBinding[]; resolution: 'resolved' | 'partial' | 'unresolved'; confidence: Confidence; reason: string }
export interface Finding { id: string; changeId: string; useId: string; consequence: string; evidence: Evidence[]; confidence: Confidence; reviewStatus: ReviewStatus }
export interface OperationMapping { from: string; to: string }
export interface RenameMapping { operationId: string; location: 'query' | 'request' | 'response'; from: string; to: string }
export interface RequiredValueMapping { operationId: string; location: 'query' | 'request'; name: string; value: JsonValue }
export interface MigrationConfig extends Versioned { allowedOrigins: string[]; operations: OperationMapping[]; renames: RenameMapping[]; values: RequiredValueMapping[] }
export interface TextEdit { start: number; end: number; oldText: string; newText: string; findingIds: string[]; reason: string }
export interface FilePatch { file: string; originalHash: string; edits: TextEdit[] }
export interface RepairPlan extends Versioned { id: string; reportId: string; migration: MigrationConfig; applicationStatus: ApplicationStatus; files: FilePatch[]; resolvedFindingIds: string[]; partialFindingIds: string[]; pendingFindingIds: string[]; unifiedDiff: string; explanations: string[]; diagnostics: Diagnostic[] }
export interface ExecutionAuthorization { command: string; args: string[]; cwd: string; consent: true }
export interface VerificationResult { id: string; level: 1 | 2 | 3 | 4 | 5; status: VerificationStatus; properties: string[]; evidence: Evidence[]; durationMs: number; environment: Record<string, string>; authorization?: ExecutionAuthorization; reason?: string }
export interface RunReport extends Versioned { id: string; inputs: { old: { file: string; digest: string }; new: { file: string; digest: string }; repository?: string }; snapshots: { old: ApiSnapshot; new: ApiSnapshot }; changes: ApiChange[]; uses: ConsumerUse[]; findings: Finding[]; repairs: RepairPlan[]; verification: VerificationResult[]; limitations: string[]; diagnostics: Diagnostic[] }
export interface ScanResult extends Versioned { uses: ConsumerUse[]; findings: Finding[]; diagnostics: Diagnostic[]; limitations: string[] }
export interface VerificationReport extends Versioned { planId: string; results: VerificationResult[]; limitations: string[] }
export interface ApplyResult extends Versioned { planId: string; status: ApplicationStatus; files: string[]; diagnostics: Diagnostic[] }
export interface ResourceLimits { maxFileBytes: number; maxFiles: number; maxDepth: number; timeoutMs: number }
export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({ maxFileBytes: 5_000_000, maxFiles: 10_000, maxDepth: 64, timeoutMs: 30_000 });
export interface LoadApiOptions { allowedRoot?: string; limits?: Partial<ResourceLimits>; signal?: AbortSignal }
export interface ScanOptions { repository: string; oldApi: ApiSnapshot; newApi: ApiSnapshot; changes: ApiChange[]; baseUrl?: string; excludes?: string[]; limits?: Partial<ResourceLimits>; signal?: AbortSignal }
export interface PlanRepairsOptions { report: RunReport; migration: MigrationConfig; repository: string }
export interface VerifyOptions { repository: string; authorization?: ExecutionAuthorization; timeoutMs?: number; signal?: AbortSignal; /** Opt-in level 4: runs the packaged synthetic demo contract, only for the demo module and its APIPatch-proposed edits. */ contract?: { kind: 'synthetic-demo' } }
export interface PublicServices { loadApi(file: string, options?: LoadApiOptions): Promise<ApiSnapshot>; compareApis(oldApi: ApiSnapshot, newApi: ApiSnapshot): ApiChange[]; scanRepository(options: ScanOptions): Promise<ScanResult>; planRepairs(options: PlanRepairsOptions): Promise<RepairPlan>; applyRepairPlan(plan: RepairPlan, repository: string): Promise<ApplyResult>; verifyRepairPlan(plan: RepairPlan, options: VerifyOptions): Promise<VerificationReport>; exportReport(report: RunReport, format: 'json' | 'markdown'): string }
export { validateDocument, parseDocument, serializeDocument, validateMigrationConfig } from './validation.js';
