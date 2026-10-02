// APIPatch local panel. Every value from the server is inserted with textContent/DOM APIs, never as HTML.
const TOKEN_KEY = 'apipatch-token';
const LANGUAGE = new URLSearchParams(location.search).get('lang') === 'es' ? 'es' : 'en';
const tr = (es, en) => LANGUAGE === 'es' ? es : en;
document.documentElement.lang = LANGUAGE;

// Translate only panel-owned copy. API explanations, source snippets and diagnostics
// remain verbatim evidence; guessing a translation could change their meaning.
const STATIC_EN = new Map([
  ['Saltar al contenido', 'Skip to content'],
  ['panel local de revisión', 'local review panel'],
  ['Conectando con el servidor local…', 'Connecting to the local server…'],
  ['1. Entradas', '1. Inputs'],
  ['Las rutas son relativas al workspace autorizado al arrancar', 'Paths are relative to the workspace authorized when starting'],
  ['. El navegador no tiene acceso a otras carpetas: escribe una ruta relativa o usa «Explorar…».', '. The browser cannot access other folders: enter a relative path or choose Browse…'],
  ['Documento OpenAPI anterior', 'Old OpenAPI document'],
  ['Documento OpenAPI nuevo', 'New OpenAPI document'],
  ['Repositorio consumidor (carpeta)', 'Consumer repository (directory)'],
  ['Base URL conocida de la API (opcional)', 'Known API base URL (optional)'],
  ['Migración confirmada (opcional)', 'Confirmed migration (optional)'],
  ['YAML o JSON, OpenAPI 3.0/3.1.', 'YAML or JSON, OpenAPI 3.0/3.1.'],
  ['Vacío o «.» analiza la raíz del workspace. Solo análisis estático: no se ejecutan scripts del repositorio.', 'Empty or “.” scans the workspace root. Static analysis only: repository scripts are not run.'],
  ['Sin migración se analizan cambios y hallazgos, pero no se propone ningún parche.', 'Without a migration file, changes and findings are analyzed, but no patch is proposed.'],
  ['Explorar…', 'Browse…'], ['Analizar', 'Analyze'],
  ['2. Resultados', '2. Results'],
  ['Cambios', 'Changes'], ['Archivos y hallazgos', 'Files and findings'], ['Diff', 'Diff'],
  ['Verificación y pendientes', 'Verification and pending'], ['Límites y diagnósticos', 'Limits and diagnostics'],
  ['Filtrar por clasificación', 'Filter by classification'], ['Todas', 'All'],
  ['Incompatibles', 'Breaking'], ['Ambiguas', 'Ambiguous'], ['Compatibles', 'Compatible'],
  ['3. Exportar y aplicar', '3. Export and apply'], ['Exportar JSON', 'Export JSON'],
  ['Exportar Markdown', 'Export Markdown'], ['Exportar patch', 'Export patch'],
  ['Explorador del workspace', 'Workspace explorer'], ['Ruta actual:', 'Current path:'],
  ['Subir un nivel', 'Up one level'], ['Usar esta carpeta', 'Use this directory'], ['Cerrar', 'Close'],
]);
function localizeStatic() {
  document.title = tr('APIPatch — panel local', 'APIPatch — local review panel');
  document.querySelector('#evidence-language').hidden = LANGUAGE !== 'en';
  if (LANGUAGE === 'en') {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = node.textContent.trim();
      if (STATIC_EN.has(value)) node.textContent = node.textContent.replace(value, STATIC_EN.get(value));
    }
    document.querySelector('#repository').placeholder = '. (workspace root)';
    document.querySelector('#tabs').setAttribute('aria-label', 'Result sections');
  }
  document.querySelector(`#lang-${LANGUAGE}`).setAttribute('aria-current', 'page');
  for (const link of document.querySelectorAll('.language a')) link.addEventListener('click', event => {
    event.preventDefault();
    location.assign(`${location.pathname}${link.getAttribute('href')}${token ? `#token=${token}` : ''}`);
  });
}
localizeStatic();

const $ = id => document.getElementById(id);
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}
function clear(node) { node.replaceChildren(); return node; }
function show(node, visible) { node.hidden = !visible; }
function setAlert(node, message) { node.textContent = message ?? ''; show(node, !!message); }
function setStatus(node, message, busy = false) { node.textContent = message ?? ''; node.classList.toggle('busy', busy); }

