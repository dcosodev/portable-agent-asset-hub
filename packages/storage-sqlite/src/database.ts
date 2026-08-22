import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { doctor, type DoctorReport } from './doctor.js';
import { migrate } from './migrations/runner.js';

export class HubDatabase {
  readonly #db: DatabaseSync;

  public constructor(path: string) {
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
}
