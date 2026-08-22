import type { CatalogCandidate, CatalogScanner } from './types.js';
export type SourceScannerPort = CatalogScanner;
export function candidatesFrom(entries:CatalogCandidate[]):CatalogScanner{return {scan:()=>entries.map((entry)=>({...entry,bytes:Buffer.from(entry.bytes)}))};}
