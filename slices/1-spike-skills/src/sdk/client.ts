import type { SkillInput, SkillVersion } from '../core/types.js';

export class SkillSdk {
  public constructor(private readonly base: string) {}
  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.base + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!response.ok) {
      const error = new Error((await response.text()) || `HTTP_${response.status}`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    return response.json() as Promise<T>;
  }
  public create(input: SkillInput): Promise<SkillVersion> { return this.call('/skills', { method: 'POST', body: JSON.stringify(input) }); }
  public get(slug: string): Promise<SkillVersion> { return this.call(`/skills/${encodeURIComponent(slug)}`); }
  public update(slug: string, input: SkillInput, expectedVersion: number): Promise<SkillVersion> { return this.call(`/skills/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify({ input, expectedVersion }) }); }
  public search(q: string): Promise<SkillVersion[]> { return this.call(`/skills?q=${encodeURIComponent(q)}`); }
  public resourcePut(skillId: string, version: number, path: string, data: Uint8Array): Promise<unknown> {
    return this.call(`/resources/${encodeURIComponent(skillId)}/${version}/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([data as unknown as ArrayBufferView<ArrayBuffer>]) });
  }
  public async resourceRead(skillId: string, version: number, path: string): Promise<Uint8Array> {
    const response = await fetch(`${this.base}/resources?skillId=${encodeURIComponent(skillId)}&version=${version}&path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error((await response.text()) || `HTTP_${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
