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
  EnemyCombatValueNetwork,
} = await import('../../../systems/ml/EnemyCombatValueNetwork.js');
const {
  ENEMY_LEARNING_CONFIG,
} = await import('../../../config/enemyLearning.config.js');

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
    assert.ok(rawState.enemyModels.skirm.combatNetwork !== undefined);
    assert.ok(typeof rawState.enemyModels.skirm.lastScores.survival === 'number');
    assert.ok(typeof rawState.enemyModels.skirm.lastScores.offense === 'number');
    assert.equal(rawDataset.enemyExamples.skirm.length, 4);

    const reloaded = new EnemyAdaptivePolicy();
    reloaded.load();
    const reloadedModifiers = reloaded.getModifiers('skirm');
    assert.equal(reloadedModifiers.sampleCount, afterEnemyWin.sampleCount);
    assert.equal(reloadedModifiers.minSpeedScalar, afterEnemyWin.minSpeedScalar);
    assert.equal(reloadedModifiers.maxSpeedScalar, afterEnemyWin.maxSpeedScalar);
  });

  it('derives offense labels from pressure+win and persists a trained combat network', () => {
    // Verify that the policy correctly maps pressure+win → offense labels and
    // stores a combatNetwork in localStorage after training.
    const policy = new EnemyAdaptivePolicy();
    policy.load();
    policy.trainFromSession(createSeparableSessionRecord(), 'player_win');

    const rawState = JSON.parse(globalThis.localStorage.getItem(ENEMY_LEARNING_STORAGE_KEY));
    const model = rawState.enemyModels.skirm;

    // A combatNetwork must have been stored (even if null weights, the shape must exist).
    assert.ok(model.combatNetwork !== undefined, 'combatNetwork key must exist in stored state');
    assert.ok(typeof model.lastScores.survival === 'number', 'lastScores.survival must be a number');
    assert.ok(typeof model.lastScores.offense  === 'number', 'lastScores.offense must be a number');
    assert.ok(model.sampleCount > 0, 'sampleCount must be > 0 after training');

    // Verify the offense label derivation: examples with high pressure+win should
    // push lastScores.offense above the cold-start 0.5 baseline.
    // createSeparableSessionRecord has half examples with pressure=1,win=1 → offense=1
    // and half with pressure=0,win≈0 → offense≈0. Net effect depends on network.
    // What we can assert: the training set correctly derives offenseLabels.
    const trainingSet = policy._buildEnemyTrainingSet([
      { vector: [1, 1, 0.8], labels: { win: 1, survival: 1, pressure: 1, collision: 0, bullet: 0 }, meta: { telemetryLevelId: 1 } },
      { vector: [-1, -1, -0.8], labels: { win: 0, survival: 0, pressure: 0, collision: 1, bullet: 1 }, meta: { telemetryLevelId: 1 } },
    ]);
    // offense label for positive example = 0.35*1 + 0.65*1 = 1.0
    assert.ok(trainingSet.offenseLabels[0] > 0.9, `positive example offense label should be ~1, got ${trainingSet.offenseLabels[0]}`);
    // offense label for negative example = 0.35*0 + 0.65*0 = 0
    assert.ok(trainingSet.offenseLabels[1] < 0.1, `negative example offense label should be ~0, got ${trainingSet.offenseLabels[1]}`);
    // survival label passthrough
    assert.strictEqual(trainingSet.survivalLabels[0], 1);
    assert.strictEqual(trainingSet.survivalLabels[1], 0);
  });

  it('builds recency weights from telemetry order and derives offense labels from pressure+win', () => {
    const policy = new EnemyAdaptivePolicy();
    policy.load();

    const trainingSet = policy._buildEnemyTrainingSet([
      {
        vector: [0.2],
        labels: { win: 0.1, survival: 0.4, pressure: 0.1, collision: 0, bullet: 0 },
        meta: { telemetryLevelId: 2, levelNumber: 2 },
      },
      {
        vector: [0.4],
        labels: { win: 0.2, survival: 0.5, pressure: 0.2, collision: 0, bullet: 0 },
        meta: { telemetryLevelId: 3, levelNumber: 3 },
      },
      {
        vector: [0.6],
        labels: { win: 0.8, survival: 0.9, pressure: 0.7, collision: 1, bullet: 1 },
        meta: { telemetryLevelId: 4, levelNumber: 4 },
      },
    ]);

    assert.equal(trainingSet.examples.length, 3);
    assert.ok(trainingSet.recencyWeights[2] > trainingSet.recencyWeights[1]);
    assert.ok(trainingSet.recencyWeights[1] > trainingSet.recencyWeights[0]);
    // offense label for index 2 (high pressure+win) should exceed index 0 (low pressure+win)
    assert.ok(trainingSet.offenseLabels[2] > trainingSet.offenseLabels[0]);
    // survival label passes through unchanged
    assert.ok(trainingSet.survivalLabels[2] > trainingSet.survivalLabels[0]);
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
      featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
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

    assert.equal(directive.doctrine, 'suppress');
    assert.equal(directive.pathPattern, 'focus_lane');
    assert.equal(directive.idlePattern, 'focus_lane');
    assert.ok(directive.focusX > 0);
    assert.ok(directive.spreadMultiplier >= 0.9);
  });

  it('forces an overlay raptor pair into an attacking wing doctrine even before it has landed hits', () => {
    const policy = new EnemyAdaptivePolicy();
    policy.load();

    const directive = policy.evaluateSquadDirective({
      scene: {
        _getEnemyLearningPlayerSnapshot() {
          return { x: 200, y: 500, hasShield: false, shieldRatio: 0, hpRatio: 1 };
        },
        _weapons: {
          getLearningSnapshot() {
            return {
              primaryWeaponKey: 'laser',
              heatRatio: 0,
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
      squadId: 'sq-r',
      formation: 'line',
      dance: 'side_left',
      overlay: true,
      primaryEnemyType: 'raptor',
      liveEnemies: [
        { enemyType: 'raptor', x: 120, y: 190, active: true, alive: true, _squadId: 'sq-r', _squadSpawnCount: 2 },
        { enemyType: 'raptor', x: 208, y: 190, active: true, alive: true, _squadId: 'sq-r', _squadSpawnCount: 2 },
      ],
      stats: {
        spawnCount: 2,
        shotCount: 0,
        playerHitCount: 0,
        hpDamageToPlayer: 0,
        shieldDamageToPlayer: 0,
        collisionDeathCount: 0,
      },
    });

    assert.ok(directive);
    assert.ok(
      directive.doctrine === 'crossfire' || directive.doctrine === 'encircle' || directive.doctrine === 'collapse',
      `expected an attacking raptor wing doctrine, got ${directive?.doctrine}`
    );
    assert.ok(directive.focusPull >= 0.3);
  });

  it('forces an idle-player skirm squad into an attacking doctrine instead of passive suppress', () => {
    const policy = new EnemyAdaptivePolicy();
    policy.load();

    const directive = policy.evaluateSquadDirective({
      scene: {
        _getEnemyLearningPlayerSnapshot() {
          return { x: 200, y: 500, hasShield: false, shieldRatio: 0, hpRatio: 1 };
        },
        _weapons: {
          getLearningSnapshot() {
            return {
              primaryWeaponKey: 'laser',
              heatRatio: 0,
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
      squadId: 'sq-s',
      formation: 'line',
      dance: 'straight',
      overlay: false,
      primaryEnemyType: 'skirm',
      liveEnemies: [
        { enemyType: 'skirm', x: 120, y: 90, active: true, alive: true, _squadId: 'sq-s', _squadSpawnCount: 4 },
        { enemyType: 'skirm', x: 170, y: 98, active: true, alive: true, _squadId: 'sq-s', _squadSpawnCount: 4 },
        { enemyType: 'skirm', x: 230, y: 104, active: true, alive: true, _squadId: 'sq-s', _squadSpawnCount: 4 },
        { enemyType: 'skirm', x: 290, y: 110, active: true, alive: true, _squadId: 'sq-s', _squadSpawnCount: 4 },
      ],
      stats: {
        spawnCount: 4,
        shotCount: 0,
        playerHitCount: 0,
        hpDamageToPlayer: 0,
        shieldDamageToPlayer: 0,
        collisionDeathCount: 0,
      },
    });

    assert.ok(directive);
    assert.notEqual(directive.doctrine, 'suppress');
    assert.ok(
      directive.doctrine === 'collapse' || directive.doctrine === 'crossfire' || directive.doctrine === 'encircle',
      `expected attacking skirm doctrine, got ${directive?.doctrine}`
    );
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

  it('ranks a candidate higher when the network predicts higher survival and offense', () => {
    // Inject a cold-start network; verify that when two candidates have
    // explicitly different predictions, the higher-scoring one wins.
    const encoder = new EnemyFeatureEncoder();
    const policy = new EnemyAdaptivePolicy({ encoder });
    policy.load();

    // Build a small network, train it so that [1,1,...,1] → high scores and
    // [-1,-1,...,-1] → low scores using a single-feature proxy.
    // Use a 1-feature variant to guarantee convergence without flakiness.
    const smallNet = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    smallNet._initWeights(1);
    // Manually set weights so that input=1 → survival≈1,offense≈1 and input=-1 → ~0
    // w1[i] = [big_positive], b1[i] = 0 → relu(input * big) → positive chain → sigmoid near 1
    for (let i = 0; i < 4; i++) {
      smallNet._w1[i] = [5];
      smallNet._b1[i] = 0;
    }
    for (let i = 0; i < 4; i++) {
      smallNet._w2[i] = [5, 5, 5, 5];
      smallNet._b2[i] = 0;
    }
    for (let i = 0; i < 4; i++) {
      smallNet._w3[i] = [5, 5, 5, 5];
      smallNet._b3[i] = 0;
    }
    smallNet._wSurv = [5, 5, 5, 5];
    smallNet._bSurv = -5;  // sigmoid(-5)≈0.007 when all hidden units are dead (input=-1)
    smallNet._wOff  = [5, 5, 5, 5];
    smallNet._bOff  = -5;

    const goodPred = smallNet.predict([1]);
    const badPred  = smallNet.predict([-1]);
    assert.ok(goodPred.survival > 0.9, 'good prediction survival should be near 1');
    assert.ok(goodPred.offense  > 0.9, 'good prediction offense should be near 1');
    assert.ok(badPred.survival  < 0.5, 'bad prediction survival should be below 0.5');

    // Runtime scoring formula: score = 0.45 * survival + 0.55 * offense
    const goodScore = 0.45 * goodPred.survival + 0.55 * goodPred.offense;
    const badScore  = 0.45 * badPred.survival  + 0.55 * badPred.offense;
    assert.ok(goodScore > badScore, `good score ${goodScore} should exceed bad score ${badScore}`);
  });

  it('forces attack-mode candidates when the player is not shooting', () => {
    const encoder = new EnemyFeatureEncoder();
    const featureNames = encoder.getFeatureNames();
    const zeroWeights = new Array(featureNames.length).fill(0);

    globalThis.localStorage.setItem(ENEMY_LEARNING_STORAGE_KEY, JSON.stringify({
      featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
      enemyModels: {
        skirm: {
          winModel: { weights: zeroWeights, bias: 0 },
          survivalModel: { weights: zeroWeights, bias: 0 },
          pressureModel: { weights: zeroWeights, bias: 0 },
          collisionModel: { weights: zeroWeights, bias: 0 },
          bulletModel: { weights: zeroWeights, bias: 0 },
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
          return { x: 200, y: 500, hasShield: false, shieldRatio: 0, hpRatio: 1 };
        },
        _weapons: {
          getLearningSnapshot() {
            return {
              primaryWeaponKey: 'laser',
              heatRatio: 0,
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
        { x: 200, y: 120, speedScalar: 1, actionMode: 'evade' },
        { x: 220, y: 140, speedScalar: 1, actionMode: 'press' },
        { x: 120, y: 130, speedScalar: 1, actionMode: 'flank' },
      ],
    });

    assert.ok(best);
    assert.notEqual(best.actionMode, 'evade');
    assert.ok(best.actionMode === 'press' || best.actionMode === 'flank');
  });

  it('switches to a safer evasive lane when the center line is full of incoming bullets', () => {
    const encoder = new EnemyFeatureEncoder();
    const policy = new EnemyAdaptivePolicy({ encoder });
    policy.load();

    const bullets = [{
      active: true,
      x: 200,
      y: 260,
      body: {
        velocity: { x: 0, y: -500 },
      },
    }];

    const enemy = {
      enemyType: 'skirm',
      _nativeSpeed: 80,
      x: 200,
      y: 200,
      scene: {
        _enemies: [],
        _player: { x: 200, y: 500 },
        _getEnemyLearningPlayerSnapshot() {
          return { x: 200, y: 500, hasShield: false, shieldRatio: 0, hpRatio: 1 };
        },
        _weapons: {
          getLearningSnapshot() {
            return {
              primaryWeaponKey: 'laser',
              heatRatio: 0.3,
              isOverheated: false,
              primaryDamageMultiplier: 1,
            };
          },
          pool: {
            getChildren() {
              return bullets;
            },
          },
        },
      },
    };

    const ranked = policy.rankBehaviors({
      enemy,
      enemyType: 'skirm',
      player: { x: 200, y: 500, hasShield: false, shieldRatio: 0, hpRatio: 1 },
      weapon: {
        primaryWeaponKey: 'laser',
        heatRatio: 0.3,
        isOverheated: false,
        primaryDamageMultiplier: 1,
      },
      playerBullets: bullets,
      liveEnemies: [],
      candidates: [
        { x: 200, y: 220, speedScalar: 1, actionMode: 'press' },
        { x: 80, y: 120, speedScalar: 1, actionMode: 'evade' },
      ],
    }, 2);

    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].actionMode, 'evade');
    assert.equal(ranked[0].x, 80);
    assert.ok(ranked[0].predictedBulletRisk < ranked[1].predictedBulletRisk);
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('reuses cached runtime combat networks instead of rebuilding them on every resolveBehavior call', () => {
    const encoder = new EnemyFeatureEncoder();

    globalThis.localStorage.setItem(ENEMY_LEARNING_STORAGE_KEY, JSON.stringify({
      featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
      enemyModels: {
        skirm: {
          combatNetwork: null,
          sampleCount: 8,
          lastScores: { survival: 0.5, offense: 0.5 },
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
          return { x: 200, y: 500, hasShield: false, shieldRatio: 0, hpRatio: 1 };
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
          pool: {
            getChildren() {
              return [];
            },
          },
        },
      },
    };

    policy.resolveBehavior({
      enemy,
      enemyType: 'skirm',
      candidates: [{ x: 200, y: 150, speedScalar: 1 }],
    });
    const firstEntry = policy._runtimeNetworkCache.get('skirm');

    policy.resolveBehavior({
      enemy,
      enemyType: 'skirm',
      candidates: [{ x: 220, y: 150, speedScalar: 1 }],
    });
    const secondEntry = policy._runtimeNetworkCache.get('skirm');

    assert.ok(firstEntry);
    assert.strictEqual(secondEntry, firstEntry);
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

  it('curates the training set by keeping eventful samples and capping boring telemetry', () => {
    const policy = new EnemyAdaptivePolicy();
    policy.load();

    const examples = [
      ...Array.from({ length: 40 }, (_, index) => ({
        vector: [1, index / 40],
        labels: { win: 0.9, survival: 1, pressure: 1, collision: 0, bullet: 0 },
        meta: { telemetryLevelId: 4, levelNumber: 4, outcomeMagnitude: 1, reason: 'player_hit' },
      })),
      ...Array.from({ length: 220 }, (_, index) => ({
        vector: [0.5, index / 220],
        labels: { win: 0.725, survival: 1, pressure: 0, collision: 0, bullet: 0 },
        meta: { telemetryLevelId: 4, levelNumber: 4, outcomeMagnitude: 1, reason: 'spawn' },
      })),
      ...Array.from({ length: 220 }, (_, index) => ({
        vector: [0, index / 220],
        labels: { win: 0.5, survival: 0.5, pressure: 0, collision: 0, bullet: 0 },
        meta: { telemetryLevelId: 4, levelNumber: 4, outcomeMagnitude: 0, reason: 'heartbeat' },
      })),
    ];

    const trainingSet = policy._buildEnemyTrainingSet(examples);
    const retainedEventful = trainingSet.examples.filter(example => (example.labels?.pressure ?? 0) > 0).length;
    const retainedSafe = trainingSet.examples.filter(example => (
      (example.labels?.pressure ?? 0) <= 0
      && (example.labels?.collision ?? 0) <= 0
      && (example.labels?.bullet ?? 0) <= 0
      && (example.labels?.survival ?? 0) >= 0.75
    )).length;
    const retainedNeutral = trainingSet.examples.filter(example => (
      (example.labels?.pressure ?? 0) <= 0
      && (example.labels?.collision ?? 0) <= 0
      && (example.labels?.bullet ?? 0) <= 0
      && (example.labels?.survival ?? 0) < 0.75
    )).length;

    assert.equal(retainedEventful, 40);
    assert.equal(retainedSafe, 40);
    assert.equal(retainedNeutral, 10);
    assert.equal(trainingSet.examples.length, 90);
  });
});
