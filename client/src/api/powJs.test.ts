import { describe, expect, it } from 'vitest';
import { JsPowSolver } from './powJs';

describe('JavaScript PoW fallback', () => {
  it('matches the nonce produced by the server algorithm at the minimum difficulty', () => {
    const solver = new JsPowSolver(new Uint8Array(32), 16);
    expect(solver.solveChunk(37_032)).toBe('37031');
  });

  it('continues searching across bounded chunks', () => {
    const solver = new JsPowSolver(new Uint8Array(32), 16);
    expect(solver.solveChunk(20_000)).toBeNull();
    expect(solver.solveChunk(20_000)).toBe('37031');
  });
});
