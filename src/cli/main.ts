#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { SCHEMA_VERSION, parseDocument, stableId } from '../contracts/index.js';
import type { ApiChange, Diagnostic, RepairPlan, RunReport } from '../contracts/index.js';
import { exportReport, redactReport } from '../report/index.js';
import { loadApi } from '../openapi/index.js';
import { COMPARE_LIMITATIONS, compareApis } from '../compare/index.js';
import { scanRepository } from '../scan/index.js';
import { planRepairs, applyRepairPlan, loadMigration } from '../repair/index.js';
import { verifyRepairPlan } from '../verify/index.js';

type Common = { old: string; new: string; json?: boolean; out?: string; failOn?: string };
const program = new Command();
program.name('apipatch').description('OpenAPI changes, affected JS/TS consumers and reviewable repairs').version('0.1.0');

async function save(file: string, text: string): Promise<void> {
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, { flag: 'w' });
}
async function readReport(file: string): Promise<RunReport> {
  return parseDocument('RunReport', await readFile(resolve(file), 'utf8'));
}
async function readPlan(file: string): Promise<RepairPlan> {
  return parseDocument('RepairPlan', await readFile(resolve(file), 'utf8'));
}
function summaries(changes: ApiChange[]): string {
  const counts = { breaking: 0, compatible: 0, ambiguous: 0 };
  for (const change of changes) counts[change.classification]++;
  return `${changes.length} cambios: ${counts.breaking} incompatibles, ${counts.compatible} compatibles, ${counts.ambiguous} ambiguos`;
}
function diagnosticLines(diagnostics: Diagnostic[]): string {
  return diagnostics.length ? '\n' + diagnostics.slice(0, 10).map(item => `  [${item.severity}] ${item.code}: ${item.message}`).join('\n')
    + (diagnostics.length > 10 ? `\n  … ${diagnostics.length - 10} diagnósticos más en la salida JSON` : '') : '';
}
function emit(value: unknown, human: string, json: boolean | undefined): void {
  process.stdout.write(json ? JSON.stringify(value, null, 2) + '\n' : human + '\n');
}
function failOn(changes: ApiChange[], threshold?: string): void {
  if (!threshold || threshold === 'none') return;
  if (threshold !== 'breaking' && threshold !== 'ambiguous') throw new Error('--fail-on debe ser breaking, ambiguous o none');
  const failed = threshold === 'ambiguous'
    ? changes.some(change => change.classification !== 'compatible')
    : changes.some(change => change.classification === 'breaking');
  if (failed) process.exitCode = 2;
}
function addCompareOptions(command: Command): Command {
  return command.requiredOption('--old <file>', 'Old OpenAPI document')
    .requiredOption('--new <file>', 'New OpenAPI document')
    .option('--json', 'Machine-readable output')
    .option('--out <file>', 'Write JSON result to file')
    .option('--fail-on <kind>', 'CI threshold: breaking, ambiguous, none', 'none');
}

addCompareOptions(program.command('compare').description('Compare two OpenAPI definitions'))
  .action(async (options: Common) => {
    const oldApi = await loadApi(options.old);
    const newApi = await loadApi(options.new);
    const changes = compareApis(oldApi, newApi);
    const diagnostics = [...oldApi.diagnostics, ...newApi.diagnostics];
    const result = { schemaVersion: SCHEMA_VERSION, old: { file: options.old, digest: oldApi.digest }, new: { file: options.new, digest: newApi.digest }, changes, diagnostics, limitations: COMPARE_LIMITATIONS };
    if (options.out) await save(options.out, JSON.stringify(result, null, 2) + '\n');
    emit(result, `${summaries(changes)}; ${diagnostics.length} diagnósticos; ${COMPARE_LIMITATIONS.length} límites documentados${diagnosticLines(diagnostics)}`, options.json);
    failOn(changes, options.failOn);
  });

