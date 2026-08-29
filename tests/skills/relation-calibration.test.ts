import { describe, expect, it } from 'vitest';
import { isAutoApproveUnlocked } from '@portable-agent-asset-hub/core';

describe('isAutoApproveUnlocked', () => {
  it('permanece cerrado con muestra insuficiente', () => {
    expect(isAutoApproveUnlocked({ total: 9, clean: 9 }, { minSample: 10, minPrecision: 0.9 })).toBe(false);
  });

  it('permanece cerrado por debajo de precision minima', () => {
    expect(isAutoApproveUnlocked({ total: 20, clean: 17 }, { minSample: 10, minPrecision: 0.9 })).toBe(false);
  });

  it('se desbloquea cuando la muestra y precision cumplen la politica', () => {
    expect(isAutoApproveUnlocked({ total: 20, clean: 18 }, { minSample: 10, minPrecision: 0.9 })).toBe(true);
  });
});
