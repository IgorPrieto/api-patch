import { describe, expect, it } from 'vitest';
import { exportReport } from '../../src/report/index.js';
import { SCHEMA_VERSION, sha256 } from '../../src/contracts/index.js';
import type { RunReport } from '../../src/contracts/index.js';

const digest = sha256('fixture');
const snapshot = {
  schemaVersion: SCHEMA_VERSION, id: 'api', openapi: '3.0.3', digest,
  documents: [], operations: [], references: [], diagnostics: [],
};
const report: RunReport = {
  schemaVersion: SCHEMA_VERSION, id: 'report',
  inputs: { old: { file: 'v1.yaml', digest }, new: { file: 'v2.yaml', digest }, repository: 'demo' },
  snapshots: { old: snapshot, new: snapshot },
  changes: [{ id: 'change', operationId: 'get /users', method: 'get', path: '/users', location: 'query', rule: 'required', direction: 'request', classification: 'breaking', explanation: 'Nuevo parámetro <required>|x', evidence: [] }],
  uses: [{ id: 'use', file: 'src/client.ts', fileHash: digest, range: { start: 0, end: 1, line: 3, column: 7 }, client: 'fetch', urlExpression: '"/users"', operationIds: ['get /users'], bindings: [], resolution: 'resolved', confidence: 'high', reason: 'Literal' }],
  findings: [{ id: 'finding', changeId: 'change', useId: 'use', consequence: 'Falta query', evidence: [], confidence: 'high', reviewStatus: 'pending' }],
  repairs: [], verification: [], limitations: ['Falta verificar en producción'], diagnostics: [],
};

describe('report export', () => {
  it('exports inspectable JSON with findings and limitations', () => {
    const parsed = JSON.parse(exportReport(report, 'json')) as RunReport;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.limitations).toContain('Falta verificar en producción');
  });
  it('shows location and escapes untrusted table cells', () => {
    const markdown = exportReport(report, 'markdown');
    expect(markdown).toContain('src/client.ts:3:7');
    expect(markdown).toContain('&lt;required&gt;\\|x');
    expect(markdown).toContain('Falta verificar en producción');
  });
  it('does not persist URL literals or scanned values that may contain credentials', () => {
    const sensitive: RunReport = { ...report, uses: [{ ...report.uses[0]!, urlExpression: "'https://u:p@api.test/users?token=secret-value'", url: 'https://u:p@api.test/users?token=secret-value', bindings: [{ kind: 'query', name: 'token', value: 'secret-value', range: { start: 0, end: 1, line: 3, column: 7 } }] }] };
    const json = exportReport(sensitive, 'json');
    expect(json).not.toContain('secret-value');
    expect(json).not.toContain('u:p@');
    const parsed = JSON.parse(json) as RunReport;
    expect(parsed.uses[0]?.range.line).toBe(3);
    expect(parsed.uses[0]?.operationIds).toEqual(['get /users']);
    expect(parsed.uses[0]?.url).toBeUndefined();
    expect(parsed.uses[0]?.bindings[0]?.value).toBeUndefined();
    expect(sensitive.uses[0]?.url).toContain('secret-value');
  });
});
