import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  EnemyAdaptivePolicy,
} = await import('../../../systems/ml/EnemyAdaptivePolicy.js');
const {
  ENEMY_LEARNING_STORAGE_KEY,
  ENEMY_LEARNING_STAGED_STORAGE_KEY,
} = await import('../../../systems/ml/EnemyLearningStore.js');
const {
  ENEMY_DATASET_STORAGE_KEY,
} = await import('../../../systems/ml/EnemyDatasetStore.js');
const {
  SQUAD_DATASET_STORAGE_KEY,
} = await import('../../../systems/ml/SquadDatasetStore.js');
const {
  SQUAD_LEARNING_STORAGE_KEY,
} = await import('../../../systems/ml/SquadLearningStore.js');
const {
  EnemyFeatureEncoder,
} = await import('../../../systems/ml/EnemyFeatureEncoder.js');
const {
  SquadFeatureEncoder,
} = await import('../../../systems/ml/SquadFeatureEncoder.js');
const {
  LogisticRegressor,
} = await import('../../../systems/ml/LogisticRegressor.js');

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
  };
}

function createSessionRecord(vector, enemyCount = 2, levelNumber = 1) {
  return {
    _levelNumber: levelNumber,
    buildTrainingRecords() {
      return [{
        enemyType: 'skirm',
        enemyCount,
        examples: [
          { vector, labels: { win: 0.7, survival: 1, pressure: 1, collision: 0, bullet: 0 } },
          { vector, labels: { win: 0.25, survival: 0, pressure: 0, collision: 1, bullet: 1 } },
        ],
        summary: { spawnCount: enemyCount },
      }];
    },
    buildSquadTrainingRecords() {
      return [];
    },
    buildPlayerStyleProfile() {
      return {
        sampleCount: 12,
        laneBiasX: -0.35,
        aggression: 0.42,
        dodgeIntensity: 0.38,
        reversalRate: 0.26,
        heatGreed: 0.54,
        overheatRate: 0.12,
        shieldReliance: 0.48,
        hpRatio: 0.74,
        shieldRatio: 0.36,
        pressureExposure: 0.44,
        enemyDensity: 0.52,
        nearestEnemyDistanceNorm: 0.42,
        preferredWeaponKey: 'laser',
      };
    },
    destroy() {},
  };
}

function createSeparableSessionRecord(levelNumber = 1) {
  return {
    _levelNumber: levelNumber,
    buildTrainingRecords() {
      return [{
        enemyType: 'skirm',
        enemyCount: 6,
        examples: [
          { vector: [1, 1, 0.8], labels: { win: 1, survival: 1, pressure: 1, collision: 0, bullet: 0 } },
          { vector: [1.1, 0.9, 0.75], labels: { win: 1, survival: 0.95, pressure: 1, collision: 0, bullet: 0 } },
          { vector: [0.9, 1.2, 0.7], labels: { win: 0.95, survival: 1, pressure: 0.9, collision: 0, bullet: 0 } },
          { vector: [-1, -1, -0.8], labels: { win: 0, survival: 0.1, pressure: 0, collision: 1, bullet: 1 } },
          { vector: [-1.1, -0.9, -0.75], labels: { win: 0.05, survival: 0.15, pressure: 0, collision: 1, bullet: 1 } },
          { vector: [-0.9, -1.2, -0.7], labels: { win: 0, survival: 0.05, pressure: 0.1, collision: 0.95, bullet: 1 } },
        ],
        summary: { spawnCount: 6 },
      }];
    },
    buildSquadTrainingRecords() {
      return [];
    },
    destroy() {},
  };
}

