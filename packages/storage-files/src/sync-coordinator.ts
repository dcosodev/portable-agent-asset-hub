import { canonicalDigest, candidatesFrom, HubError, SyncService, type ActorContext, type CatalogScanner, type MutationMeta, type Storage, type SyncPreview, type RootDescriptor } from '@portable-agent-asset-hub/core';
import type { FileSyncMarker } from './sync-marker.js';

export type CatalogPreviewRequest = {
  profileId: string;
  roots: RootDescriptor[];
  selectors?: string[];
  expiresAt?: number;
};

export type CatalogSyncCoordinatorOptions = {
  storage: Storage;
  actor: ActorContext;
  scanner: CatalogScanner;
  marker: FileSyncMarker;
  afterMarker?: () => void;
};

/** Server-bound façade. Scope, profile and all drift fingerprints come from the actor/storage. */
export class CatalogSyncCoordinator {
  private readonly storage: Storage;
  private readonly actor: ActorContext;
  private readonly scanner: CatalogScanner;
  private readonly marker: FileSyncMarker;
  private readonly afterMarker?: () => void;

  public constructor(options: CatalogSyncCoordinatorOptions);
  public constructor(storage: Storage, actor: ActorContext, scanner: CatalogScanner, marker: FileSyncMarker);
  public constructor(
    optionsOrStorage: CatalogSyncCoordinatorOptions | Storage,
    actor?: ActorContext,
    scanner?: CatalogScanner,
    marker?: FileSyncMarker,
  ) {
    if ('storage' in optionsOrStorage) {
      this.storage = optionsOrStorage.storage;
      this.actor = optionsOrStorage.actor;
      this.scanner = optionsOrStorage.scanner;
      this.marker = optionsOrStorage.marker;
      this.afterMarker = optionsOrStorage.afterMarker;
    } else {
      if (!actor || !scanner || !marker) throw new HubError('VALIDATION', 'coordinator dependencies required', 400);
      this.storage = optionsOrStorage;
      this.actor = actor;
      this.scanner = scanner;
      this.marker = marker;
    }
  }

  private scan(roots: RootDescriptor[], selectors: string[] = []) {
    const result = this.scanner.scan({ roots, selectors });
    if (result instanceof Promise) throw new HubError('INTERNAL', 'async scanner is not supported by synchronous storage', 500);
    return result;
  }

  private profileFingerprint(profile: unknown): string { return canonicalDigest(profile); }
  private targetFingerprint(): string { return this.marker.fingerprint(); }

  public preview(request: CatalogPreviewRequest, meta: MutationMeta): SyncPreview {
    if (!request.profileId || !request.roots?.length || request.roots.some((root) => !root || typeof root !== 'object')) throw new HubError('VALIDATION', 'profileId and explicit root descriptors required', 400);
    const candidates = this.scan(request.roots, request.selectors);
    return this.storage.transaction(this.actor, (tx) => {
      const profile = tx.profiles.get(request.profileId, this.actor.scope);
      const service = new SyncService(candidatesFrom(candidates), {
        catalog: tx.catalog,
        sync: tx.catalogSync,
        profileFingerprint: () => this.profileFingerprint(profile),
        targetFingerprint: () => this.targetFingerprint(),
        afterMarker: this.afterMarker,
      });
      return service.previewSync({
        roots: request.roots,
        selectors: request.selectors,
        scope: this.actor.scope,
        profile: profile.id,
        expiresAt: request.expiresAt,
      }, meta);
    });
  }

  public review(previewId: string, digest: string, meta: MutationMeta): void {
    this.storage.transaction(this.actor, (tx) => tx.catalogSync.review(previewId, digest, this.actor.scope, meta));
  }

  public apply(previewId: string, digest: string, meta: MutationMeta): void {
    const preview = this.storage.transaction(this.actor, (tx) => tx.catalogSync.getPreview(previewId, this.actor.scope));
    if (preview.appliedAt) {
      if (digest !== preview.digest) throw new HubError('CONFLICT', 'replay digest mismatch', 409);
      return;
    }
    const candidates = this.scan(preview.roots, preview.selectors);
    const prior = this.marker.snapshot();
    try {
      this.storage.transaction(this.actor, (tx) => {
        const profile = tx.profiles.get(preview.profile, this.actor.scope);
        const service = new SyncService(candidatesFrom(candidates), {
          catalog: tx.catalog,
          sync: tx.catalogSync,
          profileFingerprint: () => this.profileFingerprint(profile),
          targetFingerprint: () => this.targetFingerprint(),
          afterMarker: this.afterMarker,
        }, this.marker);
        service.apply({ previewId, reviewedDigest: digest, scope: this.actor.scope, meta });
      });
    } catch (error) {
      // This is intentionally outside storage.transaction: COMMIT failures are covered too.
      try { this.marker.restore(prior); } catch { /* preserve the original DB/commit error */ }
      throw error;
    }
  }
}
