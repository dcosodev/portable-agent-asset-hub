import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const exec=promisify(execFile); const root=resolve(new URL('..',import.meta.url).pathname); const temp=await mkdtemp(join(tmpdir(),'s4-fresh-materialization-')); const target=join(temp,'profile.md');
const child=join(temp,'child.mjs');
await writeFile(child,`import { FileMaterializer } from ${JSON.stringify(join(root,'packages/storage-files/dist/index.js'))};\nimport { materializeProfile } from ${JSON.stringify(join(root,'packages/core/dist/index.js'))};\nconst m=new FileMaterializer(${JSON.stringify(temp)}); const p={id:'prf_fresh',scope:{ownerUserId:'usr_fresh',agentId:'agt_fresh'},version:1,blocks:[{blockId:'b',ordinal:2,kind:'MEMORY',body:'two'},{blockId:'a',ordinal:1,kind:'USER',body:'one'}]}; const x=materializeProfile(p); m.materialize('profile.md',x); console.log(JSON.stringify({digest:x.digest,bytes:x.bytes.toString('base64')}));`);
try { const outputs=[]; for(let i=0;i<2;i++){const r=await exec(process.execPath,[child],{cwd:temp});outputs.push(JSON.parse(r.stdout.trim()));} if(outputs[0].digest!==outputs[1].digest||outputs[0].bytes!==outputs[1].bytes) throw new Error('NON_DETERMINISTIC_MATERIALIZATION'); const bytes=await readFile(target); if(createHash('sha256').update(bytes).digest('hex')!==outputs[0].digest) throw new Error('TARGET_DIGEST_MISMATCH'); console.log(JSON.stringify({ok:true,processes:2,digest:outputs[0].digest,bytes:bytes.length})); } finally { await rm(temp,{recursive:true,force:true}); }
