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

function findingRow(finding: Finding, report: RunReport, language: 'en' | 'es'): string {
  const use = report.uses.find(item => item.id === finding.useId);
  const change = report.changes.find(item => item.id === finding.changeId);
  const location = use ? `${use.file}:${use.range.line}:${use.range.column}` : language === 'es' ? 'uso desconocido' : 'unknown use';
  return `| ${cell(location)} | ${cell(change?.method.toUpperCase())} ${cell(change?.path)} | ${cell(finding.confidence)} | ${cell(finding.consequence)} | ${cell(finding.reviewStatus)} |`;
}

/** Export stored, inspectable results. The caller supplies a validated RunReport. */
export function exportReport(report: RunReport, format: 'json' | 'markdown', language: 'en' | 'es' = 'es'): string {
  report = redactReport(report);
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  const t = (es: string, en: string): string => language === 'es' ? es : en;
  const lines = [
    t('# APIPatch — informe de análisis', '# APIPatch — analysis report'),
    '',
    `ID: ${safe(report.id)}`,
    '',
    `${t('OpenAPI anterior', 'Old OpenAPI')}: ${safe(report.inputs.old.file)} (${safe(report.inputs.old.digest)})`,
    '',
    `${t('OpenAPI nueva', 'New OpenAPI')}: ${safe(report.inputs.new.file)} (${safe(report.inputs.new.digest)})`,
    '',
    `${t('Repositorio', 'Repository')}: ${safe(report.inputs.repository ?? t('No analizado', 'Not scanned'))}`,
    '',
    t('## Cambios de API', '## API changes'),
    '',
    t('| Clasificación | Método | Ruta | Regla | Explicación |', '| Classification | Method | Path | Rule | Explanation |'),
    '| --- | --- | --- | --- | --- |',
    ...report.changes.map(changeRow),
    '',
    t('## Usos afectados', '## Affected uses'),
    '',
    t('| Ubicación | Operación | Confianza | Consecuencia | Revisión |', '| Location | Operation | Confidence | Consequence | Review |'),
    '| --- | --- | --- | --- | --- |',
    ...report.findings.map(finding => findingRow(finding, report, language)),
    '',
    t('## Reparaciones y verificación', '## Repairs and verification'),
    '',
    t(`Planes: ${report.repairs.length}. Comprobaciones: ${report.verification.length}.`, `Plans: ${report.repairs.length}. Checks: ${report.verification.length}.`),
    '',
    ...report.verification.map(item => `- ${t('Nivel', 'Level')} ${item.level}: ${safe(item.status)} — ${safe(item.properties.join('; '))}${item.reason ? ` (${safe(item.reason)})` : ''}`),
    '',
    t('## Limitaciones', '## Limitations'),
    '',
    ...(report.limitations.length ? report.limitations.map(item => `- ${safe(item)}`) : [t('- Ninguna limitación adicional registrada.', '- No additional limitations recorded.')]),
    '',
    t('El resultado de pruebas locales no demuestra compatibilidad con producción.', 'Passing local checks does not demonstrate production compatibility.'),
    '',
  ];
  return lines.join('\n');
}
