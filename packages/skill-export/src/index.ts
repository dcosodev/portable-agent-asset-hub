// packages/skill-export/src/index.ts
//
// Public entry point for the FASE 5 skill exporter. The exporter is
// metadata-only during preview and never carries body / resource
// bytes outside of the apply step. Apply writes through a staging
// directory on the same filesystem as the requested target and
// promotes the result via an atomic rename so a failed apply can
// always be replayed.

export * from './types.js';
export * from './digest.js';
export * from './validator.js';
export { SkillExportCoordinator, type SkillExportCoordinatorOptions } from './exporter.js';