const LABELS = LANGUAGE === 'es' ? {
  breaking: 'incompatible', compatible: 'compatible', ambiguous: 'ambiguo',
  resolved: 'resuelto', partial: 'parcial', pending: 'pendiente', rejected: 'rechazado', unplanned: 'sin plan',
  passed: 'superado', failed: 'fallido', skipped: 'omitido', blocked: 'bloqueado',
  applied: 'aplicado', conflict: 'conflicto', proposed: 'propuesto', accepted: 'aceptado',
} : {
  breaking: 'breaking', compatible: 'compatible', ambiguous: 'ambiguous',
  resolved: 'resolved', partial: 'partial', pending: 'pending', rejected: 'rejected', unplanned: 'unplanned',
  passed: 'passed', failed: 'failed', skipped: 'skipped', blocked: 'blocked',
  applied: 'applied', conflict: 'conflict', proposed: 'proposed', accepted: 'accepted',
};
const badge = value => h('span', { class: `badge ${value}`, text: LABELS[value] ?? value });

// ---------------------------------------------------------------------------
// Session and API access

function takeToken() {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(location.hash);
  let token = match?.[1] ?? null;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else token = sessionStorage.getItem(TOKEN_KEY);
  } catch { /* storage unavailable: keep the token in memory only */ }
  // Remove the token from the address bar and history.
  if (match) history.replaceState(null, '', location.pathname + location.search);
  return token;
}
const token = takeToken();

class ApiError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-APIPatch-Token': token ?? '' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new ApiError('NETWORK', tr('No se pudo contactar con el servidor local. ¿Sigue en marcha «apipatch ui»?', 'Could not reach the local server. Is “apipatch ui” still running?'), 0);
  }
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    const data = type.includes('application/json') ? await response.json().catch(() => null) : null;
    throw new ApiError(data?.error?.code ?? 'HTTP', data?.error?.message ?? `Error HTTP ${response.status}`, response.status);
  }
  return type.includes('application/json') && !response.headers.get('content-disposition') ? response.json() : response;
}
const describe = error => error instanceof ApiError ? `${error.message} [${error.code}]` : String(error?.message ?? error);

// ---------------------------------------------------------------------------
// Workspace explorer (bounded to the workspace; paths are relative)

const explorer = { target: null, mode: 'document', path: '', opener: null };

async function openExplorer(target, mode, opener) {
  explorer.target = target; explorer.mode = mode; explorer.opener = opener;
  const current = $(target).value.trim();
  const start = mode === 'directory' ? current : current.split('/').slice(0, -1).join('/');
  show($('explorer-choose-dir'), mode === 'directory');
  $('explorer').showModal();
  await browse(start.replace(/^\.\/?/, '')).catch(() => browse(''));
}

async function browse(path) {
  const list = $('explorer-list');
  setAlert($('explorer-error'), '');
  setStatus($('explorer-status'), tr('Cargando…', 'Loading…'), true);
  list.setAttribute('aria-busy', 'true');
  try {
    const listing = await api(`/api/browse?path=${encodeURIComponent(path)}`);
    explorer.path = listing.path;
    $('explorer-path').textContent = listing.path || '.';
    $('explorer-up').disabled = listing.parent === null;
    clear(list);
    const entries = listing.entries.filter(entry => entry.kind === 'directory' || (explorer.mode === 'document' && entry.kind === 'document'));
    for (const entry of entries) {
      const label = entry.kind === 'directory' ? tr('carpeta', 'directory') : tr('documento', 'document');
      const action = entry.kind === 'directory' ? () => browse(entry.path) : () => choose(entry.path);
      list.append(h('li', {}, h('button', { type: 'button', 'data-path': entry.path, onclick: action },
        h('span', { class: 'kind', text: label + (entry.link ? tr(' (enlace)', ' (link)') : '') }), entry.name)));
    }
    const notes = [];
    if (!entries.length) notes.push(explorer.mode === 'document' ? tr('No hay carpetas ni documentos YAML/JSON aquí.', 'No directories or YAML/JSON documents here.') : tr('No hay subcarpetas aquí.', 'No subdirectories here.'));
    if (listing.hidden) notes.push(tr(`${listing.hidden} elemento(s) ocultos (.git, node_modules, enlaces que salen del workspace o archivos especiales).`, `${listing.hidden} item(s) hidden (.git, node_modules, links outside the workspace, or special files).`));
    if (listing.truncated) notes.push(tr('Listado truncado.', 'Listing truncated.'));
    setStatus($('explorer-status'), notes.join(' '));
    list.querySelector('button')?.focus();
    if (!list.querySelector('button')) $('explorer-close').focus();
  } catch (error) {
    setStatus($('explorer-status'), '');
    setAlert($('explorer-error'), describe(error));
    throw error;
  } finally {
    list.removeAttribute('aria-busy');
  }
}

