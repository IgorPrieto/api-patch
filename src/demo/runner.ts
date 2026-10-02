import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  SCHEMA_VERSION, sha256, stableId, validateDocument,
  type ApiChange, type ApplyResult, type RepairPlan, type RunReport, type VerificationReport,
} from '../contracts/index.js';
import { loadApi } from '../openapi/index.js';
import { compareApis } from '../compare/index.js';
import { scanRepository } from '../scan/index.js';
import { applyRepairPlan, loadMigration, planRepairs } from '../repair/index.js';
import { verifyRepairPlan } from '../verify/index.js';
import { runConsumerContract, type ContractCaseResult, type ContractRun } from './contract.js';

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const DEMO_PATHS = Object.freeze({
  v1: join(PACKAGE_ROOT, 'demo/specs/v1.yaml'),
  v2: join(PACKAGE_ROOT, 'demo/specs/v2.yaml'),
  migration: join(PACKAGE_ROOT, 'demo/migration.yaml'),
  repository: join(PACKAGE_ROOT, 'demo/repository'),
  module: 'client.js',
});

export interface DemoCheck { name: string; passed: boolean; detail: string }
export interface DemoFindingSummary { id: string; rule: string; classification: ApiChange['classification']; operation: string; location: string; outcome: 'resolved' | 'partial' | 'pending' }
export interface DemoResult {
  ok: boolean;
  checks: DemoCheck[];
  report: RunReport;
  findings: DemoFindingSummary[];
  plan: RepairPlan;
  application: ApplyResult;
  verification: VerificationReport;
  runs: { originalV1: ContractRun; originalV2: ContractRun; repairedV2: ContractRun };
  /** Kept only with `keepWorkspace`; otherwise already deleted. */
  repairedCopy: string;
  limitations: string[];
}
export interface DemoOptions {
  keepWorkspace?: boolean;
  signal?: AbortSignal;
  /** Opt-in: also ask verifyRepairPlan for level 4 (synthetic demo contract) and require it to pass. */
  verifyLevel4?: boolean;
}

const LIMITATIONS = [
  'The synthetic API is a hand-written in-process implementation of demo/specs/v1.yaml and v2.yaml, not a generic contract-test generator.',
  'The consumer uses same-origin relative URLs; the harness resolves them against the ephemeral loopback base. Consumers whose base URL comes from a runtime value are not repairable (scanner marks them unresolved).',
  'Contract runs check only the listed demo cases (return values and the requests the API received); they are not a general proof of the consumer.',
  'GET /preferences (ambiguous oneOf) is not repaired and stays pending; the request property removal of `name` is classified ambiguous and stays pending even though the explicit rename covers the call.',
  'Node permission model isolates each consumer process (read-only consumer files, no child processes, no writes); on Node < 25 network access is not gated by it and the harness alone confines fetch to the loopback origin.',
];

async function hashTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    hashes.set(file.slice(root.length + 1), sha256(await readFile(file)));
  }
  return hashes;
}

function sameHashes(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([file, hash]) => b.get(file) === hash);
}

const byId = (run: ContractRun, id: string): ContractCaseResult | undefined => run.cases.find(item => item.id === id);
const supportedPassed = (run: ContractRun): number => run.cases.filter(item => item.supported && item.status === 'passed').length;
const supportedTotal = (run: ContractRun): number => run.cases.filter(item => item.supported).length;

/**
 * Full synthetic demo: v1 green, v2 breaks the real consumer, T1–T4 analysis and an explicit
 * migration produce a plan that is applied to a temporary copy only, and the repaired copy is
 * run against v2. Only APIPatch-owned fixtures are executed; no repository scripts run.
 */
