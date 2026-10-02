import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import {
  SCHEMA_VERSION, stableId, validateDocument,
  type ApplyResult, type MigrationConfig, type RepairPlan, type ReviewStatus, type RunReport, type VerificationReport,
} from '../contracts/index.js';
import { loadApi } from '../openapi/index.js';
import { COMPARE_LIMITATIONS, compareApis } from '../compare/index.js';
import { scanRepository } from '../scan/index.js';
import { applyRepairPlan, loadMigration, planRepairs } from '../repair/index.js';
import { verifyRepairPlan } from '../verify/index.js';
import { PathError, isWithin, resolveInside } from './paths.js';

export const MAX_BASE_URL = 2048;
export const MAX_RUNS = 20;
export const ANALYSIS_TIMEOUT_MS = 120_000;
const SNIPPET_CONTEXT = 2;
const SNIPPET_LINE_CHARS = 300;

export class RequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface AnalyzeInput { old: string; new: string; repository: string; baseUrl?: string; migration?: string }
export interface Snippet { firstLine: number; lines: string[] }
export interface RunState {
  id: string;
  createdAt: string;
  inputs: { old: string; new: string; repository: string; baseUrl: string | null; migration: string | null };
  repository: string;
  report: RunReport;
  migration?: MigrationConfig;
  plan?: RepairPlan;
  planError?: string;
  verification?: VerificationReport;
  application?: ApplyResult;
  snippets: Map<string, Snippet>;
}

const RUN_ID = /^run_[0-9a-f]{32}$/;
const REVIEW_STATUSES = new Set<ReviewStatus>(['pending', 'accepted', 'rejected']);

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new RequestError('INVALID_INPUT', `${field}: se esperaba texto`);
  return value;
}

