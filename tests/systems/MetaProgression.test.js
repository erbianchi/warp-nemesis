import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  MetaProgression,
  META_PROGRESSION_STORAGE_KEY,
  LEGACY_TOTAL_SCORE_STORAGE_KEY,
} = await import('../../systems/MetaProgression.js');

const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
const originalLocalStorage = globalThis.localStorage;

function createLocalStorageMock(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

describe('MetaProgression', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: createLocalStorageMock(),
    });
    MetaProgression.totalScore = 0;
    MetaProgression.ownedBonuses = { hp: 0, shield: 0 };
  });

  afterEach(() => {
    if (hadLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: originalLocalStorage,
      });
      return;
    }

    delete globalThis.localStorage;
  });

  it('loads an empty default state when nothing has been stored yet', () => {
    assert.deepEqual(MetaProgression.load(), {
      totalScore: 0,
      ownedBonuses: { hp: 0, shield: 0 },
    });
  });

  it('migrates the legacy total-score-only storage into the new meta state', () => {
    globalThis.localStorage.setItem(LEGACY_TOTAL_SCORE_STORAGE_KEY, '1250');

    const state = MetaProgression.load();

    assert.equal(state.totalScore, 1250);
    assert.deepEqual(state.ownedBonuses, { hp: 0, shield: 0 });
    assert.deepEqual(
      JSON.parse(globalThis.localStorage.getItem(META_PROGRESSION_STORAGE_KEY)),
      {
        totalScore: 1250,
        ownedBonuses: { hp: 0, shield: 0 },
      }
    );
  });

  it('migrates the old pending-bonus state into permanent owned bonuses', () => {
    globalThis.localStorage.setItem(META_PROGRESSION_STORAGE_KEY, JSON.stringify({
      totalScore: 50000,
      pendingBonuses: { hp: 50, shield: 100 },
    }));

    const state = MetaProgression.load();

    assert.deepEqual(state, {
      totalScore: 50000,
      ownedBonuses: { hp: 50, shield: 100 },
    });
  });

  it('recordCompletedLevel adds the level score into the persistent total', () => {
    globalThis.localStorage.setItem(META_PROGRESSION_STORAGE_KEY, JSON.stringify({
      totalScore: 900,
      ownedBonuses: { hp: 0, shield: 0 },
    }));

    const state = MetaProgression.recordCompletedLevel(175);

    assert.equal(state.totalScore, 1075);
    assert.deepEqual(state.ownedBonuses, { hp: 0, shield: 0 });
  });

  it('purchase spends total score and grants a permanent hp bonus', () => {
    globalThis.localStorage.setItem(META_PROGRESSION_STORAGE_KEY, JSON.stringify({
      totalScore: 60000,
      ownedBonuses: { hp: 0, shield: 0 },
    }));

    const result = MetaProgression.purchase('hp50');

    assert.equal(result.ok, true);
    assert.equal(result.totalScore, 10000);
    assert.deepEqual(result.ownedBonuses, { hp: 50, shield: 0 });
  });

  it('purchase rejects an unaffordable item without mutating the wallet or queued bonuses', () => {
    globalThis.localStorage.setItem(META_PROGRESSION_STORAGE_KEY, JSON.stringify({
      totalScore: 49000,
      ownedBonuses: { hp: 0, shield: 50 },
    }));

    const result = MetaProgression.purchase('hp50');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insufficient_score');
    assert.equal(result.totalScore, 49000);
    assert.deepEqual(result.ownedBonuses, { hp: 0, shield: 50 });
  });

  it('getStartingBonuses returns the permanent bonuses without consuming them', () => {
    globalThis.localStorage.setItem(META_PROGRESSION_STORAGE_KEY, JSON.stringify({
      totalScore: 80000,
      ownedBonuses: { hp: 50, shield: 50 },
    }));

    const bonuses = MetaProgression.getStartingBonuses();

    assert.deepEqual(bonuses, { hp: 50, shield: 50 });
    assert.deepEqual(MetaProgression.getSnapshot(), {
      totalScore: 80000,
      ownedBonuses: { hp: 50, shield: 50 },
    });
  });
});
