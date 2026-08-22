export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'INTERNAL'
  | 'MIGRATION_DRIFT'
  | 'MIGRATION_GAP'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'PRECONDITION_FAILED';

export class HubError extends Error {
  public readonly name = 'HubError';

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  public toJSON(): { error: { code: ErrorCode; message: string; status: number; details?: unknown } } {
    return { error: { code: this.code, message: this.message, status: this.status, details: this.details } };
  }
}

export function notFound(): HubError {
  return new HubError('NOT_FOUND', 'resource not found', 404);
}
