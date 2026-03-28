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

  it('keeps telemetry from only the last 3 completed levels', () => {
    const storage = createStorageMock();
    const store = new EnemyDatasetStore({ storage });

    for (let telemetryLevelId = 1; telemetryLevelId <= 4; telemetryLevelId += 1) {
      store.appendTrainingRecords([{
        enemyType: 'skirm',
        examples: [{
          vector: [telemetryLevelId],
          labels: {
            win: 1,
            survival: 1,
            pressure: 0.5,
            collision: 0,
            bullet: 0,
          },
        }],
        summary: {},
      }], {
        outcome: 'player_win',
        levelNumber: telemetryLevelId,
        telemetryLevelId,
      });
    }

    const state = store.load();
    const keptIds = [...new Set(state.enemyExamples.skirm.map(example => example.meta.telemetryLevelId))];

    assert.deepEqual(keptIds, [2, 3, 4]);
    assert.deepEqual(
      state.enemyExamples.skirm.map(example => example.vector[0]),
      [2, 3, 4]
    );
    assert.equal(
      ENEMY_LEARNING_CONFIG.recentTelemetryLevels,
      3,
      'test assumes a 3-level telemetry window'
    );
  });
});
