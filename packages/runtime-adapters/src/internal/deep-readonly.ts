// packages/runtime-adapters/src/internal/deep-readonly.ts
//
// Minimal deep-readonly helper. Kept local because the codebase uses
// `readonly` annotations on `PlanFile[]` already and a dependency on
// a third-party library would be overkill for one utility.

export type ReadonlyDeep<T> =
  T extends (infer U)[] ? ReadonlyArray<ReadonlyDeep<U>> :
  T extends ReadonlyArray<infer U> ? ReadonlyArray<ReadonlyDeep<U>> :
  T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;
