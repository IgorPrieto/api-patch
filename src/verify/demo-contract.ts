import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  SCHEMA_VERSION, sha256, stableId, validateDocument,
  type Evidence, type RepairPlan, type RunReport, type TextEdit, type VerificationResult,
} from '../contracts/index.js';
import { loadApi } from '../openapi/index.js';
import { compareApis } from '../compare/index.js';
import { scanRepository } from '../scan/index.js';
import { loadMigration, planRepairs } from '../repair/index.js';
import { runConsumerContract, type ContractCaseResult } from '../demo/contract.js';

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
/** Package-owned demo inputs; the only consumer level 4 will ever execute is derived from these. */
const DEMO = Object.freeze({
  v1: join(PACKAGE_ROOT, 'demo/specs/v1.yaml'),
  v2: join(PACKAGE_ROOT, 'demo/specs/v2.yaml'),
  migration: join(PACKAGE_ROOT, 'demo/migration.yaml'),
  repository: join(PACKAGE_ROOT, 'demo/repository'),
  module: 'client.js',
});

export interface ContractLevel {
  status: VerificationResult['status'];
  properties: string[];
  evidence: Evidence[];
  reason?: string;
  limitation: string;
}

const editKey = (edit: Pick<TextEdit, 'start' | 'end' | 'oldText' | 'newText'>): string =>
  JSON.stringify([edit.start, edit.end, edit.oldText, edit.newText]);

/** Edits APIPatch itself proposes for the packaged demo with the packaged migration (static analysis only). */
async function proposedDemoEdits(signal?: AbortSignal): Promise<TextEdit[]> {
  const [oldApi, newApi] = await Promise.all([loadApi(DEMO.v1, { signal }), loadApi(DEMO.v2, { signal })]);
  const changes = compareApis(oldApi, newApi);
  const scan = await scanRepository({ repository: DEMO.repository, oldApi, newApi, changes, signal });
  const report: RunReport = validateDocument('RunReport', {
    schemaVersion: SCHEMA_VERSION,
    id: stableId('report', { old: oldApi.digest, new: newApi.digest, repo: 'demo/repository' }),
    inputs: { old: { file: 'demo/specs/v1.yaml', digest: oldApi.digest }, new: { file: 'demo/specs/v2.yaml', digest: newApi.digest }, repository: 'demo/repository' },
    snapshots: { old: oldApi, new: newApi }, changes, uses: scan.uses, findings: scan.findings,
    repairs: [], verification: [], limitations: scan.limitations,
    diagnostics: [...oldApi.diagnostics, ...newApi.diagnostics, ...scan.diagnostics],
  });
  const plan = await planRepairs({ report, migration: await loadMigration(DEMO.migration), repository: DEMO.repository });
  return plan.files.find(file => file.file === DEMO.module)?.edits ?? [];
}

const blocked = (reason: string, evidence: Evidence[] = []): ContractLevel => ({
  status: 'blocked', properties: [], evidence, reason,
  limitation: `Level 4 synthetic demo contract was not executed: ${reason}`,
});

function describeCase(item: ContractCaseResult): string {
  const requests = item.requests.length
    ? item.requests.map(r => `${r.method} ${r.path}${r.query} → ${r.status}${r.error ? ` (${r.error})` : ''}`).join('; ')
    : 'none';
  const label = item.supported ? item.status : `pending, unsupported; observed ${item.status}`;
  return `[${label}] ${item.id} (${item.exportName}): expected ${item.expected}, actual ${item.actual}; requests: ${requests}${item.note ? `; ${item.note}` : ''}`;
}

/**
 * Level 4 for the synthetic demo only. Executes nothing unless the plan patches exactly the demo
 * module, its source is byte-identical to the packaged demo/repository/client.js, and every edit is
 * one APIPatch proposes for the demo. The transformed module runs from `workDir` (a fresh temporary
 * directory) against the in-process v2 API through the permission-restricted harness.
 */
export async function verifySyntheticDemoContract(plan: RepairPlan, transformed: ReadonlyMap<string, string>,
  originals: ReadonlyMap<string, string>, workDir: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<ContractLevel> {
  if (plan.files.length !== 1 || plan.files[0]!.file !== DEMO.module) {
    return blocked(`plan must patch exactly the demo module ${DEMO.module}; got ${plan.files.map(file => file.file).join(', ') || 'no files'}`);
  }
  const patch = plan.files[0]!;
  const demoHash = sha256(await readFile(join(DEMO.repository, DEMO.module)));
  const original = originals.get(DEMO.module);
  const source = transformed.get(DEMO.module);
  if (patch.originalHash !== demoHash || original === undefined || sha256(original) !== demoHash || source === undefined) {
    return blocked(`source module is not the packaged demo/repository/${DEMO.module} (sha256 ${patch.originalHash} ≠ ${demoHash})`);
  }
  let proposed: TextEdit[];
  try { proposed = await proposedDemoEdits(options.signal); }
  catch (error) { return blocked(`could not derive the proposed demo plan: ${error instanceof Error ? error.message : String(error)}`); }
  const allowed = new Set(proposed.map(editKey));
  const foreign = patch.edits.filter(edit => !allowed.has(editKey(edit)));
  if (foreign.length) {
    return blocked(`${foreign.length} edit(s) are not part of the APIPatch-proposed demo plan (first at offset ${foreign[0]!.start})`);
  }
  const provenance: Evidence = { kind: 'mapping', file: DEMO.module,
    message: `Module ${DEMO.module} sha256 ${demoHash} matches demo/repository/${DEMO.module}; ${patch.edits.length}/${proposed.length} edit(s) taken from the APIPatch-proposed demo plan; executed from a temporary ${plan.applicationStatus} copy` };

  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  await writeFile(join(workDir, DEMO.module), source, 'utf8');
  let cases: ContractCaseResult[];
  try {
    cases = (await runConsumerContract({ repository: workDir, module: DEMO.module, api: 'v2', timeoutMs: options.timeoutMs, signal: options.signal })).cases;
  } catch (error) {
    return blocked(`contract harness error: ${error instanceof Error ? error.message : String(error)}`, [provenance]);
  }
  const supported = cases.filter(item => item.supported);
  const pending = cases.filter(item => !item.supported);
  const evidence: Evidence[] = [provenance, ...cases.map(item => ({ kind: 'check' as const, file: DEMO.module, message: describeCase(item) }))];
  const properties = supported.map(item => `${item.id}: ${item.property}`);
  const notRun = cases.filter(item => item.status === 'blocked');
  const failed = supported.filter(item => item.status === 'failed');
  const pendingNote = pending.length ? `; ${pending.map(item => item.id).join(', ')} pending (unsupported, not counted)` : '';
  const limitation = `Level 4 executed only the synthetic demo contract: ${cases.length} case(s) of demo/repository/${DEMO.module} against the in-process v2 API; unsupported cases (${pending.map(item => item.id).join(', ') || 'none'}) stay pending and are not counted.`;
  if (notRun.length || !supported.length) {
    return { status: 'blocked', properties, evidence, limitation,
      reason: notRun.length ? `Contract harness could not run ${notRun.map(item => item.id).join(', ')}` : 'No supported contract cases' };
  }
  if (failed.length) {
    return { status: 'failed', properties, evidence, limitation,
      reason: `${failed.length}/${supported.length} supported contract case(s) failed: ${failed.map(item => `${item.id} (${item.actual})`).join(', ')}${pendingNote}` };
  }
  return { status: 'passed', properties, evidence, limitation,
    reason: `${supported.length}/${supported.length} supported contract case(s) passed against v2${pendingNote}` };
}
