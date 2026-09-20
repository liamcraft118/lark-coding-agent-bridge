import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const SOFFICE = '/Users/mbp/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const ALLOWED_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'csv', 'md', 'txt']);

export interface FileRequest {
  format: string;
  filename?: string;
  content: string;
}

export interface GeneratedFile {
  path: string;
  fileName: string;
  format: string;
}

export interface ExtractedFiles {
  text: string;
  files: FileRequest[];
}

export type WorkspaceSnapshot = Map<string, { size: number; mtimeMs: number }>;

export async function snapshotWorkspace(workspace: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  await walkWorkspace(resolve(workspace), resolve(workspace), snapshot);
  return snapshot;
}

export async function changedWorkspaceFiles(
  workspace: string,
  before: WorkspaceSnapshot,
): Promise<GeneratedFile[]> {
  const after = await snapshotWorkspace(workspace);
  const root = resolve(workspace);
  const changed: GeneratedFile[] = [];
  for (const [relativePath, metadata] of after) {
    const previous = before.get(relativePath);
    if (previous && previous.size === metadata.size && previous.mtimeMs === metadata.mtimeMs) continue;
    const path = join(root, relativePath);
    const fileName = basename(path);
    const format = extname(fileName).slice(1).toLowerCase();
    if (!format || fileName.startsWith('.')) continue;
    changed.push({ path, fileName, format });
  }
  return changed;
}

export function extractFileRequests(input: string): ExtractedFiles {
  const files: FileRequest[] = [];
  const ranges: Array<[number, number]> = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of input.matchAll(fence)) {
    const raw = match[1]?.trim();
    if (!raw || (!raw.includes('"file"') && !raw.includes('"files"'))) continue;
    try {
      const parsed = JSON.parse(raw) as { file?: unknown; files?: unknown };
      const candidates = Array.isArray(parsed.files) ? parsed.files : parsed.file ? [parsed.file] : [];
      const valid = candidates.filter(isFileRequest);
      if (valid.length === 0) continue;
      files.push(...valid);
      const start = match.index ?? 0;
      ranges.push([start, start + match[0].length]);
    } catch {
      // Keep malformed or unrelated code fences visible to the user.
    }
  }
  let text = input;
  for (const [start, end] of ranges.reverse()) text = text.slice(0, start) + text.slice(end);
  return { text: text.trim(), files };
}

export async function generateFiles(requests: readonly FileRequest[], workspace: string): Promise<GeneratedFile[]> {
  if (requests.length === 0) return [];
  const root = resolve(workspace);
  const outputDir = join(root, '.bridge-generated');
  const tempDir = join(outputDir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const generated: GeneratedFile[] = [];
  try {
    for (const request of requests) {
      const format = request.format.toLowerCase().replace(/^\./, '');
      if (!ALLOWED_FORMATS.has(format)) throw new Error(`unsupported file format: ${format}`);
      const fileName = safeFileName(request.filename ?? `generated-${generated.length + 1}.${format}`, format);
      const outputPath = join(outputDir, fileName);
      const sourcePath = join(tempDir, `${generated.length}.source`);
      if (format === 'md' || format === 'txt' || format === 'csv') {
        await writeFile(outputPath, request.content, { encoding: 'utf8', mode: 0o600 });
      } else if (format === 'xlsx') {
        const csvSource = `${sourcePath}.csv`;
        await writeFile(csvSource, request.content, { encoding: 'utf8', mode: 0o600 });
        await convertWithSoffice(csvSource, outputDir, 'xlsx');
        await renameConverted(csvSource, outputPath, 'xlsx');
      } else {
        const actualSource = `${sourcePath}.html`;
        await writeFile(actualSource, htmlDocument(request.content), { encoding: 'utf8', mode: 0o600 });
        if (format === 'docx') {
          await convertWithSoffice(actualSource, tempDir, 'odt');
          const odtSource = `${sourcePath}.odt`;
          await convertWithSoffice(odtSource, outputDir, 'docx');
          await renameConverted(odtSource, outputPath, 'docx');
        } else {
          await convertWithSoffice(actualSource, outputDir, 'pdf');
          await renameConverted(actualSource, outputPath, 'pdf');
        }
      }
      generated.push({ path: outputPath, fileName, format });
    }
    return generated;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isFileRequest(value: unknown): value is FileRequest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FileRequest>;
  return typeof item.format === 'string' && typeof item.content === 'string';
}

function safeFileName(input: string, format: string): string {
  const name = basename(input).replace(/[^\w.()\-\u4e00-\u9fff ]/g, '_').trim();
  if (!name || name === '.' || name === '..') throw new Error('invalid output filename');
  const withExt = extname(name).toLowerCase() === `.${format}` ? name : `${name}.${format}`;
  const resolved = resolve('/tmp', withExt);
  if (isAbsolute(withExt) || relative('/tmp', resolved).startsWith('..')) throw new Error('invalid output filename');
  return withExt;
}

function htmlDocument(content: string): string {
  const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:11pt;white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:4px}</style></head><body>${escaped}</body></html>`;
}

async function convertWithSoffice(source: string, outputDir: string, format: string): Promise<void> {
  await execFileAsync(SOFFICE, ['--headless', '--convert-to', format, '--outdir', outputDir, source], {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function renameConverted(source: string, outputPath: string, format: string): Promise<void> {
  const produced = join(resolve(outputPath, '..'), `${basename(source, extname(source))}.${format}`);
  const data = await readFile(produced);
  await writeFile(outputPath, data, { mode: 0o600 });
  await rm(produced, { force: true });
}

async function walkWorkspace(root: string, current: string, snapshot: WorkspaceSnapshot): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.bridge-generated' || entry.name.startsWith('.')) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkWorkspace(root, path, snapshot);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(path);
      snapshot.set(relative(root, path), { size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // The file may disappear while a tool is running.
    }
  }
}
