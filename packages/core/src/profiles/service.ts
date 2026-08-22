import { randomUUID } from 'node:crypto';
import { HubError } from '../errors.js';
import { materializeProfile } from '../materializations/markdown.js';
import type { ActorContext } from '../runtime/actor-context.js';
import type { MutationMeta, Storage } from '../storage/contracts.js';
import type { ImportPreview, Profile, ProfileBlock, ProfileScope } from './types.js';

function checkScope(actor: ActorContext, scope: ProfileScope): void {
  if (!scope.ownerUserId || !scope.agentId) {
    throw new HubError('VALIDATION', 'profile scope requires user and agent', 400);
  }
  if (scope.ownerUserId !== actor.userId || scope.agentId !== actor.agentId) {
    throw new HubError('NOT_FOUND', 'not found', 404);
  }
}

function checkMeta(input: MutationMeta): MutationMeta {
  if (!input.reason || !input.requestId) throw new HubError('VALIDATION', 'reason and requestId required', 400);
  return input;
}

function parseMarkdown(text: string): ProfileBlock[] {
  if (text.includes('\r') || text.charCodeAt(0) === 0xfeff || !text.endsWith('\n')) {
    throw new HubError('VALIDATION', 'markdown must use canonical UTF-8 LF form', 400);
  }
  if (text === '---\n') return [];
  const marker = /<!-- (USER|MEMORY) ([A-Za-z0-9][A-Za-z0-9._-]*) ordinal=(\d+) -->\n/gu;
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0 || matches[0].index !== 0) throw new HubError('VALIDATION', 'malformed block', 400);
  const blocks = matches.map((match, index): ProfileBlock => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const bodyWithNewline = text.slice(start, end);
    if (!bodyWithNewline.endsWith('\n')) throw new HubError('VALIDATION', 'malformed block body', 400);
    return {
      kind: match[1] as ProfileBlock['kind'],
      blockId: match[2],
      ordinal: Number(match[3]),
      body: bodyWithNewline.slice(0, -1),
    };
  });
  const canonical = materializeProfile({
    id: 'prf_parse',
    scope: { ownerUserId: 'usr_parse', agentId: 'agt_parse' },
    version: 1,
    blocks,
  }).bytes.toString('utf8');
  if (canonical !== text) throw new HubError('VALIDATION', 'markdown is not canonical', 400);
  return blocks;
}

export class ProfileService {
  public constructor(private readonly storage: Storage, private readonly actor: ActorContext) {}

  public create(profile: Profile, mutation: MutationMeta): Profile {
    checkScope(this.actor, profile.scope);
    return this.storage.transaction(this.actor, (tx) => tx.profiles.create(profile, checkMeta(mutation)));
  }

  public get(id: string, requestedScope?: ProfileScope): Profile {
    if (requestedScope) checkScope(this.actor, requestedScope);
    return this.storage.transaction(this.actor, (tx) => tx.profiles.get(id, this.actor.scope));
  }

  public update(id: string, input: { version: number; blocks: ProfileBlock[] }, mutation: MutationMeta): Profile {
    return this.storage.transaction(this.actor, (tx) =>
      tx.profiles.update(id, this.actor.scope, input.version, input.blocks, checkMeta(mutation)));
  }

  public history(id: string): Profile[] {
    return this.storage.transaction(this.actor, (tx) => tx.profiles.history(id, this.actor.scope));
  }

  public previewImport(
    id: string,
    markdown: string,
    observedTargetDigest: string,
    mutation: MutationMeta,
  ): ImportPreview {
    if (!/^[0-9a-f]{64}$/u.test(observedTargetDigest)) throw new HubError('VALIDATION', 'target digest required', 400);
    return this.storage.transaction(this.actor, (tx) => {
      const current = tx.profiles.get(id, this.actor.scope);
      const blocks = parseMarkdown(markdown);
      const proposed = materializeProfile({ ...current, blocks });
      return tx.profiles.createPreview({
        id: `imp_${randomUUID()}`,
        profileId: id,
        scope: this.actor.scope,
        expectedVersion: current.version,
        digest: proposed.digest,
        targetDigest: observedTargetDigest,
        expiresAt: Date.now() + 300_000,
        used: false,
        blocks,
      }, checkMeta(mutation));
    });
  }

  public applyImport(
    previewId: string,
    exactDigest: string,
    observedTargetDigest: string,
    mutation: MutationMeta,
  ): Profile {
    return this.storage.transaction(this.actor, (tx) =>
      tx.profiles.applyPreview(
        previewId,
        this.actor.scope,
        exactDigest,
        observedTargetDigest,
        checkMeta(mutation),
      ));
  }

  public restore(
    profileId: string,
    snapshotVersion: number,
    expectedVersion: number,
    mutation: MutationMeta,
  ): Profile {
    return this.storage.transaction(this.actor, (tx) =>
      tx.profiles.restore(
        profileId,
        this.actor.scope,
        snapshotVersion,
        expectedVersion,
        checkMeta(mutation),
      ));
  }
}
