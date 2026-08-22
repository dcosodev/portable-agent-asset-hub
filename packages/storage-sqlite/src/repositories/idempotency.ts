import type { DatabaseSync } from 'node:sqlite';
import type { IdempotencyRecord } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';

type Row = Record<string, unknown>;
export class IdempotencyRepository {
  public constructor(private readonly db: DatabaseSync) {}
  public get(actorId: string, operation: string, key: string): IdempotencyRecord | undefined {
    const row = this.db.prepare('SELECT key,actor_id,operation,request_digest,response_json,status,created_at FROM idempotency WHERE actor_id=? AND operation=? AND key=?').get(actorId, operation, key) as Row | undefined;
    if (!row) return undefined;
    return { key: String(row.key), actorId: String(row.actor_id), operation: String(row.operation), requestDigest: String(row.request_digest), responseJson: String(row.response_json), status: Number(row.status), createdAt: String(row.created_at) };
  }
  public put(record: IdempotencyRecord): void {
    this.db.prepare('INSERT INTO idempotency(key,actor_id,operation,request_digest,response_json,status,created_at) VALUES(?,?,?,?,?,?,?)').run(record.key, record.actorId, record.operation, record.requestDigest, record.responseJson, record.status, record.createdAt);
  }
  public assertDigest(record: IdempotencyRecord, digest: string): void {
    if (record.requestDigest !== digest) throw new HubError('IDEMPOTENCY_CONFLICT', 'idempotency digest conflict', 409);
  }
}
