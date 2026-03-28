import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  EnemyDatasetStore,
} = await import('../../../systems/ml/EnemyDatasetStore.js');
const {
  ENEMY_LEARNING_CONFIG,
} = await import('../../../config/enemyLearning.config.js');

function createStorageMock() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

describe('EnemyDatasetStore', () => {
  it('keeps only the most recent enemy examples per type', () => {
    const storage = createStorageMock();
    const store = new EnemyDatasetStore({ storage });
    const limit = ENEMY_LEARNING_CONFIG.maxExamplesPerEnemyType;
    const records = [{
      enemyType: 'skirm',
      examples: Array.from({ length: limit + 5 }, (_, index) => ({
        vector: [index],
        labels: {
          win: index % 2,
          survival: 1,
          pressure: 0,
          collision: 0,
          bullet: 0,
        },
      })),
      summary: {},
    }];

    const state = store.appendTrainingRecords(records, {
      outcome: 'player_win',
      levelNumber: 1,
    });

    assert.equal(state.enemyExamples.skirm.length, limit);
    assert.equal(state.enemyExamples.skirm[0].vector[0], 5);
    assert.equal(state.enemyExamples.skirm.at(-1).vector[0], limit + 4);
  });
});