addCompareOptions(program.command('scan').description('Find affected fetch and axios uses'))
  .requiredOption('--repo <directory>', 'Local JS/TS repository')
  .option('--base-url <url>', 'Known API base URL')
  .action(async (options: Common & { repo: string; baseUrl?: string }) => {
    const [oldApi, newApi] = await Promise.all([loadApi(options.old), loadApi(options.new)]);
    const changes = compareApis(oldApi, newApi);
    const result = await scanRepository({ repository: options.repo, oldApi, newApi, changes, baseUrl: options.baseUrl });
    const report: RunReport = {
      schemaVersion: SCHEMA_VERSION,
      id: stableId('report', { old: oldApi.digest, new: newApi.digest, repo: resolve(options.repo), baseUrl: options.baseUrl ?? '' }),
      inputs: { old: { file: options.old, digest: oldApi.digest }, new: { file: options.new, digest: newApi.digest }, repository: resolve(options.repo) },
      snapshots: { old: oldApi, new: newApi }, changes, uses: result.uses, findings: result.findings,
      repairs: [], verification: [], limitations: [...COMPARE_LIMITATIONS, ...result.limitations],
      diagnostics: [...oldApi.diagnostics, ...newApi.diagnostics, ...result.diagnostics],
    };
    const publicReport = redactReport(report);
    if (options.out) await save(options.out, exportReport(publicReport, 'json'));
    emit(publicReport, `${summaries(changes)}; ${report.uses.length} usos HTTP; ${report.findings.length} hallazgos; ${publicReport.limitations.length} límites${diagnosticLines(report.diagnostics)}`, options.json);
    failOn(changes, options.failOn);
  });

