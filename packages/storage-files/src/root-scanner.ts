import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { type CatalogCandidate, type CatalogScanner, normalizeRootDescriptors, type RootDescriptor } from '@portable-agent-asset-hub/core';
const denied=/^(\.env|.*\.(sqlite|sqlite3|db|log|jsonl|pem|key|crt)|.*(transcript|cookie|token|secret|event).*?)$/iu;

/**
 * Bounded YAML frontmatter parser used to pull `name:` and `description:`
 * scalar values out of `SKILL.md` files. Deliberately *not* a general
 * YAML parser — it only recognises the initial `---` block, caps both
 * byte and line counts so a hostile file cannot blow the stack, supports
 * plain / single-quoted / double-quoted scalar values, ignores unknown
 * keys, and performs no interpolation. Anything else falls back to
 * `undefined` so the scanner still returns a usable candidate.
 */
const SKILL_BASENAME = 'SKILL.md';
const SKILL_SOURCE_KIND = 'skill-file';
const FRONTMATTER_MAX_BYTES = 16 * 1024;
const FRONTMATTER_MAX_LINES = 64;

function decodeScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  // Strip YAML comments and trailing whitespace, drop any `{{ ... }}`
  // interpolation markers — we never expand them.
  return value.split(/\s+#/u)[0]?.trim() ?? '';
}

function parseSkillFrontmatter(bytes: Buffer, maxBytes = FRONTMATTER_MAX_BYTES, maxLines = FRONTMATTER_MAX_LINES): { name: string | undefined; description: string | undefined } {
  // Only ever look at the bounded slice; never touch the rest of the file.
  const slice = bytes.subarray(0, Math.min(bytes.byteLength, maxBytes));
  const text = slice.toString('utf8');
  // Must begin with `---\n` (or `---\r\n`).
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n') && text !== '---') return { name: undefined, description: undefined };
  const openerLen = text.startsWith('---\r\n') ? 5 : text.startsWith('---\n') ? 4 : 3;
  const tail = text.slice(openerLen);
  const closeMarker = tail.indexOf('\n---');
  if (closeMarker === -1) return { name: undefined, description: undefined };
  let block = tail.slice(0, closeMarker);
  if (block.endsWith('\r')) block = block.slice(0, -1);
  const lines = block.split(/\r?\n/u);
  if (lines.length > maxLines) return { name: undefined, description: undefined };
  let name: string | undefined;
  let description: string | undefined;
  for (const line of lines) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (key === 'name') {
      const value = decodeScalar(match[2]!);
      if (value !== undefined && value.length > 0) name = value;
    } else if (key === 'description') {
      const value = decodeScalar(match[2]!);
      if (value !== undefined && value.length > 0) description = value;
    }
  }
  return { name, description };
}

export type RootScannerOptions={maxDepth?:number;maxFiles?:number;maxBytes?:number;/** test-only race probes; never supplied by production coordinator */afterRootLstat?:(path:string)=>void;beforeOpen?:(path:string,type:'directory'|'file')=>void};
export class RootScanner implements CatalogScanner{
 constructor(private readonly options:RootScannerOptions={}){}
 scan(input:{roots:RootDescriptor[]|string[];selectors?:string[]}):CatalogCandidate[]{
  const out:CatalogCandidate[]=[];const roots=normalizeRootDescriptors(input.roots);const selectors=(input.selectors??[]).map((s)=>s.replaceAll('\\','/').replace(/^\.\//u,''));
  if(selectors.some((s)=>!s||s.startsWith('/')||s.split('/').includes('..')))throw new Error('invalid selector');
  for(const descriptor of roots){const base=resolve(descriptor.path);const rootStat=lstatSync(base);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new Error('invalid or symlink root');this.options.afterRootLstat?.(base);const canonical=realpathSync(base);const after=lstatSync(base),canonicalStat=lstatSync(canonical);if(after.isSymbolicLink()||!after.isDirectory()||after.dev!==rootStat.dev||after.ino!==rootStat.ino||canonicalStat.dev!==rootStat.dev||canonicalStat.ino!==rootStat.ino)throw new Error('root identity changed');this.walk(canonical,canonical,0,out,selectors,descriptor.id);}
  return out.sort((a,b)=>a.rootId!.localeCompare(b.rootId!)||a.relativePath.localeCompare(b.relativePath));
 }
 private walk(base:string,current:string,depth:number,out:CatalogCandidate[],selectors:string[],rootId:string):void{
  if(depth>(this.options.maxDepth??8))throw new Error('depth limit');
  const beforeDir=lstatSync(current);if(!beforeDir.isDirectory()||beforeDir.isSymbolicLink())throw new Error('directory changed');
  this.options.beforeOpen?.(current,'directory');
  const opened=lstatSync(current);if(opened.dev!==beforeDir.dev||opened.ino!==beforeDir.ino||opened.isSymbolicLink())throw new Error('directory identity changed');
  for(const entry of readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const check=lstatSync(current);if(check.ino!==beforeDir.ino||check.dev!==beforeDir.dev)throw new Error('directory identity changed');
   const name=entry.name;if(denied.test(name))continue;const path=join(current,name);const st=lstatSync(path);if(st.isSymbolicLink())throw new Error('symlink path rejected');
   if(st.isDirectory()){this.walk(base,path,depth+1,out,selectors,rootId);continue;}
   if(out.length>=(this.options.maxFiles??1000))throw new Error('file count limit');if(st.size>(this.options.maxBytes??1024*1024))continue;
   const rel=relative(base,path).split(sep).join('/');if(selectors.length&&!selectors.some((s)=>rel===s||rel.startsWith(`${s}/`)))continue;
   this.options.beforeOpen?.(path,'file');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
    const before=fstatSync(fd);if(!before.isFile()||before.dev!==st.dev||before.ino!==st.ino)throw new Error('file identity changed');
    const chunks:Buffer[]=[];let remaining=Math.min(before.size,this.options.maxBytes??1024*1024),offset=0;while(remaining>0){const chunk=Buffer.alloc(Math.min(65536,remaining));const n=readSync(fd,chunk,0,chunk.length,offset);if(n===0)break;chunks.push(chunk.subarray(0,n));offset+=n;remaining-=n;}
    const after=fstatSync(fd);if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||lstatSync(path).ino!==before.ino)throw new Error('file changed during read');
    const bytes=Buffer.concat(chunks);
    const baseName=basename(rel);
    if(baseName===SKILL_BASENAME){
     const frontmatter=parseSkillFrontmatter(bytes);
     const fallback=basename(dirname(rel))||baseName;
     const skillName=(frontmatter.name&&frontmatter.name.length>0)?frontmatter.name:fallback;
     out.push({kind:'skill',sourceKind:SKILL_SOURCE_KIND,relativePath:rel,locator:rel,bytes,metadata:{name:skillName,size:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')},summary:frontmatter.description,rootId});
    } else {
     out.push({kind:rel==='README.md'?'repository':'document',relativePath:rel,locator:rel,bytes,metadata:{size:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')},rootId});
    }
   }finally{closeSync(fd);}
  }
  const afterDir=lstatSync(current);if(afterDir.ino!==beforeDir.ino||afterDir.dev!==beforeDir.dev||afterDir.isSymbolicLink())throw new Error('directory changed');
 }
}