/** Validate the analyze request body: only known fields, strings, bounded base URL. */
export function parseAnalyzeInput(body: Record<string, unknown>): AnalyzeInput {
  const known = new Set(['old', 'new', 'repository', 'baseUrl', 'migration']);
  const unknown = Object.keys(body).filter(key => !known.has(key));
  if (unknown.length) throw new RequestError('INVALID_INPUT', `Campos desconocidos: ${unknown.join(', ')}`);
  const old = optionalString(body.old, 'old');
  const next = optionalString(body.new, 'new');
  if (!old) throw new RequestError('INVALID_INPUT', 'old: indica el documento OpenAPI anterior');
  if (!next) throw new RequestError('INVALID_INPUT', 'new: indica el documento OpenAPI nuevo');
  const repository = typeof body.repository === 'string' ? body.repository : optionalString(body.repository, 'repository') ?? '';
  const baseUrl = optionalString(body.baseUrl, 'baseUrl');
  if (baseUrl !== undefined) {
    if (baseUrl.length > MAX_BASE_URL) throw new RequestError('INVALID_INPUT', `baseUrl: supera ${MAX_BASE_URL} caracteres`);
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new RequestError('INVALID_INPUT', 'baseUrl: no es una URL absoluta válida'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RequestError('INVALID_INPUT', 'baseUrl: solo http o https');
    if (url.username || url.password || url.search || url.hash) throw new RequestError('INVALID_INPUT', 'baseUrl: no incluyas credenciales, query ni fragmento');
  }
  return { old, new: next, repository, baseUrl, migration: optionalString(body.migration, 'migration') };
}

async function collectSnippets(repository: string, report: RunReport): Promise<Map<string, Snippet>> {
  const snippets = new Map<string, Snippet>();
  const byFile = new Map<string, RunReport['uses']>();
  for (const use of report.uses) byFile.set(use.file, [...(byFile.get(use.file) ?? []), use]);
  for (const [file, uses] of byFile) {
    let lines: string[];
    try { lines = (await readFile((await resolveInside(repository, file, 'file')).absolute, 'utf8')).split(/\r?\n/); } catch { continue; }
    for (const use of uses) {
      const first = Math.max(1, use.range.line - SNIPPET_CONTEXT);
      const last = Math.min(lines.length, use.range.line + SNIPPET_CONTEXT);
      snippets.set(use.id, {
        firstLine: first,
        lines: lines.slice(first - 1, last).map(line => line.length > SNIPPET_LINE_CHARS ? `${line.slice(0, SNIPPET_LINE_CHARS)}…` : line),
      });
    }
  }
  return snippets;
}

/** Holds the analyses of one server process. Run IDs are random and only reach their own artifacts. */
export class RunStore {
  private readonly runs = new Map<string, RunState>();
  private busy = false;

  constructor(readonly workspace: string) {}

  get(id: string): RunState {
    const run = RUN_ID.test(id) ? this.runs.get(id) : undefined;
    if (!run) throw new RequestError('RUN_NOT_FOUND', 'Análisis no encontrado', 404);
    return run;
  }

  /** Serialize mutating work: one analysis, review or application at a time. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new RequestError('BUSY', 'Hay otra operación en curso; espera a que termine', 409);
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }

  async analyze(input: AnalyzeInput): Promise<RunState> {
    const root = this.workspace;
    const [oldFile, newFile, repository, migrationFile] = await Promise.all([
      resolveInside(root, input.old, 'file', 'old'),
      resolveInside(root, input.new, 'file', 'new'),
      resolveInside(root, input.repository, 'directory', 'repository'),
      input.migration === undefined ? Promise.resolve(undefined) : resolveInside(root, input.migration, 'file', 'migration'),
    ]);
    const signal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
    // allowedRoot confines external $ref resolution to the authorized workspace.
    const [oldApi, newApi] = await Promise.all([
      loadApi(oldFile.absolute, { allowedRoot: root, signal }),
      loadApi(newFile.absolute, { allowedRoot: root, signal }),
    ]);
    const changes = compareApis(oldApi, newApi);
    const scan = await scanRepository({ repository: repository.absolute, oldApi, newApi, changes, baseUrl: input.baseUrl, signal });
    const repositoryLabel = repository.relative || '.';
    const report: RunReport = validateDocument('RunReport', {
      schemaVersion: SCHEMA_VERSION,
      id: stableId('report', { old: oldApi.digest, new: newApi.digest, repo: repositoryLabel, baseUrl: input.baseUrl ?? '' }),
      inputs: { old: { file: oldFile.relative, digest: oldApi.digest }, new: { file: newFile.relative, digest: newApi.digest }, repository: repositoryLabel },
      snapshots: { old: oldApi, new: newApi }, changes, uses: scan.uses, findings: scan.findings,
      repairs: [], verification: [], limitations: [...COMPARE_LIMITATIONS, ...scan.limitations],
      diagnostics: [...oldApi.diagnostics, ...newApi.diagnostics, ...scan.diagnostics],
    });
    const run: RunState = {
      id: `run_${randomBytes(16).toString('hex')}`,
      createdAt: new Date().toISOString(),
      inputs: { old: oldFile.relative, new: newFile.relative, repository: repositoryLabel, baseUrl: input.baseUrl ?? null, migration: migrationFile?.relative ?? null },
      repository: repository.absolute,
      report,
      snippets: await collectSnippets(repository.absolute, report),
    };
    if (migrationFile) {
      try { run.migration = await loadMigration(migrationFile.absolute); } catch (error) { run.planError = `Migración inválida: ${errorMessage(error, root)}`; }
    }
    await this.plan(run, signal);
    this.runs.set(run.id, run);
    while (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
    return run;
  }

  /** (Re)build the plan and its verification from the current review state, without writing to the repository. */
  private async plan(run: RunState, signal?: AbortSignal): Promise<void> {
    run.plan = undefined;
    run.verification = undefined;
    if (!run.migration) { run.report = { ...run.report, repairs: [], verification: [] }; return; }
    try {
      run.plan = await planRepairs({ report: run.report, migration: run.migration, repository: run.repository });
      run.planError = undefined;
    } catch (error) {
      run.planError = `No se pudo generar el plan: ${errorMessage(error, this.workspace)}`;
      run.report = { ...run.report, repairs: [], verification: [] };
      return;
    }
    // No ExecutionAuthorization is ever passed from the browser: repository scripts are not run.
    run.verification = await verifyRepairPlan(run.plan, { repository: run.repository, signal });
    run.report = { ...run.report, repairs: [run.plan], verification: run.verification.results };
  }

  async review(run: RunState, findingId: unknown, status: unknown): Promise<RunState> {
    if (typeof findingId !== 'string' || !run.report.findings.some(finding => finding.id === findingId)) throw new RequestError('FINDING_NOT_FOUND', 'Hallazgo no encontrado', 404);
    if (typeof status !== 'string' || !REVIEW_STATUSES.has(status as ReviewStatus)) throw new RequestError('INVALID_INPUT', 'status debe ser pending, accepted o rejected');
    if (run.application) throw new RequestError('ALREADY_APPLIED', 'El plan ya se aplicó; vuelve a analizar para revisar de nuevo', 409);
    run.report = {
      ...run.report,
      findings: run.report.findings.map(finding => finding.id === findingId ? { ...finding, reviewStatus: status as ReviewStatus } : finding),
    };
    await this.plan(run, AbortSignal.timeout(ANALYSIS_TIMEOUT_MS));
    return run;
  }

  /**
   * Apply only the plan reviewed in this run, and only when the browser echoes back the exact plan id and
   * the per-file original hashes it displayed. Conflicts are detected by applyRepairPlan on the server.
   */
  async apply(run: RunState, body: Record<string, unknown>): Promise<RunState> {
    const plan = run.plan;
    if (!plan || run.planError) throw new RequestError('NO_PLAN', 'Este análisis no tiene un plan aplicable', 409);
    if (body.confirm !== true) throw new RequestError('CONFIRMATION_REQUIRED', 'La aplicación requiere confirmación explícita', 400);
    if (body.planId !== plan.id) throw new RequestError('PLAN_MISMATCH', 'El plan confirmado no coincide con el plan actual; recarga los resultados', 409);
    if (!plan.files.length) throw new RequestError('EMPTY_PLAN', 'El plan no contiene ediciones', 409);
    const expected = plan.files.map(file => `${file.file}\0${file.originalHash}`).sort();
    const confirmed = Array.isArray(body.files)
      ? body.files.map(item => (item && typeof item === 'object' && typeof item.file === 'string' && typeof item.originalHash === 'string') ? `${item.file}\0${item.originalHash}` : '').sort()
      : [];
    if (confirmed.length !== expected.length || confirmed.some((item, index) => item !== expected[index])) {
      throw new RequestError('HASH_MISMATCH', 'Los archivos y hashes confirmados no coinciden con el plan', 409);
    }
    // The repository must still be the same canonical directory inside the workspace.
    let current: string;
    try { current = await realpath(run.repository); } catch { throw new RequestError('REPOSITORY_GONE', 'El repositorio ya no existe', 409); }
    if (current !== run.repository || !isWithin(this.workspace, current)) throw new RequestError('REPOSITORY_MOVED', 'El repositorio cambió de ubicación desde el análisis', 409);
    const application = await applyRepairPlan(plan, run.repository);
    run.application = application;
    if (application.status === 'applied') {
      run.verification = await verifyRepairPlan({ ...plan, applicationStatus: 'applied' }, { repository: run.repository, signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS) });
      run.report = { ...run.report, verification: run.verification.results };
    }
    return run;
  }
}

