import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  SquadDatasetStore,
} = await import('../../../systems/ml/SquadDatasetStore.js');
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

describe('SquadDatasetStore', () => {
  it('keeps telemetry from only the last 3 completed levels', () => {
    const storage = createStorageMock();
    const store = new SquadDatasetStore({ storage });

    for (let telemetryLevelId = 1; telemetryLevelId <= 4; telemetryLevelId += 1) {
      store.appendTrainingRecords([{
        squadId: `squad-${telemetryLevelId}`,
        squadTemplateId: 'template',
        formation: 'straight',
        dance: 'straight',
        overlay: false,
        examples: [{
          vector: [telemetryLevelId],
          labels: {
            win: 1,
            pressure: 0.5,
            collision: 0,
          },
        }],
      }], {
        outcome: 'player_win',
        levelNumber: telemetryLevelId,
        telemetryLevelId,
      });
    }

    const state = store.load();
    const keptIds = [...new Set(state.examples.map(example => example.meta.telemetryLevelId))];

    assert.deepEqual(keptIds, [2, 3, 4]);
    assert.deepEqual(
      state.examples.map(example => example.vector[0]),
      [2, 3, 4]
    );
    assert.equal(
      ENEMY_LEARNING_CONFIG.recentTelemetryLevels,
      3,
      'test assumes a 3-level telemetry window'
    );
  });
});
