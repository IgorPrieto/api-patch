import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Workspace confinement for the browser API. The browser only ever sends paths relative to the
 * workspace authorized on the command line; every path is canonicalized with realpath and must stay
 * inside that root after following symbolic links.
 */
export class PathError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'PathError';
  }
}

export const MAX_RELATIVE_PATH = 1024;
export const MAX_LISTED_ENTRIES = 1000;
export const MAX_INPUT_FILE_BYTES = 5_000_000;
const HIDDEN_DIRECTORIES = new Set(['.git', 'node_modules']);
const SPEC_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

export type EntryKind = 'directory' | 'document' | 'file';
export interface DirectoryEntry { name: string; path: string; kind: EntryKind; link: boolean }
export interface DirectoryListing { path: string; parent: string | null; entries: DirectoryEntry[]; truncated: boolean; hidden: number }

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function toPosix(relative: string): string { return relative.split(path.sep).join('/'); }

/** Validate a browser-supplied workspace-relative path and return it normalized ('' is the root). */
export function normalizeRelative(input: unknown, field = 'path'): string {
  if (typeof input !== 'string') throw new PathError('INVALID_PATH', `${field}: se esperaba una ruta relativa`);
  if (input.length > MAX_RELATIVE_PATH) throw new PathError('INVALID_PATH', `${field}: la ruta supera ${MAX_RELATIVE_PATH} caracteres`);
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathError('INVALID_PATH', `${field}: la ruta contiene caracteres de control`);
  if (input.includes('\\')) throw new PathError('INVALID_PATH', `${field}: usa "/" como separador`);
  if (input.startsWith('/') || /^[a-z]:/i.test(input) || input.startsWith('~')) throw new PathError('PATH_NOT_RELATIVE', `${field}: solo se admiten rutas relativas al workspace`, 403);
  const parts = input.split('/').filter(part => part !== '' && part !== '.');
  if (parts.includes('..')) throw new PathError('PATH_TRAVERSAL', `${field}: ".." no está permitido`, 403);
  return parts.join('/');
}

/** Canonicalize the workspace root given on the command line. */
export async function resolveWorkspace(workspace: string): Promise<string> {
  let root: string;
  try { root = await realpath(path.resolve(workspace)); } catch { throw new PathError('INVALID_WORKSPACE', `El workspace no existe: ${workspace}`); }
  if (!(await stat(root)).isDirectory()) throw new PathError('INVALID_WORKSPACE', `El workspace no es un directorio: ${workspace}`);
  if (path.dirname(root) === root) throw new PathError('INVALID_WORKSPACE', 'El workspace no puede ser la raíz del sistema de archivos');
  return root;
}

export interface ResolvedPath { absolute: string; relative: string }

/**
 * Resolve `relative` inside `root`, following links only when the final target stays inside the root.
 * `kind` checks the resolved target type; regular files are also bounded in size.
 */
export async function resolveInside(root: string, input: unknown, kind: 'file' | 'directory', field = 'path'): Promise<ResolvedPath> {
  const relative = normalizeRelative(input, field);
  if (kind === 'file' && relative === '') throw new PathError('INVALID_PATH', `${field}: indica un archivo`);
  const candidate = path.join(root, ...relative.split('/').filter(Boolean));
  if (!isWithin(root, candidate)) throw new PathError('PATH_TRAVERSAL', `${field}: la ruta sale del workspace`, 403);
  let real: string;
  try { real = await realpath(candidate); } catch { throw new PathError('PATH_NOT_FOUND', `${field}: no existe "${relative || '.'}" en el workspace`, 404); }
  if (!isWithin(root, real)) throw new PathError('PATH_ESCAPE', `${field}: "${relative}" resuelve fuera del workspace (enlace simbólico)`, 403);
  const info = await stat(real);
  if (kind === 'directory' && !info.isDirectory()) throw new PathError('NOT_A_DIRECTORY', `${field}: "${relative || '.'}" no es un directorio`);
  if (kind === 'file') {
    if (!info.isFile()) throw new PathError('NOT_A_FILE', `${field}: "${relative}" no es un archivo regular`);
    if (info.size > MAX_INPUT_FILE_BYTES) throw new PathError('FILE_TOO_LARGE', `${field}: "${relative}" supera ${MAX_INPUT_FILE_BYTES} bytes`, 413);
  }
  return { absolute: real, relative: toPosix(path.relative(root, real)) };
}

/** List one directory of the workspace. Links escaping the workspace and special files are omitted. */
export async function listDirectory(root: string, input: unknown): Promise<DirectoryListing> {
  const directory = await resolveInside(root, input ?? '', 'directory');
  const shown = normalizeRelative(input ?? '');
  const entries: DirectoryEntry[] = [];
  let hidden = 0;
  let truncated = false;
  const names = (await readdir(directory.absolute)).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    if (HIDDEN_DIRECTORIES.has(name)) { hidden++; continue; }
    if (entries.length >= MAX_LISTED_ENTRIES) { truncated = true; break; }
    const full = path.join(directory.absolute, name);
    let link = false;
    let target = full;
    try {
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        link = true;
        target = await realpath(full);
        if (!isWithin(root, target)) { hidden++; continue; }
      }
      const resolved = link ? await stat(target) : info;
      const kind: EntryKind | undefined = resolved.isDirectory() ? 'directory'
        : resolved.isFile() ? (SPEC_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 'document' : 'file') : undefined;
      if (!kind) { hidden++; continue; }
      entries.push({ name, path: shown ? `${shown}/${name}` : name, kind, link });
    } catch { hidden++; }
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  const parent = shown === '' ? null : shown.split('/').slice(0, -1).join('/');
  return { path: shown, parent, entries, truncated, hidden };
}