describe('EnemyAdaptivePolicy', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: createLocalStorageMock(),
    });
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

  it('persists trained model bundles and full datasets between runs', () => {
    const policy = new EnemyAdaptivePolicy();
    policy.load();

    const baseline = policy.getModifiers('skirm');
    policy.trainFromSession(createSessionRecord([0.4, 0.2, 0.1]), 'player_win');
    const afterPlayerWin = policy.getModifiers('skirm');
    policy.trainFromSession(createSessionRecord([0.2, 0.6, 0.7]), 'enemy_win');
    const afterEnemyWin = policy.getModifiers('skirm');

    assert.ok(afterPlayerWin.sampleCount > baseline.sampleCount);
    assert.equal(afterEnemyWin.sampleCount, 4);
    const rawState = JSON.parse(globalThis.localStorage.getItem(ENEMY_LEARNING_STORAGE_KEY));
    const rawDataset = JSON.parse(globalThis.localStorage.getItem(ENEMY_DATASET_STORAGE_KEY));
    assert.ok(rawState);
    assert.ok(rawDataset);
    assert.ok(Array.isArray(rawState.enemyModels.skirm.winModel.weights));
    assert.ok(Array.isArray(rawState.enemyModels.skirm.survivalModel.weights));
    assert.ok(Array.isArray(rawState.enemyModels.skirm.pressureModel.weights));
    assert.ok(Array.isArray(rawState.enemyModels.skirm.collisionModel.weights));
    assert.ok(Array.isArray(rawState.enemyModels.skirm.bulletModel.weights));
    assert.equal(rawDataset.enemyExamples.skirm.length, 4);

    const reloaded = new EnemyAdaptivePolicy();
    reloaded.load();
    const reloadedModifiers = reloaded.getModifiers('skirm');
    assert.equal(reloadedModifiers.sampleCount, afterEnemyWin.sampleCount);
    assert.equal(reloadedModifiers.minSpeedScalar, afterEnemyWin.minSpeedScalar);
    assert.equal(reloadedModifiers.maxSpeedScalar, afterEnemyWin.maxSpeedScalar);
  });

  it('trains stored logistic models that actually separate positive and negative telemetry', () => {
    const policy = new EnemyAdaptivePolicy();
    policy.load();
    policy.trainFromSession(createSeparableSessionRecord(), 'player_win');

    const rawState = JSON.parse(globalThis.localStorage.getItem(ENEMY_LEARNING_STORAGE_KEY));
    const winRegressor = new LogisticRegressor(rawState.enemyModels.skirm.winModel);
    const collisionRegressor = new LogisticRegressor(rawState.enemyModels.skirm.collisionModel);

    const positiveVector = [1, 1, 0.8];
    const negativeVector = [-1, -1, -0.8];

    assert.ok(
      winRegressor.predictProbability(positiveVector) > winRegressor.predictProbability(negativeVector),
      'win model should prefer the positive telemetry cluster'
    );
    assert.ok(
      collisionRegressor.predictProbability(negativeVector) > collisionRegressor.predictProbability(positiveVector),
      'collision model should prefer the negative telemetry cluster'
    );
  });

  it('uses Level 1 squad data to bootstrap the level 2 squad network', () => {
    const squadEncoder = new SquadFeatureEncoder();
    const squadSample = squadEncoder.encodeSample(squadEncoder.buildSample({
      player: {
        x: 170,
        y: 510,
        hasShield: true,
        shieldRatio: 0.8,
        hpRatio: 0.9,
      },
      weapon: {
        primaryWeaponKey: 'laser',
        heatRatio: 0.2,
        isOverheated: false,
        primaryDamageMultiplier: 1.5,
      },
      squad: {
        centroidX: 180,
        centroidY: 110,
        width: 80,
        aliveRatio: 0.75,
      },
      closestEnemyDistance: 120,
      formation: 'vee',
      dance: 'straight',
      primaryEnemyType: 'skirm',
      stats: {
        spawnCount: 4,
        shotCount: 2,
        playerHitCount: 1,
        hpDamageToPlayer: 8,
        shieldDamageToPlayer: 10,
        collisionDeathCount: 0,
      },
    }));
    const policy = new EnemyAdaptivePolicy();
    policy.load();

    policy.trainFromSession({
      _levelNumber: 1,
      buildTrainingRecords() {
        return [];
      },
      buildSquadTrainingRecords() {
        return [{
          levelNumber: 1,
          squadId: 'sq-2',
          squadTemplateId: 'interceptor-squad',
          formation: 'vee',
          dance: 'straight',
          overlay: false,
          examples: [
            { vector: squadSample.vector, labels: { pressure: 1, collision: 0 } },
            { vector: squadSample.vector.map(value => value * 0.9), labels: { pressure: 0, collision: 1 } },
          ],
        }];
      },
      destroy() {},
    }, 'enemy_win');

    const rawDataset = JSON.parse(globalThis.localStorage.getItem(SQUAD_DATASET_STORAGE_KEY));
    const rawModel = JSON.parse(globalThis.localStorage.getItem(SQUAD_LEARNING_STORAGE_KEY));

    assert.equal(rawDataset.examples.length, 2);
    assert.equal(rawDataset.examples[0].meta.levelNumber, 1);
    assert.equal(rawModel.squadModels.level2.sampleCount, 2);
    assert.ok(rawModel.squadModels.level2.inputSize > 0);
    assert.ok(rawModel.squadModels.level2.dense1Kernel.length > 0);
  });

  it('derives runtime squad directives from the stored level 2 network', () => {
    const encoder = new SquadFeatureEncoder();
    const inputSize = encoder.getFeatureNames().length;
    const featureIndex = encoder.getFeatureNames().indexOf('playerShieldUp');
    const dense1Kernel = new Array(inputSize).fill(0);
    dense1Kernel[featureIndex] = 1;

    globalThis.localStorage.setItem(SQUAD_LEARNING_STORAGE_KEY, JSON.stringify({
      featureVersion: 6,
      squadModels: {
        level2: {
          inputSize,
          hiddenUnits: 1,
          dense1Kernel,
          dense1Bias: [0],
          dense2Kernel: [0, 0, 8],
          dense2Bias: [0, 0, 0],
          sampleCount: 12,
          lastScores: { win: 0.5, pressure: 0.5, collision: 0.8 },
        },
      },
    }));

    const policy = new EnemyAdaptivePolicy({ squadEncoder: encoder });
    policy.load();

    const directive = policy.evaluateSquadDirective({
      scene: {
        _getEnemyLearningPlayerSnapshot() {
          return { x: 190, y: 500, hasShield: true, shieldRatio: 1, hpRatio: 1 };
        },
        _weapons: {
          getLearningSnapshot() {
            return {
              primaryWeaponKey: 'laser',
              heatRatio: 0.2,
              isOverheated: false,
              primaryDamageMultiplier: 1,
            };
          },
        },
      },
      squadId: 'sq-1',
      formation: 'vee',
      dance: 'straight',
      primaryEnemyType: 'skirm',
      liveEnemies: [
        { enemyType: 'skirm', x: 160, y: 90, active: true, alive: true, _squadId: 'sq-1' },
        { enemyType: 'skirm', x: 220, y: 105, active: true, alive: true, _squadId: 'sq-1' },
      ],
      stats: {
        spawnCount: 2,
        shotCount: 1,
        playerHitCount: 0,
        hpDamageToPlayer: 0,
        shieldDamageToPlayer: 0,
        collisionDeathCount: 0,
      },
    });

    assert.equal(directive.pathPattern, 'single');
    assert.equal(directive.idlePattern, 'alternating_rows');
    assert.ok(directive.spreadMultiplier > 1);
    assert.ok(directive.cadenceModifier < 1);
  });

  it('queues browser retraining in the background and promotes staged weights on the next load', async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = {};
    globalThis.document = {};

    try {
      const policy = new EnemyAdaptivePolicy();
      policy.load();
      policy.trainFromSession(createSessionRecord([0.4, 0.2, 0.1]), 'enemy_win');

      assert.equal(globalThis.localStorage.getItem(ENEMY_LEARNING_STAGED_STORAGE_KEY), null);

      await policy._backgroundTrainingPromise;

      const stagedState = JSON.parse(globalThis.localStorage.getItem(ENEMY_LEARNING_STAGED_STORAGE_KEY));
      assert.equal(stagedState.enemyModels.skirm.sampleCount, 2);

      const reloaded = new EnemyAdaptivePolicy();
      reloaded.load();

      const activeState = JSON.parse(globalThis.localStorage.getItem(ENEMY_LEARNING_STORAGE_KEY));
      assert.equal(activeState.enemyModels.skirm.sampleCount, 2);
      assert.equal(globalThis.localStorage.getItem(ENEMY_LEARNING_STAGED_STORAGE_KEY), null);
    } finally {
      if (previousWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previousDocument;
      }
    }
  });

  it('applies immediate transition retraining for Level 2 and returns the player style profile', () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = {};
    globalThis.document = {};

    try {
      const policy = new EnemyAdaptivePolicy();
      policy.load();

      const result = policy.trainFromSession(
        createSessionRecord([0.4, 0.2, 0.1], 2, 1),
        'player_win',
        { immediate: true, nextLevelNumber: 2 }
      );

      const rawState = JSON.parse(globalThis.localStorage.getItem(ENEMY_LEARNING_STORAGE_KEY));

      assert.equal(result.usedImmediateTraining, true);
      assert.ok(result.playerStyleProfile);
      assert.equal(result.playerStyleProfile.preferredWeaponKey, 'laser');
      assert.equal(result.telemetryLevelId, 1);
      assert.equal(rawState.enemyModels.skirm.sampleCount, 6);
      assert.equal(globalThis.localStorage.getItem(ENEMY_LEARNING_STAGED_STORAGE_KEY), null);
    } finally {
      if (previousWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previousDocument;
      }
    }
  });

  it('retains raw telemetry for only the last 3 completed levels', () => {
    const policy = new EnemyAdaptivePolicy();
    policy.load();

    for (let levelNumber = 1; levelNumber <= 4; levelNumber += 1) {
      policy.trainFromSession(
        createSessionRecord([levelNumber, 0.2, 0.1], 2, levelNumber),
        'player_win'
      );
    }

    const rawDataset = JSON.parse(globalThis.localStorage.getItem(ENEMY_DATASET_STORAGE_KEY));
    const keptTelemetryIds = [...new Set(
      rawDataset.enemyExamples.skirm.map(example => example.meta.telemetryLevelId)
    )];

    assert.deepEqual(keptTelemetryIds, [2, 3, 4]);
    assert.ok(rawDataset.enemyExamples.skirm.every(example => example.meta.levelNumber >= 2));
  });

  it('scores runtime movement candidates with the learned pressure and collision models', () => {
    const encoder = new EnemyFeatureEncoder();
    const featureNames = encoder.getFeatureNames();
    const zeroWeights = Object.fromEntries(featureNames.map(name => [name, 0]));
    zeroWeights.shotAlignment = 4;
    zeroWeights.shieldedLaneRisk = 6;
    zeroWeights.shieldedProximityNorm = 4;

    const weights = featureNames.map(name => zeroWeights[name] ?? 0);
    globalThis.localStorage.setItem(ENEMY_LEARNING_STORAGE_KEY, JSON.stringify({
      featureVersion: 6,
      enemyModels: {
        skirm: {
          winModel: { weights: new Array(featureNames.length).fill(0), bias: 0 },
          survivalModel: { weights: new Array(featureNames.length).fill(0), bias: 0 },
          pressureModel: { weights, bias: 0 },
          collisionModel: { weights, bias: 0 },
          bulletModel: { weights: new Array(featureNames.length).fill(0), bias: 0 },
          sampleCount: 8,
          lastScores: { win: 0.5, survival: 0.5, pressure: 0.5, collision: 0.5, bullet: 0.5 },
        },
      },
    }));

    const policy = new EnemyAdaptivePolicy({ encoder });
    policy.load();

    const enemy = {
      enemyType: 'skirm',
      _nativeSpeed: 80,
      scene: {
        _enemies: [],
        _player: { x: 200, y: 500 },
        _getEnemyLearningPlayerSnapshot() {
          return { x: 200, y: 500, hasShield: true, shieldRatio: 1, hpRatio: 1 };
        },
        _weapons: {
          getLearningSnapshot() {
            return {
              primaryWeaponKey: 'laser',
              heatRatio: 0.2,
              isOverheated: false,
              primaryDamageMultiplier: 1,
            };
          },
        },
      },
    };

    const best = policy.resolveBehavior({
      enemy,
      enemyType: 'skirm',
      candidates: [
        { x: 200, y: 150, speedScalar: 1 },
        { x: 80, y: 150, speedScalar: 1 },
      ],
    });

    assert.equal(best.x, 80);
  });

  it('penalizes collapsing same-type enemies into the same corner', () => {
    const encoder = new EnemyFeatureEncoder();
    const policy = new EnemyAdaptivePolicy({ encoder });
    policy.load();

    const enemy = {
      enemyType: 'skirm',
      _nativeSpeed: 80,
      x: 96,
      y: 90,
      scene: {
        _enemies: [
          { enemyType: 'skirm', x: 28, y: 28, active: true, alive: true },
          { enemyType: 'skirm', x: 42, y: 44, active: true, alive: true },
        ],
        _player: { x: 200, y: 500 },
        _getEnemyLearningPlayerSnapshot() {
          return { x: 200, y: 500, hasShield: false, shieldRatio: 0, hpRatio: 1 };
        },
        _weapons: {
          getLearningSnapshot() {
            return {
              primaryWeaponKey: 'laser',
              heatRatio: 0.1,
              isOverheated: false,
              primaryDamageMultiplier: 1,
            };
          },
          pool: {
            getChildren() {
              return [];
            },
          },
        },
      },
    };

    const best = policy.resolveBehavior({
      enemy,
      enemyType: 'skirm',
      candidates: [
        { x: 36, y: 36, speedScalar: 1, actionMode: 'hold' },
        { x: 180, y: 120, speedScalar: 1, actionMode: 'press' },
      ],
    });

    assert.equal(best.x, 180);
  });
});
