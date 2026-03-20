import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { RunState } = await import('../../systems/RunState.js');

describe('RunState', () => {
  beforeEach(() => RunState.reset());

  // --- initial state after reset ---

  it('score starts at 0 after reset', () => {
    assert.equal(RunState.score, 0);
  });

  it('lives starts at 3 after reset', () => {
    assert.equal(RunState.lives, 3);
  });

  it('level starts at 1 after reset', () => {
    assert.equal(RunState.level, 1);
  });

  it('kills starts at 0 after reset', () => {
    assert.equal(RunState.kills, 0);
  });

  // --- addScore ---

  it('addScore increases score by the given amount', () => {
    RunState.addScore(10);
    assert.equal(RunState.score, 10);
  });

  it('addScore accumulates across multiple calls', () => {
    RunState.addScore(10);
    RunState.addScore(10);
    RunState.addScore(10);
    assert.equal(RunState.score, 30);
  });

  it('addScore with 0 leaves score unchanged', () => {
    RunState.addScore(0);
    assert.equal(RunState.score, 0);
  });

  // --- reset ---

  it('reset clears score set after construction', () => {
    RunState.addScore(500);
    RunState.reset();
    assert.equal(RunState.score, 0);
  });

  it('reset clears all fields', () => {
    RunState.score = 99;
    RunState.lives = 1;
    RunState.level = 7;
    RunState.kills = 42;
    RunState.reset();
    assert.equal(RunState.score, 0);
    assert.equal(RunState.lives, 3);
    assert.equal(RunState.level, 1);
    assert.equal(RunState.kills, 0);
  });

  // --- singleton identity ---

  it('is a singleton — same object across imports', async () => {
    const { RunState: RS2 } = await import('../../systems/RunState.js');
    assert.strictEqual(RunState, RS2);
  });
});
