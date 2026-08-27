import type { CatalogEntry, CatalogRelation, CatalogSource, SyncPreview } from '../catalog/types.js';
import type { MutationMeta } from '../storage/contracts.js';
export type CatalogScope={ownerUserId:string;agentId:string};
export type CatalogStats={entries:number;versions:number;sources:number;links:number;relations:number};
export interface CatalogRepository {
 list(scope:CatalogScope): CatalogEntry[];
 listSources(scope:CatalogScope): CatalogSource[];
 stats(scope:CatalogScope): CatalogStats;
 getByLogicalKey(key:string,scope:CatalogScope): CatalogEntry;
 search(scope:CatalogScope,query:string,limit?:number,kind?:CatalogEntry['kind']):CatalogEntry[];
 upsert(entry:Omit<CatalogEntry,'createdAt'|'updatedAt'>, expectedVersion:number|undefined, meta:MutationMeta): CatalogEntry;
 addSource(source:CatalogSource, meta:MutationMeta):CatalogSource;
 link(entryId:string,sourceId:string,scope:CatalogScope,meta:MutationMeta):void;
 relate(relation:CatalogRelation, meta:MutationMeta):void;
 applyPreview(preview:SyncPreview, meta:MutationMeta):void;
}
export interface CatalogSyncRepository {
 savePreview(preview:SyncPreview,meta:MutationMeta):SyncPreview;
 getPreview(id:string,scope:CatalogScope):SyncPreview;
 review(id:string,digest:string,scope:CatalogScope,meta:MutationMeta):void;
 markApplied(id:string,digest:string,scope:CatalogScope,meta:MutationMeta):void;
}
