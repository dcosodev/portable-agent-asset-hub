import type { ExplicitCandidate,ExplicitCandidateSummary,ExplicitImpact,GraphData,ResourceMeta,RelationProposal,RetrievalSummary,SearchHit,SkillDetail } from './types';import {parseGraph} from './graph-model';
async function json<T>(path:string,init?:RequestInit):Promise<T>{const response=await fetch(path,{...init,headers:{accept:'application/json',...(init?.headers??{})}});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error((data as {error?:{message?:string}}).error?.message??`HTTP ${response.status}`);}return response.json() as Promise<T>}
export const api={
 status:()=>json<Record<string,unknown>>('/api/v1/status'), capabilities:()=>json<Record<string,unknown>>('/api/v1/capabilities'),
 globalGraph:(versions:string)=>json<unknown>(`/api/v1/graph/skills?versions=${encodeURIComponent(versions)}`).then(parseGraph),
 skillGraph:(id:string,mode:string,depth:number,versions:string)=>json<unknown>(`/api/v1/skills/${encodeURIComponent(id)}/graph?mode=${mode}&depth=${depth}&versions=${versions}`).then(parseGraph),
 impact:(id:string,depth:number)=>json<unknown>(`/api/v1/skills/${encodeURIComponent(id)}/impact?depth=${depth}`).then(parseGraph),
 search:(q:string)=>json<{items:SearchHit[]}>(`/api/v1/skills/search?q=${encodeURIComponent(q)}&limit=20`),
 skill:(id:string)=>json<SkillDetail>(`/api/v1/skills/${encodeURIComponent(id)}`),
 resources:(id:string)=>json<{items:ResourceMeta[]}>(`/api/v1/skills/${encodeURIComponent(id)}/resources`),
 resource:(id:string,path:string)=>json<{relativePath:string;mime:string;size:number;encoding?:string;content?:string;bytes?:string}>(`/api/v1/skills/${encodeURIComponent(id)}/resources/${path.split('/').map(encodeURIComponent).join('/')}`),
 retrievals:()=>json<{items:RetrievalSummary[]}>('/api/v1/retrieval-events?limit=100&includeQuery=true'),
 retrievalGraph:(id:string)=>json<GraphData & {metadata:GraphData['metadata']&{query:string;requestId:string;profile:string;classification:{primary:string};policy:Record<string,boolean>;createdAt:string;actor:{userId:string;agentId:string}}}>(`/api/v1/retrieval-events/${encodeURIComponent(id)}/graph`),
 proposals:(status?:string)=>json<{items:RelationProposal[]}>(`/api/v1/skill-relation-proposals${status ? `?status=${encodeURIComponent(status)}` : ''}`),
 reviewProposal:(id:string,status:'approved'|'rejected',reason?:string,changes?:{relationType?:string;reverseDirection?:boolean;constraint?:string|null})=>json<RelationProposal>(`/api/v1/skill-relation-proposals/${encodeURIComponent(id)}/${status==='approved'?'approve':'reject'}`,{method:'POST',headers:{'content-type':'application/json','if-match':'*'},body:JSON.stringify({...(reason?{reason}:{}),...(changes??{})})}),
 createManualProposal:(input:{sourceSkillId:string;targetSkillId:string;relationType:string;constraint:string|null})=>json<RelationProposal>('/api/v1/skill-relation-proposals',{method:'POST',headers:{'content-type':'application/json','if-match':'*'},body:JSON.stringify(input)}),
 discover:(skillId:string)=>json<{candidatePairs:number;proposalsCreated:number;highConfidence:number;mediumConfidence:number;operational:number;semantic:number}>('/api/v1/skill-relation-proposals/discover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({skillIds:[skillId],dryRun:false})}),
 previewApply:(proposalIds:string[])=>json<{changes:Array<Record<string,unknown>>;planDigest:string;validation?:Record<string,unknown>}>('/api/v1/skill-relation-proposals/apply-preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proposalIds})}),
  apply:(proposalIds:string[],reviewedDigest:string)=>json<Record<string,unknown>>('/api/v1/skill-relation-proposals/apply',{method:'POST',headers:{'content-type':'application/json','if-match':'*'},body:JSON.stringify({proposalIds,reviewedDigest})}),
  explicitCandidates:(query:string)=>json<{items:ExplicitCandidate[];summary:ExplicitCandidateSummary;nextCursor:string|null}>(`/api/v1/skill-relation-candidates/explicit${query ? `?${query}` : ''}`),
  explicitImpact:(pairKeys:string[])=>json<ExplicitImpact>('/api/v1/skill-relation-candidates/explicit/impact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pairKeys})}),
  stageExplicit:(pairKeys:string[])=>json<{staged:Array<{proposalId:string;pairKey:string}>}>('/api/v1/skill-relation-candidates/explicit/stage',{method:'POST',headers:{'content-type':'application/json','if-match':'*'},body:JSON.stringify({pairKeys})}),
 };
