import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const importPattern = /(?:from\s+|import\s*\(|require\s*\()["'][^"']*(?:cloud|proxy|Tencent|MemoryProxy)[^"']*["']/i;
async function walk(directory) { const files = []; let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return files; throw error; } for (const entry of entries) { const path = join(directory, entry.name); if (entry.isDirectory()) files.push(...await walk(path)); else if (/\.(js|json)$/.test(entry.name)) files.push(path); } return files; }
const temp = await mkdtemp(join(tmpdir(), 's1-no-cloud-'));
try {
  const packages = (await readdir('dist-package')).filter((x) => x.endsWith('.tgz'));
  if (!packages.length) throw new Error('PACKAGE_NOT_BUILT');
  const extracted = join(temp, 'package'); await run('tar', ['-xzf', join('dist-package', packages.sort()[0]), '-C', temp]);
  const files = [...await walk('src'), ...await walk('dist'), ...await walk(extracted)];
  for (const file of files) { const text = await readFile(file, 'utf8'); if (importPattern.test(text)) throw new Error(`cloud/proxy import ${file}`); if (/[/\\]mcp[/\\].*\.(js)$/.test(file) && /node:sqlite|DatabaseSync/.test(text)) throw new Error(`MCP SQLite import ${file}`); }
  const packageFiles = files.filter((file) => file.startsWith(extracted));
  console.log(JSON.stringify({ no_cloud_or_proxy_runtime_imports: true, files_scanned: files.length, package_files_scanned: packageFiles.length, package_runtime_files: packageFiles }));
} finally { await rm(temp, { recursive: true, force: true }); }
