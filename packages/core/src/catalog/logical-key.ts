import { createHash } from 'node:crypto';
import { normalize, relative, isAbsolute } from 'node:path';
import type { CatalogKind, RootDescriptor } from './types.js';
export function normalizeRootDescriptors(roots: RootDescriptor[]|string[]): RootDescriptor[] {
  if (!Array.isArray(roots) || roots.length===0) throw new Error('roots required');
  const out=roots.map((root)=>typeof root==='string'?{id:'legacy',path:root}:root);
  if (roots.some((root)=>typeof root==='string') && roots.length>1) throw new Error('explicit root ids required');
  const ids=new Set<string>(), paths=new Set<string>();
  for (const root of out) {
    if (!root || typeof root.id!=='string' || root.id.length<1 || root.id.length>64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(root.id)) throw new Error('invalid root id');
    if (!root.path || typeof root.path!=='string' || root.path.length>4096) throw new Error('invalid root path');
    if (ids.has(root.id)||paths.has(root.path)) throw new Error('duplicate root descriptor');
    ids.add(root.id); paths.add(root.path);
  }
  return [...out].sort((a,b)=>a.id.localeCompare(b.id));
}
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString('base64'));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object=value as Record<string,unknown>;
  return `{${Object.keys(object).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}
export function canonicalDigest(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex'); }
export function rootBindingsFingerprint(roots:RootDescriptor[]):string { return canonicalDigest(roots.map((root)=>({id:root.id,path:normalize(root.path).replaceAll('\\','/')}))); }
export function logicalKey(input:{kind:CatalogKind;root:string;relativePath:string;declaredName?:string}): string {
  const path=normalize(input.relativePath).replaceAll('\\','/').replace(/^\.\//u,'');
  const rootId=input.root.startsWith('/') ? 'default' : input.root;
  if(input.kind==='skill' && input.declaredName) return `${input.kind}:${rootId}:${path}:${input.declaredName}`;
  if(input.kind==='tool' && input.declaredName) return `${input.kind}:${rootId}:${path}:${input.declaredName}`;
  return `${input.kind}:${rootId}:${path}`;
}
export function rootRelative(root:string, target:string): string { return relative(root,target).replaceAll('\\','/'); }
export function safeRelativeLocator(locator:string): string {
  if(typeof locator!=='string'||locator.length===0||locator.length>512||isAbsolute(locator)||/[?#]/u.test(locator)||/^[^/]+@[^/]+:/u.test(locator)||locator.split('/').some(p=>p==='..'||p==='')) throw new Error('unsafe source locator');
  const value=normalize(locator).replaceAll('\\','/').replace(/^\.\//u,'');
  if(!value||value==='.'||value.startsWith('../')||value.includes('/../')||[...value].some((character)=>character.charCodeAt(0)<32)||/(token|secret|password|credential|api[-_]?key|cookie)/iu.test(value)) throw new Error('unsafe source locator');
  return value;
}
export function catalogSyncDigest(input:{profile:string;scope:unknown;roots:unknown;selectors:unknown;inputFingerprint:string;rootsFingerprint:string;catalogFingerprint:string;profileFingerprint:string;targetFingerprint:string;operations:unknown;diagnostics:unknown}):string { return canonicalDigest(input); }