export async function runFullDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const { signal } = options;
  const originalHashes = await hashTree(DEMO_PATHS.repository);
  const workspace = await mkdtemp(join(tmpdir(), 'apipatch-demo-'));
  const repairedCopy = join(workspace, 'repaired');
  try {
    const [oldApi, newApi] = await Promise.all([loadApi(DEMO_PATHS.v1, { signal }), loadApi(DEMO_PATHS.v2, { signal })]);
    const changes = compareApis(oldApi, newApi);
    const scan = await scanRepository({ repository: DEMO_PATHS.repository, oldApi, newApi, changes, signal });
    const draft: RunReport = validateDocument('RunReport', {
      schemaVersion: SCHEMA_VERSION,
      id: stableId('report', { old: oldApi.digest, new: newApi.digest, repo: 'demo/repository' }),
      inputs: { old: { file: 'demo/specs/v1.yaml', digest: oldApi.digest }, new: { file: 'demo/specs/v2.yaml', digest: newApi.digest }, repository: 'demo/repository' },
      snapshots: { old: oldApi, new: newApi }, changes, uses: scan.uses, findings: scan.findings,
      repairs: [], verification: [], limitations: [...scan.limitations, ...LIMITATIONS, options.verifyLevel4
        ? 'verifyRepairPlan level 4 ran the synthetic demo contract on its own temporary copy; the demo asserts it only when the verifier reports passed.'
        : 'verifyRepairPlan level 4 was not requested (skipped); the demo contract runs are separate evidence, not a level-4 result.'],
      diagnostics: [...oldApi.diagnostics, ...newApi.diagnostics, ...scan.diagnostics],
    });
    const migration = await loadMigration(DEMO_PATHS.migration);
    const plan = await planRepairs({ report: draft, migration, repository: DEMO_PATHS.repository });
    // Verification works on the untouched original with the proposed plan, in its own temporary copy.
    const verification = await verifyRepairPlan(plan, {
      repository: DEMO_PATHS.repository, signal, ...(options.verifyLevel4 ? { contract: { kind: 'synthetic-demo' as const } } : {}),
    });

    const originalV1 = await runConsumerContract({ repository: DEMO_PATHS.repository, module: DEMO_PATHS.module, api: 'v1', signal });
    const originalV2 = await runConsumerContract({ repository: DEMO_PATHS.repository, module: DEMO_PATHS.module, api: 'v2', signal });
    await cp(DEMO_PATHS.repository, repairedCopy, { recursive: true, errorOnExist: true, force: false });
    const application = await applyRepairPlan(plan, repairedCopy);
    const repairedV2 = await runConsumerContract({ repository: repairedCopy, module: DEMO_PATHS.module, api: 'v2', signal });
    const report: RunReport = validateDocument('RunReport', { ...draft, repairs: [plan], verification: verification.results });

    const outcome = (id: string): DemoFindingSummary['outcome'] => plan.resolvedFindingIds.includes(id) ? 'resolved'
      : plan.partialFindingIds.includes(id) ? 'partial' : 'pending';
    const findings = report.findings.map(finding => {
      const change = changes.find(item => item.id === finding.changeId)!;
      return { id: finding.id, rule: change.rule, classification: change.classification, operation: `${change.method.toUpperCase()} ${change.path}`, location: change.location, outcome: outcome(finding.id) };
    });
    const useOf = (path: string, method: string) => report.uses.find(use => use.operationIds.some(id => [...oldApi.operations, ...newApi.operations].some(op => op.id === id && op.path === path && op.method === method)));
    const findingsFor = (path: string, method: string) => { const use = useOf(path, method); return use ? report.findings.filter(finding => finding.useId === use.id) : []; };
    const getUserFindings = findingsFor('/users/{id}', 'get');
    const createFindings = findingsFor('/users', 'post');
    const healthUse = useOf('/health', 'get');
    const preferencesFindings = findingsFor('/preferences', 'get');
    const healthChanges = changes.filter(change => change.path === '/health');
    const edits = plan.files.flatMap(file => file.edits);
    const editsWith = (prefix: string) => edits.filter(edit => edit.reason.startsWith(prefix)).length;
    const getUserV2 = byId(originalV2, 'get-user');
    const createV2 = byId(originalV2, 'create-user');
    const repairedCreate = byId(repairedV2, 'create-user');
    const preferencesAfter = byId(repairedV2, 'preferences');
    const finalHashes = await hashTree(DEMO_PATHS.repository);
    const level4 = verification.results.find(item => item.level === 4);

    const checks: DemoCheck[] = [
      { name: 'v1: original consumer green', passed: originalV1.cases.every(item => item.status === 'passed'),
        detail: `${originalV1.cases.filter(item => item.status === 'passed').length}/${originalV1.cases.length} cases passed against v1` },
      { name: 'v2: original consumer breaks concretely',
        passed: getUserV2?.actual === 'threw: getUser HTTP 404' && getUserV2.requests.some(r => r.path === '/users/42' && r.status === 404)
          && createV2?.actual === 'threw: createUser HTTP 400' && createV2.requests.some(r => r.error === 'missing displayName, tenantId'),
        detail: `getUser → ${getUserV2?.actual}; createUser → ${createV2?.actual} (API: ${createV2?.requests.map(r => r.error).join(', ')})` },
      { name: 'scan: real uses linked to breaking changes',
        passed: getUserFindings.length > 0 && createFindings.length > 0 && report.uses.every(use => use.resolution !== 'unresolved'),
        detail: `${report.uses.length} uses, ${report.findings.length} findings (getUser ${getUserFindings.length}, createUser ${createFindings.length})` },
      { name: 'health: compatible change without false alarm',
        passed: healthChanges.length > 0 && healthChanges.every(change => change.classification === 'compatible') && !!healthUse
          && !report.findings.some(finding => finding.useId === healthUse.id)
          && [originalV1, originalV2, repairedV2].every(run => byId(run, 'health')?.status === 'passed'),
        detail: `${healthChanges.length} compatible /health change(s), 0 findings, health passed on v1, v2 and repaired v2` },
      { name: 'plan: explicit migration edits route, query, body and response access',
        passed: editsWith('Route') > 0 && editsWith('Rename query parameter') > 0 && editsWith('Rename request field') > 0 && editsWith('Rename response field access') > 0
          && [...getUserFindings, ...createFindings].some(finding => plan.resolvedFindingIds.includes(finding.id)),
        detail: `${edits.length} edit(s); ${plan.resolvedFindingIds.length} resolved, ${plan.partialFindingIds.length} partial, ${plan.pendingFindingIds.length} pending` },
      { name: 'ambiguous oneOf stays pending',
        passed: preferencesFindings.length > 0 && preferencesFindings.every(finding => plan.pendingFindingIds.includes(finding.id)),
        detail: `${preferencesFindings.length} /preferences finding(s) pending; repaired v2 preferences → ${preferencesAfter?.actual} (${preferencesAfter?.status}, not repaired)` },
      { name: 'plan applied to temporary copy only',
        passed: application.status === 'applied' && application.files.length > 0 && sameHashes(originalHashes, finalHashes),
        detail: `apply ${application.status} on copy (${application.files.join(', ')}); original demo/repository hashes unchanged` },
      { name: 'v2: repaired copy green on supported cases',
        passed: repairedV2.cases.filter(item => item.supported).every(item => item.status === 'passed')
          && !!repairedCreate?.requests.some(r => JSON.stringify(r.body) === JSON.stringify({ displayName: 'Ada', tenantId: 'tenant-demo' })),
        detail: `${supportedPassed(repairedV2)}/${supportedTotal(repairedV2)} supported cases passed; requests: ${repairedV2.cases.flatMap(item => item.requests).map(r => `${r.method} ${r.path}${r.query} → ${r.status}`).join('; ')}` },
      { name: 'v2: repair improves the consumer',
        passed: supportedPassed(repairedV2) > supportedPassed(originalV2),
        detail: `supported cases passing on v2: ${supportedPassed(originalV2)} before → ${supportedPassed(repairedV2)} after` },
      ...(options.verifyLevel4 ? [{ name: 'verify: level 4 synthetic contract passed',
        passed: level4?.status === 'passed',
        detail: `level 4 ${level4?.status ?? 'missing'}${level4?.reason ? ` (${level4.reason})` : ''}` }] : []),
    ];
    return {
      ok: checks.every(check => check.passed), checks, report, findings, plan, application, verification,
      runs: { originalV1, originalV2, repairedV2 }, repairedCopy, limitations: report.limitations,
    };
  } finally {
    if (!options.keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

function render(result: DemoResult): string {
  const lines: string[] = ['APIPatch — demo sintética (API loopback efímera, copia temporal)', ''];
  const runLine = (label: string, run: ContractRun): void => {
    lines.push(`${label}:`);
    for (const item of run.cases) {
      const mark = item.status === 'passed' ? 'OK  ' : item.status === 'blocked' ? 'NO EJECUTADO' : item.supported ? 'FALLA' : 'PENDIENTE (no soportado)';
      lines.push(`  ${mark} ${item.exportName}: esperado ${item.expected}, obtenido ${item.actual}`);
    }
  };
  runLine('Consumidor original vs v1', result.runs.originalV1);
  runLine('Consumidor original vs v2', result.runs.originalV2);
  lines.push('', `Hallazgos (${result.findings.length}):`);
  for (const finding of result.findings) lines.push(`  [${finding.outcome}] ${finding.operation} ${finding.rule} (${finding.classification})`);
  lines.push('', 'Plan de reparación (aplicado solo a la copia temporal):', result.plan.unifiedDiff.trimEnd(), '');
  lines.push('verifyRepairPlan:');
  for (const item of result.verification.results) {
    lines.push(`  Nivel ${item.level}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`);
    if (item.level === 4) for (const evidence of item.evidence) lines.push(`    ${evidence.message}`);
  }
  lines.push('');
  runLine('Copia reparada vs v2', result.runs.repairedV2);
  lines.push('', 'Comprobaciones:');
  for (const check of result.checks) lines.push(`  ${check.passed ? 'OK   ' : 'FALLA'} ${check.name} — ${check.detail}`);
  lines.push('', 'Límites:', ...result.limitations.map(item => `  - ${item}`), '');
  lines.push(result.ok ? 'Demo completada: todas las comprobaciones pasaron.' : 'Demo fallida: hay comprobaciones sin cumplir.');
  return lines.join('\n') + '\n';
}

/** Entry point for `apipatch demo`: prints the evidence and fails when any check fails. */
export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const result = await runFullDemo(options);
  process.stdout.write(render(result));
  if (!result.ok) throw new Error(`Demo checks failed: ${result.checks.filter(check => !check.passed).map(check => check.name).join('; ')}`);
  return result;
}
