// tests/mcp/identity.test.ts
//
// Normative tests for the MCP process-bound identity. S7 plan mandates:
//
//   mcp_identity_is_process_bound
//   mcp_rejects_model_identity_override
//
// The identity is derived from the host process (PID + argv hash) at server
// boot and is exposed through the tool's identity descriptor. The model
// layer (LLM/agent) MUST NOT be allowed to substitute its own identity
// through tool call arguments or capability headers — any payload that
// attempts to do so is rejected and surfaced as a structured error.

import { describe, expect, it } from 'vitest';
import {
  computeProcessIdentity,
  createMcpIdentity,
  isModelIdentityOverride,
  type ProcessIdentity,
} from '@portable-agent-asset-hub/mcp';

describe('MCP process-bound identity (S7)', () => {
  it('mcp_identity_is_process_bound', () => {
    const id = computeProcessIdentity(process.pid, process.argv);
    expect(id.pid).toBe(process.pid);
    expect(typeof id.argvDigest).toBe('string');
    expect(id.argvDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof id.bootId).toBe('string');
    expect(id.bootId.length).toBeGreaterThan(0);
  });

  it('same_process_arguments_produce_stable_identity', () => {
    const a = computeProcessIdentity(42, ['node', 'mcp.js', '--token=abc']);
    const b = computeProcessIdentity(42, ['node', 'mcp.js', '--token=abc']);
    expect(a).toEqual(b);
  });

  it('different_process_arguments_produce_different_identity', () => {
    const a = computeProcessIdentity(42, ['node', 'mcp.js', '--token=abc']);
    const b = computeProcessIdentity(42, ['node', 'mcp.js', '--token=def']);
    expect(a.argvDigest).not.toBe(b.argvDigest);
  });

  it('different_pids_produce_different_boot_id', () => {
    const a = computeProcessIdentity(1, ['node']);
    const b = computeProcessIdentity(2, ['node']);
    expect(a.bootId).not.toBe(b.bootId);
  });

  it('mcp_rejects_model_identity_override_via_capability_header', () => {
    expect(isModelIdentityOverride({ 'x-mcp-actor': 'usr_attacker' })).toBe(true);
    expect(isModelIdentityOverride({ 'x-mcp-user-id': 'usr_attacker' })).toBe(true);
    expect(isModelIdentityOverride({ 'x-mcp-agent-id': 'agt_attacker' })).toBe(true);
    expect(isModelIdentityOverride({ 'x-request-id': 'req_real' })).toBe(false);
    expect(isModelIdentityOverride({})).toBe(false);
    expect(isModelIdentityOverride({ authorization: 'Bearer abc' })).toBe(false);
  });

  it('identity_descriptor_carries_process_metadata_only', () => {
    const id = computeProcessIdentity(7, ['node', 'mcp.js']);
    const descriptor = createMcpIdentity(id);
    expect(descriptor.kind).toBe('mcp-process');
    expect(descriptor.pid).toBe(7);
    expect(descriptor.argvDigest).toBe(id.argvDigest);
    expect(descriptor.bootId).toBe(id.bootId);
    // The descriptor must never carry fields the model can influence
    expect((descriptor as unknown as { userId?: string }).userId).toBeUndefined();
    expect((descriptor as unknown as { agentId?: string }).agentId).toBeUndefined();
  });

  it('identity_is_immutable_after_construction', () => {
    const id: ProcessIdentity = computeProcessIdentity(9, ['node']);
    expect(Object.isFrozen(id)).toBe(true);
  });
});