program.command('repair').description('Preview or explicitly apply a repair plan')
  .option('--report <file>', 'Report JSON from scan')
  .option('--migration <file>', 'Confirmed mappings JSON/YAML')
  .option('--repo <directory>', 'Repository root')
  .option('--out <directory>', 'Export plan and diff to directory')
  .option('--apply <file>', 'Explicitly apply a previously exported plan JSON')
  .option('--applied-out <file>', 'Write the applied plan for later verification (defaults beside the input plan)')
  .option('--json', 'Machine-readable output')
  .action(async (options: { report?: string; migration?: string; repo?: string; out?: string; apply?: string; appliedOut?: string; json?: boolean }) => {
    if (options.apply) {
      if (!options.repo) throw new Error('--repo es obligatorio para aplicar');
      const destination = resolve(options.appliedOut ?? resolve(dirname(options.apply), 'plan.applied.json'));
      if (destination === resolve(options.apply)) throw new Error('El plan aplicado debe guardarse en una ruta distinta del plan original');
      const plan = await readPlan(options.apply);
      const result = await applyRepairPlan(plan, options.repo);
      const already = result.diagnostics.filter(item => item.code === 'REPAIR_ALREADY_APPLIED').length;
      let appliedPath: string | undefined;
      if (result.status === 'applied') {
        appliedPath = destination;
        await save(appliedPath, JSON.stringify({ ...plan, applicationStatus: 'applied' }, null, 2) + '\n');
      }
      emit(result, result.status === 'conflict'
        ? `Aplicación en conflicto; no se generó plan aplicado`
        : `Aplicación ${result.status}: ${result.files.length - already} archivos modificados, ${already} ya aplicados; plan aplicado: ${appliedPath}`, options.json);
      if (result.status === 'conflict') process.exitCode = 3;
      return;
    }
    if (!options.report || !options.migration || !options.repo) throw new Error('Se requieren --report, --migration y --repo para generar un plan');
    const report = await readReport(options.report);
    const migration = await loadMigration(resolve(options.migration));
    const plan = await planRepairs({ report, migration, repository: options.repo });
    if (options.out) {
      await save(resolve(options.out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
      await save(resolve(options.out, 'repair.patch'), plan.unifiedDiff);
    }
    emit(plan, `${plan.files.length} archivos con propuesta; ${plan.pendingFindingIds.length} hallazgos pendientes de revisión`, options.json);
  });

program.command('verify').description('Verify a repair plan in a local repository')
  .requiredOption('--plan <file>', 'Repair plan JSON')
  .requiredOption('--repo <directory>', 'Repository root')
  .option('--out <file>', 'Write verification JSON')
  .option('--demo-contract', 'Run the packaged synthetic demo contract (only a demo-derived plan is accepted)')
  .option('--allow-repo-command', 'Explicitly authorize one repository command (requires --command)')
  .option('--command <executable>', 'Executable for an explicitly authorized repository check')
  .option('--arg <value>', 'Argument for the authorized command; repeat as needed', (value: string, values: string[]) => [...values, value], [] as string[])
  .option('--cwd <directory>', 'Working directory for the authorized command, inside --repo')
  .option('--timeout-ms <number>', 'Timeout for the authorized command')
  .option('--json', 'Machine-readable output')
  .action(async (options: { plan: string; repo: string; out?: string; demoContract?: boolean; allowRepoCommand?: boolean; command?: string; arg: string[]; cwd?: string; timeoutMs?: string; json?: boolean }) => {
    if (options.command && !options.allowRepoCommand) throw new Error('--command requiere --allow-repo-command para autorizar su ejecución');
    if (options.allowRepoCommand && !options.command) throw new Error('--allow-repo-command requiere --command');
    const timeoutMs = options.timeoutMs === undefined ? undefined : Number(options.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)) throw new Error('--timeout-ms debe ser un entero entre 1 y 120000');
    const result = await verifyRepairPlan(await readPlan(options.plan), {
      repository: options.repo,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(options.demoContract ? { contract: { kind: 'synthetic-demo' as const } } : {}),
      ...(options.allowRepoCommand && options.command ? { authorization: { command: options.command, args: options.arg, cwd: resolve(options.cwd ?? options.repo), consent: true as const } } : {}),
    });
    if (options.out) await save(options.out, JSON.stringify(result, null, 2) + '\n');
    emit(result, result.results.map(item => `Nivel ${item.level}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`).join('\n'), options.json);
    if (result.results.some(item => item.status === 'failed')) process.exitCode = 4;
    else if (result.results.some(item => item.status === 'blocked')) process.exitCode = 5;
  });

program.command('report').description('Export an analysis report')
  .requiredOption('--input <file>', 'Report JSON from scan')
  .requiredOption('--format <format>', 'json or markdown')
  .option('--out <file>', 'Output file')
  .action(async (options: { input: string; format: string; out?: string }) => {
    if (options.format !== 'json' && options.format !== 'markdown') throw new Error('--format debe ser json o markdown');
    const output = exportReport(await readReport(options.input), options.format);
    if (options.out) await save(options.out, output);
    else process.stdout.write(output);
  });

program.command('demo').description('Run the reproducible local demo')
  .option('--verify-level4', 'Also verify the supported demo cases as level 4')
  .action(async (options: { verifyLevel4?: boolean }) => { const { runDemo } = await import('../demo/runner.js'); await runDemo({ verifyLevel4: options.verifyLevel4 }); });
program.command('ui').description('Open the local review panel')
  .option('--workspace <directory>', 'Repository directory the browser may analyze')
  .option('--port <port>', 'Local port', '0')
  .action(async (options: { workspace?: string; port: string }) => {
    const serverModule = '../server/index.js';
    const { startServer } = await import(serverModule) as { startServer: (options: { workspace?: string; port: number }) => Promise<void> };
    await startServer({ workspace: options.workspace, port: Number(options.port) });
  });

program.parseAsync(process.argv).catch(error => {
  process.stderr.write(`APIPatch: ${error instanceof Error ? error.message : String(error)}\n`);
  if (!process.exitCode) process.exitCode = 1;
});
