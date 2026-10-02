import type { ApiChange, Finding, RunReport } from '../contracts/index.js';

/** Reports keep source coordinates and operation matches, but never persist URL literals or scanned values. */
export function redactReport(report: RunReport): RunReport {
  return {
    ...report,
    uses: report.uses.map(use => {
      const { url: _url, ...withoutUrl } = use;
      return {
        ...withoutUrl,
        urlExpression: use.urlExpression ? '[source expression redacted; inspect file and range]' : '',
        bindings: use.bindings.map(binding => {
          const { value: _value, ...withoutValue } = binding;
          return withoutValue;
        }),
      };
    }),
    limitations: report.limitations.includes('Exported URL expressions and scanned values are redacted; inspect the local source at the reported coordinates.')
      ? report.limitations
      : [...report.limitations, 'Exported URL expressions and scanned values are redacted; inspect the local source at the reported coordinates.'],
  };
}

function safe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([|\[\]()*_`!])/g, '\\$1')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cell(value: string | number | undefined): string {
  return safe(value === undefined ? '—' : String(value));
}

function changeRow(change: ApiChange): string {
  return `| ${cell(change.classification)} | ${cell(change.method.toUpperCase())} | ${cell(change.path)} | ${cell(change.rule)} | ${cell(change.explanation)} |`;
}

function findingRow(finding: Finding, report: RunReport): string {
  const use = report.uses.find(item => item.id === finding.useId);
  const change = report.changes.find(item => item.id === finding.changeId);
  const location = use ? `${use.file}:${use.range.line}:${use.range.column}` : 'uso desconocido';
  return `| ${cell(location)} | ${cell(change?.method.toUpperCase())} ${cell(change?.path)} | ${cell(finding.confidence)} | ${cell(finding.consequence)} | ${cell(finding.reviewStatus)} |`;
}

/** Export stored, inspectable results. The caller supplies a validated RunReport. */
export function exportReport(report: RunReport, format: 'json' | 'markdown'): string {
  report = redactReport(report);
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  const lines = [
    '# APIPatch — informe de análisis',
    '',
    `ID: ${safe(report.id)}`,
    '',
    `OpenAPI anterior: ${safe(report.inputs.old.file)} (${safe(report.inputs.old.digest)})`,
    '',
    `OpenAPI nueva: ${safe(report.inputs.new.file)} (${safe(report.inputs.new.digest)})`,
    '',
    `Repositorio: ${safe(report.inputs.repository ?? 'No analizado')}`,
    '',
    '## Cambios de API',
    '',
    '| Clasificación | Método | Ruta | Regla | Explicación |',
    '| --- | --- | --- | --- | --- |',
    ...report.changes.map(changeRow),
    '',
    '## Usos afectados',
    '',
    '| Ubicación | Operación | Confianza | Consecuencia | Revisión |',
    '| --- | --- | --- | --- | --- |',
    ...report.findings.map(finding => findingRow(finding, report)),
    '',
    '## Reparaciones y verificación',
    '',
    `Planes: ${report.repairs.length}. Comprobaciones: ${report.verification.length}.`,
    '',
    ...report.verification.map(item => `- Nivel ${item.level}: ${safe(item.status)} — ${safe(item.properties.join('; '))}${item.reason ? ` (${safe(item.reason)})` : ''}`),
    '',
    '## Limitaciones',
    '',
    ...(report.limitations.length ? report.limitations.map(item => `- ${safe(item)}`) : ['- Ninguna limitación adicional registrada.']),
    '',
    'El resultado de pruebas locales no demuestra compatibilidad con producción.',
    '',
  ];
  return lines.join('\n');
}