function choose(path) {
  $(explorer.target).value = path || '.';
  $('explorer').close();
}
$('explorer').addEventListener('close', () => { explorer.opener?.focus(); });
$('explorer-close').addEventListener('click', () => $('explorer').close());
$('explorer-choose-dir').addEventListener('click', () => choose(explorer.path));
$('explorer-up').addEventListener('click', () => browse(explorer.path.split('/').slice(0, -1).join('/')).catch(() => {}));
for (const button of document.querySelectorAll('[data-browse]')) {
  button.addEventListener('click', () => openExplorer(button.dataset.browse, button.dataset.mode, button).catch(() => {}));
}

// ---------------------------------------------------------------------------
// Tabs (WAI-ARIA tabs pattern: arrows, Home, End)

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = true) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    show($(other.getAttribute('aria-controls')), selected);
  }
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length]);
  });
}

// ---------------------------------------------------------------------------
// Rendering

let run = null;

function locationText(source) { return source ? `${source.file}#${source.pointer}` : '—'; }

function renderSummary(view) {
  const s = view.summary;
  const items = [
    [tr('Cambios', 'Changes'), s.changes], [tr('Incompatibles', 'Breaking'), s.breaking], [tr('Ambiguos', 'Ambiguous'), s.ambiguous], [tr('Compatibles', 'Compatible'), s.compatible],
    [tr('Usos HTTP', 'HTTP uses'), s.uses], [tr('Hallazgos', 'Findings'), s.findings],
  ];
  if (view.plan) items.push([tr('Resueltos', 'Resolved'), s.resolved], [tr('Parciales', 'Partial'), s.partial], [tr('Pendientes', 'Pending'), s.pending]);
  clear($('summary')).append(...items.map(([label, value]) => h('div', {}, h('dt', { text: label }), h('dd', { text: String(value) }))));
  const i = view.inputs;
  $('run-inputs').textContent = tr(`Anterior: ${i.old} · Nuevo: ${i.new} · Repositorio: ${i.repository}`, `Old: ${i.old} · New: ${i.new} · Repository: ${i.repository}`) +
    (i.baseUrl ? ` · Base URL: ${i.baseUrl}` : '') + tr(` · Migración: ${i.migration ?? 'ninguna'}`, ` · Migration: ${i.migration ?? 'none'}`);
  $('tab-changes').textContent = tr(`Cambios (${s.changes})`, `Changes (${s.changes})`);
  $('tab-files').textContent = tr(`Archivos y hallazgos (${view.files.length})`, `Files and findings (${view.files.length})`);
}

function renderChanges(view) {
  const filter = $('change-filter').value;
  const changes = view.changes.filter(change => !filter || change.classification === filter);
  const container = clear($('changes'));
  if (!changes.length) { container.append(h('p', { class: 'muted', text: view.changes.length ? tr('Ningún cambio con este filtro.', 'No changes match this filter.') : tr('No hay cambios entre los dos documentos.', 'No changes between these documents.') })); return; }
  container.append(h('div', { class: 'table-wrap' }, h('table', {},
    h('caption', { class: 'muted', text: tr(`${changes.length} de ${view.changes.length} cambios`, `${changes.length} of ${view.changes.length} changes`) }),
    h('thead', {}, h('tr', {}, ...(LANGUAGE === 'es' ? ['Clasificación', 'Operación', 'Ubicación', 'Regla', 'Explicación', 'Origen'] : ['Classification', 'Operation', 'Location', 'Rule', 'Explanation', 'Source']).map(text => h('th', { scope: 'col', text })))),
    h('tbody', {}, ...changes.map(change => h('tr', { id: `change-${change.id}` },
      h('td', {}, badge(change.classification)),
      h('td', { class: 'mono', text: `${change.method.toUpperCase()} ${change.path}` }),
      h('td', { text: change.location + (change.fieldPath?.length ? ` · ${change.fieldPath.join('.')}` : '') }),
      h('td', { class: 'mono', text: change.rule }),
      h('td', { text: change.explanation }),
      h('td', { class: 'mono', text: `${locationText(change.before)} → ${locationText(change.after)}` })))))));
}

