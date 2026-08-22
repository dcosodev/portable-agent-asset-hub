export type IdempotencyRecord = {
  key: string;
  actorId: string;
  operation: string;
  requestDigest: string;
  responseJson: string;
  status: number;
  createdAt: string;
};
export type IdempotencyResult<T> = { replayed: boolean; value: T };
export type IdempotencyInput = { actorId: string; operation: string; key: string; digest: string };
export function requestDigest(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}
