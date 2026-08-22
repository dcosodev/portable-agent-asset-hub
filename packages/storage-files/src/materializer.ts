import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materializeProfile, type ActorContext, type MaterializedProfile, type MaterializationRecord, type MutationMeta, type Storage } from '@portable-agent-asset-hub/core';
export type FileWriter = (path: string, bytes: Buffer) => void;
export type FileMaterializerHooks = {
  write?: FileWriter;
  afterWrite?: (transaction: import('@portable-agent-asset-hub/core').StorageTransaction) => void;
};
export type PriorFile = { existed: boolean; bytes?: Buffer };
export class FileMaterializer {
  private readonly base: string;
  public constructor(root: string, private readonly hooks: FileMaterializerHooks = {}) { this.base=resolve(root); this.assertSafeRoot(); }
  private assertSafeRoot(): void { if (existsSync(this.base) && lstatSync(this.base).isSymbolicLink()) throw new Error('symlink root rejected'); }
  private targetPath(target: string): string { if (!target || isAbsolute(target)) throw new Error('target must be relative'); const absolute=resolve(this.base,target); const rel=relative(this.base,absolute); if(rel.startsWith('..'+sep)||isAbsolute(rel)||normalize(rel)!==rel) throw new Error('path containment violation'); this.assertSegments(absolute); return absolute; }
  private assertSegments(absolute: string): void { if (existsSync(this.base) && lstatSync(this.base).isSymbolicLink()) throw new Error('symlink root rejected'); const rel=relative(this.base,absolute); let current=this.base; for(const segment of rel.split(sep)) { if(!segment) continue; current=join(current,segment); if(existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('symlink path rejected'); } }
  public snapshot(target: string): PriorFile { const absolute=this.targetPath(target); if(!existsSync(absolute)) return {existed:false}; return {existed:true,bytes:readFileSync(absolute)}; }
  public restore(target: string, prior: PriorFile): void { const absolute=this.targetPath(target); if(prior.existed) { mkdirSync(dirname(absolute),{recursive:true}); writeFileSync(absolute, prior.bytes ?? Buffer.alloc(0)); } else if(existsSync(absolute)) unlinkSync(absolute); }
  public materialize(target: string, content: MaterializedProfile): PriorFile { const absolute=this.targetPath(target); const prior=this.snapshot(target); mkdirSync(dirname(absolute),{recursive:true}); this.assertSegments(absolute); const temp=join(dirname(absolute),`.${absolute.split(sep).pop()}.${process.pid}.${randomUUID()}.tmp`); let fd:number|undefined; try { fd=openSync(temp,'wx'); closeSync(fd); fd=undefined; (this.hooks.write ?? writeFileSync)(temp,content.bytes); renameSync(temp,absolute); return prior; } catch(error) { if(fd!==undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* no temp */ } try { this.restore(target,prior); } catch { /* preserve original failure */ } throw error; } finally { try { unlinkSync(temp); } catch { /* already renamed/removed */ } } }
  public materializeProfile(
    storage: Storage,
    actor: ActorContext,
    profileId: string,
    target: string,
    mutation: MutationMeta,
  ): MaterializationRecord {
    const prior = this.snapshot(target);
    let wrote = false;
    try {
      return storage.transaction(actor, (tx) => {
        const profile = tx.profiles.get(profileId, actor.scope);
        const content = materializeProfile(profile);
        this.materialize(target, content);
        wrote = true;
        this.hooks.afterWrite?.(tx);
        return tx.materializations.record({
          profileId,
          scope: actor.scope,
          version: profile.version,
          target,
          digest: content.digest,
          bytes: content.bytes,
        }, mutation);
      });
    } catch (error) {
      if (wrote) this.restore(target, prior);
      throw error;
    }
  }
  public read(target: string): Buffer { return readFileSync(this.targetPath(target)); }
}