function renderSnippet(use) {
  if (!use.snippet) return h('p', { class: 'muted', text: tr('Fragmento no disponible.', 'Snippet unavailable.') });
  return h('pre', {}, ...use.snippet.lines.map((line, index) => {
    const number = use.snippet.firstLine + index;
    return h('span', { class: number === use.line ? 'hit' : null }, h('span', { class: 'ln', text: `${String(number).padStart(4)} ${number === use.line ? '›' : ' '} ` }), line, '\n');
  }));
}

function renderFiles(view) {
  const container = clear($('files'));
  if (!view.files.length) { container.append(h('p', { class: 'muted', text: tr('No se encontraron usos HTTP (fetch/axios) en el repositorio.', 'No HTTP uses (fetch/axios) found in the repository.') })); return; }
  const changes = new Map(view.changes.map(change => [change.id, change]));
  for (const file of view.files) {
    const uses = view.uses.filter(use => use.file === file.file);
    const useIds = new Set(uses.map(use => use.id));
    const findings = view.findings.filter(finding => useIds.has(finding.useId));
    const pending = findings.filter(finding => finding.outcome === 'pending' || finding.outcome === 'partial').length;
    const details = h('details', { class: 'file', open: findings.length > 0 },
      h('summary', {}, tr(`${file.file} — ${uses.length} uso(s), ${findings.length} hallazgo(s)`, `${file.file} — ${uses.length} use(s), ${findings.length} finding(s)`), pending ? tr(`, ${pending} pendiente(s)/parcial(es)`, `, ${pending} pending/partial`) : '', file.patch ? tr(' · con parche propuesto', ' · with proposed patch') : ''));
    for (const use of uses) {
      const useFindings = findings.filter(finding => finding.useId === use.id);
      details.append(h('div', { class: 'use' },
        h('h3', {}, `${use.client} ${use.method ? use.method.toUpperCase() : tr('¿método?', 'method?')} ${use.url ?? use.urlExpression}`),
        h('p', { class: 'muted' }, tr(`Línea ${use.line}:${use.column} · resolución `, `Line ${use.line}:${use.column} · resolution `), badge(use.resolution === 'resolved' ? 'resolved' : use.resolution === 'partial' ? 'partial' : 'pending'),
          tr(` (${use.resolution}) · confianza ${use.confidence} · ${use.reason}`, ` (${use.resolution}) · confidence ${use.confidence} · ${use.reason}`)),
        renderSnippet(use),
        useFindings.length ? null : h('p', { class: 'muted', text: tr('Sin hallazgos para este uso.', 'No findings for this use.') }),
        ...useFindings.map(finding => renderFinding(view, finding, changes.get(finding.changeId)))));
    }
    if (file.diff) details.append(h('button', { type: 'button', class: 'secondary', onclick: () => { selectTab($('tab-diff')); $(`diff-${file.file}`)?.scrollIntoView({ block: 'start' }); } }, tr('Ver diff de este archivo', 'View this file’s diff')));
    container.append(details);
  }
}

