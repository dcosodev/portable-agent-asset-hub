export type ErrorBody = { error: { code: string; message: string; status: number }; request_id: string };
export type ClientOptions = { baseUrl: string; token?: string; actorHeaders?: Record<string, never> };
export class SdkError extends Error { public constructor(public readonly code: string, public readonly status: number, public readonly requestId: string, message: string) { super(message); this.name = 'SdkError'; } }
export class Client {
  public constructor(private readonly options: ClientOptions) {}
  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers); headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json'); if (this.options.token) headers.set('authorization', `Bearer ${this.options.token}`);
    const response = await fetch(new URL(path, this.options.baseUrl), { ...init, headers });
    const requestId = response.headers.get('x-request-id') ?? '';
    const payload = await response.json() as T | ErrorBody;
    if (!response.ok) { const error = payload as ErrorBody; throw new SdkError(error.error?.code ?? 'INTERNAL', response.status, error.request_id ?? requestId, error.error?.message ?? 'request failed'); }
    return payload as T;
  }
  public health(): Promise<{ok:boolean}> { return this.request('/api/v1/health'); }
  public status(): Promise<{ok:boolean;service:string}> { return this.request('/api/v1/status'); }
}
