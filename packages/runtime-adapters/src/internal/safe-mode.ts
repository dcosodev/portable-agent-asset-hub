// packages/runtime-adapters/src/internal/safe-mode.ts
//
// The apply pipeline refuses to set any file mode that has setuid,
// setgid, or sticky bits. The constant surface is exposed via a
// single helper so callers do not have to re-derive the mask from
// first principles.

export const SAFE_DEFAULT_MODE = 0o644;
export const SAFE_EXECUTABLE_MODE = 0o755;

const UNSAFE_MODE_MASK = 0o7000; // setuid + setgid + sticky

export function assertSafeMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new RangeError(`invalid file mode: 0o${mode.toString(8)}`);
  }
  if ((mode & UNSAFE_MODE_MASK) !== 0) {
    throw new RangeError(`refusing to apply unsafe file mode: 0o${mode.toString(8)}`);
  }
  return mode;
}