function renderFinding(view, finding, change) {
  const select = h('select', { id: `review-${finding.id}`, 'aria-describedby': `finding-${finding.id}-text` },
    ...['pending', 'accepted', 'rejected'].map(value => h('option', { value, selected: finding.reviewStatus === value, text: LABELS[value] })));
  const status = h('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
  select.disabled = !!view.application;
  select.addEventListener('change', async () => {
    select.disabled = true;
    setStatus(status, tr('Recalculando plan…', 'Recalculating plan…'), true);
    try { render(await api(`/api/runs/${run.id}/review`, { method: 'POST', body: { findingId: finding.id, status: select.value } }), `review-${finding.id}`); }
    catch (error) { setStatus(status, ''); select.disabled = false; select.value = finding.reviewStatus; setAlert($('plan-error'), describe(error)); }
  });
  return h('div', { class: 'finding', id: `finding-${finding.id}` },
    h('p', {}, badge(finding.outcome), ' ', change ? badge(change.classification) : null, ' ',
      h('strong', { text: change ? `${change.method.toUpperCase()} ${change.path} · ${change.rule}` : finding.changeId })),
    h('p', { id: `finding-${finding.id}-text`, text: `${finding.consequence} (${tr('confianza', 'confidence')} ${finding.confidence})` }),
    finding.evidence.length ? h('ul', { class: 'plain muted' }, ...finding.evidence.map(text => h('li', { text }))) : null,
    h('div', { class: 'row' }, h('label', { for: `review-${finding.id}`, text: tr('Revisión', 'Review') }), select, status));
}

function renderDiffText(text) {
  return h('pre', { class: 'diff' }, ...text.split('\n').map(line => {
    const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'meta'
      : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : null;
    return h('span', { class: kind }, line, kind ? '' : '\n');
  }));
}

function renderDiff(view) {
  const container = clear($('diff'));
  if (!view.plan) { container.append(h('p', { class: 'muted', text: view.planError ? tr('No hay plan: revisa el error de la migración.', 'No plan: review the migration error.') : tr('Sin migración confirmada no se genera diff.', 'No diff is generated without a confirmed migration.') })); return; }
  if (!view.plan.files.length) { container.append(h('p', { class: 'muted', text: tr('El plan no contiene ediciones.', 'The plan contains no edits.') })); return; }
  for (const file of view.files.filter(item => item.diff)) {
    container.append(h('h3', { id: `diff-${file.file}`, tabindex: '-1', text: file.file }), renderDiffText(file.diff));
  }
  if (view.plan.explanations.length) container.append(h('h3', { text: tr('Justificación', 'Rationale') }), h('ul', { class: 'plain' }, ...view.plan.explanations.map(text => h('li', { text }))));
}

function renderVerification(view) {
  const container = clear($('verification'));
  const changes = new Map(view.changes.map(change => [change.id, change]));
  if (view.application) {
    const a = view.application;
    container.append(h('h3', { text: tr('Aplicación', 'Application') }), h('p', {}, badge(a.status), tr(` Archivos: ${a.files.join(', ') || 'ninguno'}`, ` Files: ${a.files.join(', ') || 'none'}`)),
      a.diagnostics.length ? h('ul', { class: 'plain' }, ...a.diagnostics.map(d => h('li', { text: `${d.severity} ${d.code}${d.file ? ` (${d.file})` : ''}: ${d.message}` }))) : null);
  }
  container.append(h('h3', { text: tr('Resultados de verificación', 'Verification results') }));
  if (!view.verification) container.append(h('p', { class: 'muted', text: tr('Sin plan no hay verificación.', 'No verification without a plan.') }));
  else {
    container.append(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...(LANGUAGE === 'es' ? ['Nivel', 'Estado', 'Propiedades comprobadas', 'Motivo / evidencia'] : ['Level', 'Status', 'Properties checked', 'Reason / evidence']).map(text => h('th', { scope: 'col', text })))),
      h('tbody', {}, ...view.verification.results.map(result => h('tr', {},
        h('td', { text: String(result.level) }), h('td', {}, badge(result.status)),
        h('td', { text: result.properties.join(', ') || '—' }),
        h('td', { text: [result.reason, ...result.evidence.map(item => item.message)].filter(Boolean).join(' · ') || '—' })))))));
    container.append(h('p', { class: 'muted', text: tr('Los niveles que requieren ejecutar comandos del repositorio solo se ejecutan desde la CLI con autorización explícita; el panel nunca los lanza.', 'Levels requiring repository commands run only from the CLI with explicit authorization; the panel never runs them.') }));
    if (view.verification.limitations.length) container.append(h('ul', { class: 'plain muted' }, ...view.verification.limitations.map(text => h('li', { text }))));
  }
  const pending = view.findings.filter(finding => finding.outcome === 'pending' || finding.outcome === 'partial' || finding.outcome === 'unplanned');
  container.append(h('h3', { text: tr(`Pendientes de revisión (${pending.length})`, `Pending review (${pending.length})`) }));
  if (!pending.length) container.append(h('p', { class: 'muted', text: tr('No quedan hallazgos pendientes.', 'No pending findings remain.') }));
  else container.append(h('ul', { class: 'plain' }, ...pending.map(finding => {
    const change = changes.get(finding.changeId);
    const use = view.uses.find(item => item.id === finding.useId);
    return h('li', {}, badge(finding.outcome), ' ', change ? badge(change.classification) : null,
      ` ${change ? `${change.method.toUpperCase()} ${change.path} ${change.rule}` : finding.changeId} — ${use ? `${use.file}:${use.line}` : ''} — ${finding.consequence}`);
  })));
}

