const SECRET=/^(body|content|secret|token|password|api[_-]?key|private[_-]?key|authorization)$/iu;
export function sanitizeMetadata(input:Record<string,unknown>, maxSummary=512):Record<string,unknown>{
 const out:Record<string,unknown>={};
 for(const [key,value] of Object.entries(input).sort()){ if(SECRET.test(key)) { if(key==='body'||key==='content') continue; out[key]='[REDACTED]'; continue; } if(typeof value==='string') out[key]=value.trim().slice(0,maxSummary); else if(typeof value==='number'||typeof value==='boolean'||value===null) out[key]=value; }
 return out;
}
export function boundedSummary(value:unknown,max=512):string|undefined{return typeof value==='string'?value.trim().slice(0,max):undefined;}
