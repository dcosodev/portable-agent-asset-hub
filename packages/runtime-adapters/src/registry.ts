// packages/runtime-adapters/src/registry.ts
//
// The harness → renderer dispatcher. Adding a new harness means
// extending `HarnessId` and registering the renderer here; no other
// file has to change.

import type { HarnessId, PreviewInput, Renderer } from './contracts.js';
import { codexRenderer } from './codex/index.js';
import { claudeCodeRenderer } from './claude-code/index.js';
import { opencodeRenderer } from './opencode/index.js';
import { hermesRenderer } from './hermes/index.js';
import { openclawRenderer } from './openclaw/index.js';

export const RENDERERS: Readonly<Record<HarnessId, Renderer>> = Object.freeze({
  codex: codexRenderer,
  'claude-code': claudeCodeRenderer,
  opencode: opencodeRenderer,
  hermes: hermesRenderer,
  openclaw: openclawRenderer,
});

export function getRenderer(harness: HarnessId): Renderer {
  const renderer = RENDERERS[harness];
  if (!renderer) throw new Error(`unknown harness: ${harness}`);
  return renderer;
}

export function listRenderers(): readonly HarnessId[] {
  return Object.keys(RENDERERS) as HarnessId[];
}

export type { PreviewInput };
