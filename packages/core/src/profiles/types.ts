export type ProfileScope = { ownerUserId: string; agentId: string };
export type ProfileBlock = { blockId: string; ordinal: number; kind: 'USER' | 'MEMORY'; body: string };
export type Profile = { id: string; scope: ProfileScope; version: number; blocks: ProfileBlock[] };
export type ImportPreview = { id: string; profileId: string; scope: ProfileScope; expectedVersion: number; digest: string; targetDigest: string; expiresAt: number; used: boolean; blocks: ProfileBlock[] };
