import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';

const source = 'packages/storage-sqlite/src/migrations';
const destination = 'packages/storage-sqlite/dist/migrations';
await mkdir(destination, { recursive: true });
for (const name of await readdir(destination)) {
  if (name.endsWith('.sql') || (name.endsWith('.ts') && !name.endsWith('.d.ts'))) {
    await rm(`${destination}/${name}`, { force: true });
  }
}
const names = (await readdir(source)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
for (const name of names) await copyFile(`${source}/${name}`, `${destination}/${name}`);