function renderLimits(view) {
  const container = clear($('limits'));
  container.append(h('h3', { text: tr('Límites del análisis', 'Analysis limitations') }),
    view.limitations.length ? h('ul', { class: 'plain' }, ...view.limitations.map(text => h('li', { text }))) : h('p', { class: 'muted', text: tr('Ninguno declarado.', 'None stated.') }));
  const diagnostics = [...view.diagnostics, ...(view.plan?.diagnostics ?? [])];
  container.append(h('h3', { text: tr(`Diagnósticos (${diagnostics.length})`, `Diagnostics (${diagnostics.length})`) }),
    diagnostics.length ? h('ul', { class: 'plain' }, ...diagnostics.map(d => h('li', { text: `${d.severity} ${d.code}${d.file ? ` (${d.file})` : ''}: ${d.message}` }))) : h('p', { class: 'muted', text: tr('Sin diagnósticos.', 'No diagnostics.') }));
}

function renderApply(view) {
  const container = clear($('apply'));
  show($('export-patch'), !!view.plan);
  container.append(h('h3', { text: tr('Aplicar al repositorio', 'Apply to repository') }));
  if (!view.plan) { container.append(h('p', { class: 'muted', text: tr('No hay plan que aplicar.', 'No plan to apply.') })); return; }
  if (!view.plan.files.length) { container.append(h('p', { class: 'muted', text: tr('El plan no contiene ediciones; no hay nada que aplicar.', 'The plan contains no edits; there is nothing to apply.') })); return; }
  if (view.application?.status === 'applied') {
    container.append(h('p', { class: 'alert ok', role: 'status', text: tr(`Plan aplicado: ${view.application.files.join(', ')}. Revisa el resultado de verificación posterior en «Verificación y pendientes».`, `Plan applied: ${view.application.files.join(', ')}. Review the subsequent verification result under “Verification and pending”.`) }));
    return;
  }
  container.append(
    h('p', {}, tr(`Se escribirán ${view.plan.files.length} archivo(s) dentro de `, `${view.plan.files.length} file(s) will be written within `), h('code', { text: view.inputs.repository }),
      tr('. El servidor vuelve a comprobar cada hash y no sobrescribe archivos modificados después del análisis.', '. The server rechecks each hash and does not overwrite files changed since analysis.')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...(LANGUAGE === 'es' ? ['Archivo', 'Ediciones', 'SHA-256 original'] : ['File', 'Edits', 'Original SHA-256']).map(text => h('th', { scope: 'col', text })))),
      h('tbody', {}, ...view.plan.files.map(file => h('tr', {}, h('td', { class: 'mono', text: file.file }), h('td', { text: String(file.edits) }), h('td', { class: 'mono', text: file.originalHash })))))));
  if (view.application?.status === 'conflict') {
    container.append(h('p', { class: 'alert', role: 'alert', text: tr(`Conflicto: no se escribió nada en ${view.application.files.join(', ')}. ${view.application.diagnostics.map(d => d.message).join(' ')} Vuelve a analizar.`, `Conflict: nothing was written to ${view.application.files.join(', ')}. ${view.application.diagnostics.map(d => d.message).join(' ')} Run the analysis again.`) }));
    return;
  }
  const confirm = h('input', { type: 'checkbox', id: 'apply-confirm' });
  const button = h('button', { type: 'button', id: 'apply-button', disabled: true }, tr('Aplicar plan al repositorio', 'Apply plan to repository'));
  const status = h('span', { class: 'status', role: 'status', 'aria-live': 'polite', id: 'apply-status' });
  const error = h('div', { class: 'alert', role: 'alert', hidden: true, id: 'apply-error' });
  confirm.addEventListener('change', () => { button.disabled = !confirm.checked; });
  button.addEventListener('click', async () => {
    button.disabled = true; confirm.disabled = true;
    setStatus(status, tr('Aplicando…', 'Applying…'), true);
    setAlert(error, '');
    try {
      const files = view.plan.files.map(file => ({ file: file.file, originalHash: file.originalHash }));
      render(await api(`/api/runs/${run.id}/apply`, { method: 'POST', body: { planId: view.plan.id, files, confirm: true } }), 'apply');
      $('apply').querySelector('[role="status"], [role="alert"]')?.setAttribute('tabindex', '-1');
      $('apply').querySelector('[role="status"], [role="alert"]')?.focus();
    } catch (failure) {
      setStatus(status, ''); setAlert(error, describe(failure)); confirm.disabled = false; button.disabled = !confirm.checked;
    }
  });
  container.append(h('div', { class: 'row' }, confirm, h('label', { for: 'apply-confirm', text: tr(`He revisado el diff y autorizo escribir estos ${view.plan.files.length} archivo(s)`, `I reviewed the diff and authorize writing these ${view.plan.files.length} file(s)`) })),
    h('div', { class: 'row actions' }, button, status), error);
}

