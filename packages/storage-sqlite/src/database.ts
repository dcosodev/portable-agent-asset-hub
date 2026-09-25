import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { doctor, type DoctorReport } from './doctor.js';
import { migrate } from './migrations/runner.js';

export class HubDatabase {
  readonly #db: DatabaseSync;
  readonly #readOnly: boolean;

  public constructor(path: string, options: { readOnly?: boolean; mode?: 'read-only' | 'read-write' } = {}) {
    this.#readOnly = options.readOnly === true || options.mode === 'read-only';
    if (options.mode === 'read-write' && options.readOnly === true) {
      throw new Error('conflicting SQLite storage modes');
    }
    if (this.#readOnly) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) throw new Error(`read-only database must be an existing regular file: ${path}`);
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        if (lstatSync(sidecar, { throwIfNoEntry: false })) throw new Error(`read-only database refuses an active SQLite sidecar: ${sidecar}`);
      }
      // immutable=1 prevents SQLite from creating WAL/SHM sidecars while
      // native readOnly still rejects every database write.
      this.#db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
      const migrations = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
      const report = doctor(this.#db, migrations);
      if (!report.ok) {
        this.#db.close();
        throw new Error(`read-only database schema validation failed: ${report.errors.join(', ')}`);
      }
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    const migrations = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    migrate(this.#db, migrations);
  }

  public withConnection<T>(callback: (db: DatabaseSync) => T): T {
    return callback(this.#db);
  }

  public doctor(): DoctorReport {
    return doctor(this.#db);
  }

  public close(): void {
    this.#db.close();
  }

  public get readOnly(): boolean {
    return this.#readOnly;
  }
}