/** Error text for the browser, with the absolute workspace prefix removed. */
export function errorMessage(error: unknown, workspace: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(workspace + '/').join('').split(workspace).join('.');
}

export function isClientError(error: unknown): boolean {
  if (error instanceof PathError || error instanceof RequestError) return true;
  const name = error instanceof Error ? error.name : '';
  return name === 'ApiLoadError' || name === 'RepairError' || name === 'ContractError' || name === 'YAMLParseError';
}

type Outcome = 'resolved' | 'partial' | 'pending' | 'rejected' | 'unplanned';

/** Browser view of a run: no snapshots, only what the panel renders. */
export function viewRun(run: RunState) {
  const { report, plan } = run;
  const outcome = (id: string, status: ReviewStatus): Outcome => status === 'rejected' ? 'rejected'
    : !plan ? 'unplanned' : plan.resolvedFindingIds.includes(id) ? 'resolved' : plan.partialFindingIds.includes(id) ? 'partial' : 'pending';
  const counts = { breaking: 0, compatible: 0, ambiguous: 0 };
  for (const change of report.changes) counts[change.classification]++;
  const diffs = new Map<string, string>();
  if (plan) for (const chunk of plan.unifiedDiff.split(/(?=^diff --git )/m)) {
    const match = /^--- a\/(.+)$/m.exec(chunk);
    if (match) diffs.set(match[1]!, chunk);
  }
  const files = new Set([...report.uses.map(use => use.file), ...(plan?.files.map(file => file.file) ?? [])]);
  return {
    id: run.id,
    createdAt: run.createdAt,
    reportId: report.id,
    inputs: run.inputs,
    summary: {
      changes: report.changes.length, ...counts, uses: report.uses.length, findings: report.findings.length,
      resolved: plan?.resolvedFindingIds.length ?? 0, partial: plan?.partialFindingIds.length ?? 0, pending: plan?.pendingFindingIds.length ?? 0,
    },
    changes: report.changes.map(change => ({
      id: change.id, classification: change.classification, method: change.method, path: change.path, location: change.location,
      rule: change.rule, direction: change.direction, explanation: change.explanation, fieldPath: change.fieldPath ?? null,
      before: change.before ?? null, after: change.after ?? null,
    })),
    uses: report.uses.map(use => ({
      id: use.id, file: use.file, line: use.range.line, column: use.range.column, client: use.client, method: use.method ?? null,
      url: use.url ?? null, urlExpression: use.urlExpression, resolution: use.resolution, confidence: use.confidence, reason: use.reason,
      snippet: run.snippets.get(use.id) ?? null,
    })),
    findings: report.findings.map(finding => ({
      id: finding.id, changeId: finding.changeId, useId: finding.useId, consequence: finding.consequence, confidence: finding.confidence,
      reviewStatus: finding.reviewStatus, outcome: outcome(finding.id, finding.reviewStatus), evidence: finding.evidence.map(item => item.message),
    })),
    files: [...files].sort().map(file => ({ file, diff: diffs.get(file) ?? null, patch: plan?.files.find(item => item.file === file) ? true : false })),
    plan: plan ? {
      id: plan.id, applicationStatus: plan.applicationStatus,
      files: plan.files.map(file => ({ file: file.file, originalHash: file.originalHash, edits: file.edits.length })),
      unifiedDiff: plan.unifiedDiff, explanations: plan.explanations, diagnostics: plan.diagnostics,
      resolvedFindingIds: plan.resolvedFindingIds, partialFindingIds: plan.partialFindingIds, pendingFindingIds: plan.pendingFindingIds,
    } : null,
    planError: run.planError ?? null,
    verification: run.verification ? { results: run.verification.results, limitations: run.verification.limitations } : null,
    application: run.application ?? null,
    limitations: report.limitations,
    diagnostics: report.diagnostics,
  };
}
