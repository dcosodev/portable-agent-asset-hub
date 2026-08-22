import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
const schema = (n: string) => JSON.parse(readFileSync(`schemas/${n}.json`, 'utf8')) as object;
describe('S4 AJV2020 schemas', () => {
  it('compiles and accepts valid fixtures', () => { const ajv = new Ajv2020({ strict: true }); const p=ajv.compile(schema('profile.v1')); const m=ajv.compile(schema('memory-block.v1')); const i=ajv.compile(schema('profile-import.v1')); expect(p({id:'prf_x',scope:{ownerUserId:'usr_x',agentId:'agt_x'},version:1,blocks:[]})).toBe(true); expect(m({blockId:'x',ordinal:0,kind:'MEMORY',body:'x'})).toBe(true); expect(i({id:'imp_x',profileId:'prf_x',scope:{ownerUserId:'usr_x',agentId:'agt_x'},expectedVersion:1,digest:'a'.repeat(64),targetDigest:'b'.repeat(64),expiresAt:1,used:false,blocks:[]})).toBe(true); });
  it('rejects invalid fixtures', () => { const ajv = new Ajv2020({ strict: true }); const p=ajv.compile(schema('profile.v1')); expect(p({id:'bad',scope:{ownerUserId:'usr_x',agentId:'agt_x'},version:1,blocks:[]})).toBe(false); expect(p({id:'prf_x',scope:{ownerUserId:'usr_x'},version:1,blocks:[]})).toBe(false); });
});
