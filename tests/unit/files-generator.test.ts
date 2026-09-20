import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFileRequests, generateFiles } from '../../src/files/generator';

describe('file generation', () => {
  it('extracts and removes explicit file markers', () => {
    const result = extractFileRequests('说明\n\n```json\n{"file":{"format":"txt","filename":"a.txt","content":"hello"}}\n```');
    expect(result.text).toBe('说明');
    expect(result.files).toEqual([{ format: 'txt', filename: 'a.txt', content: 'hello' }]);
  });

  it('writes direct formats inside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bridge-files-'));
    try {
      const file = (await generateFiles([{ format: 'txt', filename: '../result.txt', content: 'ok' }], workspace))[0]!;
      expect(file.fileName).toBe('result.txt');
      expect(await readFile(file.path, 'utf8')).toBe('ok');
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('converts office formats with the bundled LibreOffice runtime', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bridge-office-'));
    try {
      const files = await generateFiles([
        { format: 'pdf', filename: 'report.pdf', content: 'Report' },
        { format: 'docx', filename: 'report.docx', content: 'Report' },
        { format: 'xlsx', filename: 'table.xlsx', content: 'Name,Value\nA,1\n' },
      ], workspace);
      expect(files).toHaveLength(3);
      for (const file of files) expect((await stat(file.path)).size).toBeGreaterThan(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 90_000);
});