function render(view, focusId) {
  run = view;
  show($('results'), true);
  show($('actions'), true);
  setAlert($('plan-error'), view.planError);
  renderSummary(view);
  renderChanges(view);
  renderFiles(view);
  renderDiff(view);
  renderVerification(view);
  renderLimits(view);
  renderApply(view);
  if (focusId) $(focusId)?.focus();
}

$('change-filter').addEventListener('change', () => { if (run) renderChanges(run); });

// ---------------------------------------------------------------------------
// Analyze and export

$('analyze-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('analyze');
  const value = id => $(id).value.trim();
  setAlert($('form-error'), '');
  const missing = [['old', tr('el documento anterior', 'the old document')], ['new', tr('el documento nuevo', 'the new document')]].filter(([id]) => !value(id));
  if (missing.length) {
    setAlert($('form-error'), tr(`Indica ${missing.map(([, label]) => label).join(' y ')}.`, `Specify ${missing.map(([, label]) => label).join(' and ')}.`));
    $(missing[0][0]).focus();
    return;
  }
  const body = { old: value('old'), new: value('new'), repository: value('repository') || '.' };
  if (value('baseUrl')) body.baseUrl = value('baseUrl');
  if (value('migration')) body.migration = value('migration');
  button.disabled = true;
  $('main').setAttribute('aria-busy', 'true');
  setStatus($('analyze-status'), tr('Analizando (carga OpenAPI, comparación, escaneo, plan y verificación)…', 'Analyzing (OpenAPI loading, comparison, scan, plan and verification)…'), true);
  try {
    const view = await api('/api/analyze', { method: 'POST', body });
    render(view);
    setStatus($('analyze-status'), tr(`Análisis completado: ${view.summary.changes} cambios, ${view.summary.findings} hallazgos.`, `Analysis complete: ${view.summary.changes} changes, ${view.summary.findings} findings.`));
    selectTab($('tab-changes'), false);
    $('results-title').focus();
  } catch (error) {
    setStatus($('analyze-status'), '');
    setAlert($('form-error'), describe(error));
  } finally {
    button.disabled = false;
    $('main').removeAttribute('aria-busy');
  }
});

for (const button of document.querySelectorAll('[data-export]')) {
  button.addEventListener('click', async () => {
    if (!run) return;
    const format = button.dataset.export;
    const status = $('export-status');
    setStatus(status, tr('Generando…', 'Generating…'), true);
    try {
      const response = await api(`/api/runs/${run.id}/export?format=${format}&lang=${LANGUAGE}`);
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `apipatch.${format}`;
      const link = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      setStatus(status, tr(`Descargado ${name} (${blob.size} bytes).`, `Downloaded ${name} (${blob.size} bytes).`));
    } catch (error) {
      setStatus(status, tr(`Error al exportar: ${describe(error)}`, `Export failed: ${describe(error)}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Startup

(async () => {
  if (!token) {
    setAlert($('session-error'), tr('Falta el token de sesión. Abre la URL completa (con #token=…) que imprimió «apipatch ui» en la terminal.', 'Session token missing. Open the complete URL (with #token=…) printed by “apipatch ui” in the terminal.'));
    $('workspace').textContent = tr('Sin sesión.', 'No session.');
    $('analyze').disabled = true;
    return;
  }
  try {
    const workspace = await api('/api/workspace');
    $('workspace').textContent = tr(`Workspace autorizado: ${workspace.root}`, `Authorized workspace: ${workspace.root}`);
  } catch (error) {
    setAlert($('session-error'), describe(error));
    $('workspace').textContent = tr('Sin sesión válida.', 'No valid session.');
    $('analyze').disabled = true;
  }
})();
