import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { probeWebGL } from './useWebGLProbe';

describe('probeWebGL debug', () => {
  let orig: typeof HTMLCanvasElement.prototype.getContext;
  beforeEach(() => {
    orig = HTMLCanvasElement.prototype.getContext;
  });
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = orig;
  });

  it('returns false by default in jsdom', () => {
    expect(probeWebGL()).toBe(false);
  });

  it('returns true when getContext webgl2 returns object', () => {
    HTMLCanvasElement.prototype.getContext = vi.fn((type: string) => (type === 'webgl2' ? {} : null)) as unknown as typeof orig;
    expect(probeWebGL()).toBe(true);
  });
});