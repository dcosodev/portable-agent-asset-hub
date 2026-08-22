import {
  constants,
  closeSync,
  chmodSync,
  fsyncSync,
  realpathSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type FileSnapshot = { existed: boolean; bytes?: Buffer };

/** A deliberately small, filesystem-only publication port for catalog markers. */
export type FileSyncMarkerOptions = { /** test-only race probe; canonical production leaves unset */ beforeRename?: (target:string)=>void };
export class FileSyncMarker {
  readonly root: string;
  readonly target: string;
  private readonly absolute: string;

  public constructor(root: string, target: string, private readonly options: FileSyncMarkerOptions = {}) {
    const declared=resolve(root);
    if (existsSync(declared) && lstatSync(declared).isSymbolicLink()) throw new Error('marker root must not be a symlink');
    this.root = existsSync(declared) ? realpathSync(declared) : declared;
    this.target = target;
    this.assertRoot();
    this.absolute = this.resolveTarget(target);
  }

  private assertRoot(): void {
    const created=!existsSync(this.root);
    if (created) mkdirSync(this.root, { recursive: true, mode:0o700 });
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) {
      throw new Error('marker root must be a real directory');
    }
    const rootStat=lstatSync(this.root);
    if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) throw new Error('marker root owner mismatch');
    if ((rootStat.mode & 0o077)!==0) {
      if (created) chmodSync(this.root,0o700);
      else throw new Error('marker root must not be accessible by group or others');
    }
  }

  private resolveTarget(target: string): string {
    if (!target || isAbsolute(target)) throw new Error('marker target must be relative');
    const absolute = resolve(this.root, target);
    const rel = relative(this.root, absolute);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error('marker target escapes root');
    }
    this.assertAncestors(absolute);
    return absolute;
  }

  private assertAncestors(absolute: string): void {
    this.assertRoot();
    let current = this.root;
    const rel = relative(this.root, absolute);
    const parts = rel.split(sep);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        throw new Error('marker path contains symlink ancestor');
      }
      if (existsSync(current)) {
        const stat=lstatSync(current);
        if(!stat.isDirectory()||(typeof process.getuid==='function'&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0) throw new Error('marker parent must be a private owned directory');
      }
    }
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      throw new Error('marker target cannot be a symlink');
    }
  }

  private ensureParents():void {
    let current=this.root;
    for(const part of relative(this.root,dirname(this.absolute)).split(sep).filter(Boolean)) {
      current=join(current,part);
      if(!existsSync(current)) mkdirSync(current,{mode:0o700});
      const stat=lstatSync(current);
      if(stat.isSymbolicLink()||!stat.isDirectory()||(typeof process.getuid==='function'&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0) throw new Error('marker parent must be a private owned directory');
    }
  }

  public snapshot(): FileSnapshot {
    this.assertAncestors(this.absolute);
    if (!existsSync(this.absolute)) return { existed: false };
    const stat = lstatSync(this.absolute);
    if (!stat.isFile()) throw new Error('marker target must be a regular file');
    return { existed: true, bytes: Buffer.from(readFileSync(this.absolute)) };
  }

  public fingerprint(): string {
    const prior = this.snapshot();
    return createHash('sha256')
      .update(prior.existed ? Buffer.concat([Buffer.from([1]), prior.bytes ?? Buffer.alloc(0)]) : Buffer.from([0]))
      .digest('hex');
  }

  public write(bytes: Buffer): void {
    this.assertAncestors(this.absolute);
    this.ensureParents();
    this.assertAncestors(this.absolute);
    const temp = join(dirname(this.absolute), `.${this.target.split(sep).at(-1)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW, 0o600);
      chmodSync(temp,0o600);
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.assertAncestors(this.absolute);
      this.options.beforeRename?.(this.absolute);
      renameSync(temp, this.absolute);
      this.assertAncestors(this.absolute);
      const parentFd=openSync(dirname(this.absolute),constants.O_RDONLY|constants.O_DIRECTORY); try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* already renamed */ }
    }
  }

  public restore(prior: FileSnapshot): void {
    this.assertAncestors(this.absolute);
    if (!prior.existed) {
      if (existsSync(this.absolute)) unlinkSync(this.absolute);
      return;
    }
    this.write(prior.bytes ?? Buffer.alloc(0));
  }

  public read(): Buffer { return Buffer.from(this.snapshot().bytes ?? Buffer.alloc(0)); }
}
