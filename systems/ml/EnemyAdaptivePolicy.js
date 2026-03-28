/** @module EnemyAdaptivePolicy */

import { ENEMIES } from '../../config/enemies.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { EnemyDatasetStore } from './EnemyDatasetStore.js';
import { EnemyFeatureEncoder } from './EnemyFeatureEncoder.js';
import { EnemyLearningSession } from './EnemyLearningSession.js';
import { EnemyLearningStore } from './EnemyLearningStore.js';
import { LogisticRegressor } from './LogisticRegressor.js';
import { buildPlayerBulletThreatSnapshot, buildSquadSnapshot } from './EnemyPolicyMath.js';
import { SquadDatasetStore } from './SquadDatasetStore.js';
import { SquadFeatureEncoder } from './SquadFeatureEncoder.js';
import { SquadLearningStore } from './SquadLearningStore.js';
import { SquadPolicyNetwork } from './SquadPolicyNetwork.js';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveCornerPenalty(x, y, normalization, cornerDistancePx) {
  const width = normalization.width ?? 0;
  const height = normalization.height ?? 0;
  const distanceToNearestCorner = Math.min(
    Math.hypot(x, y),
    Math.hypot(width - x, y),
    Math.hypot(x, height - y),
    Math.hypot(width - x, height - y)
  );

  return clamp(1 - distanceToNearestCorner / Math.max(1, cornerDistancePx), 0, 1);
}

function resolveSpatialPenalties(candidate, enemy, liveEnemies, config) {
  const policy = config.runtimePolicy ?? {};
  const normalization = config.normalization ?? {};
  const spacingRadiusPx = Math.max(1, policy.sameTypeSpacingPx ?? 88);
  const laneCrowdingPx = Math.max(1, policy.laneCrowdingPx ?? 72);
  const cornerPenaltyDistancePx = Math.max(1, policy.cornerPenaltyDistancePx ?? 112);
  const sameTypeEnemies = (liveEnemies ?? []).filter(other => (
    other
    && other !== enemy
    && other.active !== false
    && other.alive !== false
    && other.enemyType === enemy?.enemyType
  ));

  let spacingPenalty = 0;
  let crowdedNeighbors = 0;

  for (const other of sameTypeEnemies) {
    const dx = (candidate.x ?? 0) - (other?.x ?? 0);
    const dy = (candidate.y ?? 0) - (other?.y ?? 0);
    const distance = Math.hypot(dx, dy);
    spacingPenalty = Math.max(
      spacingPenalty,
      clamp(1 - distance / spacingRadiusPx, 0, 1)
    );

    if (Math.abs(dx) <= laneCrowdingPx && Math.abs(dy) <= laneCrowdingPx * 1.5) {
      crowdedNeighbors += 1;
    }
  }

  return {
    spacingPenalty,
    laneCrowdingPenalty: clamp(
      crowdedNeighbors / Math.max(1, sameTypeEnemies.length || 1),
      0,
      1
    ),
    cornerPenalty: resolveCornerPenalty(
      candidate.x ?? 0,
      candidate.y ?? 0,
      normalization,
      cornerPenaltyDistancePx
    ),
  };
}

function createDefaultModel() {
  return {
    winModel: { weights: [], bias: 0 },
    survivalModel: { weights: [], bias: 0 },
    pressureModel: { weights: [], bias: 0 },
    collisionModel: { weights: [], bias: 0 },
    bulletModel: { weights: [], bias: 0 },
    sampleCount: 0,
    lastScores: {
      win: 0.5,
      survival: 0.5,
      pressure: 0.5,
      collision: 0.5,
      bullet: 0.5,
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isBackgroundTrainingRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && typeof globalThis.setTimeout === 'function';
}

/**
 * Cross-run adaptive enemy policy.
 * Loads persisted class models at run start, trains them at run end, then
 * scores candidate movement choices during the next run.
 */
export class EnemyAdaptivePolicy {
  /**
   * @param {{
   *   store?: EnemyLearningStore,
   *   encoder?: EnemyFeatureEncoder,
   *   enemyConfigs?: object,
   *   config?: object,
   * }} [options={}]
   */
  constructor(options = {}) {
    this._store = options.store ?? new EnemyLearningStore();
    this._datasetStore = options.datasetStore ?? new EnemyDatasetStore();
    this._encoder = options.encoder ?? new EnemyFeatureEncoder();
    this._squadEncoder = options.squadEncoder ?? new SquadFeatureEncoder();
    this._squadStore = options.squadStore ?? new SquadLearningStore();
    this._squadDatasetStore = options.squadDatasetStore ?? new SquadDatasetStore();
    this._enemyConfigs = options.enemyConfigs ?? ENEMIES;
    this._config = options.config ?? ENEMY_LEARNING_CONFIG;
    this._state = null;
    this._squadState = null;
    this._backgroundTrainingPromise = Promise.resolve();
  }

  load() {
    this._state = this._store.load();
    this._squadState = this._squadStore.load();
    return this.getSnapshot();
  }

  getSnapshot() {
    if (!this._state) this.load();
    return JSON.parse(JSON.stringify({
      ...this._state,
      squadModels: this._squadState?.squadModels ?? {},
    }));
  }

  _ensureModel(enemyType) {
    if (!this._state) this.load();
    if (!this._state.enemyModels[enemyType]) {
      this._state.enemyModels[enemyType] = createDefaultModel();
    }
    return this._state.enemyModels[enemyType];
  }

  /**
   * @param {string} enemyType
   * @returns {{enabled: boolean, minSpeedScalar: number, maxSpeedScalar: number, sampleCount: number, predictedEnemyWinRate: number, predictedSurvival: number, predictedPressure: number, predictedCollisionRisk: number, predictedBulletRisk: number}}
   */
  getModifiers(enemyType) {
    const adaptiveConfig = this._enemyConfigs[enemyType]?.adaptive;
    if (!adaptiveConfig?.enabled) {
      return {
        enabled: false,
        minSpeedScalar: 1,
        maxSpeedScalar: 1,
        sampleCount: 0,
        predictedEnemyWinRate: 0.5,
        predictedSurvival: 0.5,
        predictedPressure: 0.5,
        predictedCollisionRisk: 0.5,
        predictedBulletRisk: 0.5,
      };
    }

    const model = this._ensureModel(enemyType);
    return {
      enabled: true,
      minSpeedScalar: adaptiveConfig.minSpeedScalar ?? 1,
      maxSpeedScalar: adaptiveConfig.maxSpeedScalar ?? 1,
      sampleCount: model.sampleCount ?? 0,
      predictedEnemyWinRate: model.lastScores?.win ?? 0.5,
      predictedSurvival: model.lastScores?.survival ?? 0.5,
      predictedPressure: model.lastScores?.pressure ?? 0.5,
      predictedCollisionRisk: model.lastScores?.collision ?? 0.5,
      predictedBulletRisk: model.lastScores?.bullet ?? 0.5,
    };
  }

  /**
   * @param {object} options
   * @returns {EnemyLearningSession}
   */
  createRunSession(options) {
    if (!this._state) this.load();
    return new EnemyLearningSession({
      ...options,
      encoder: this._encoder,
      squadEncoder: this._squadEncoder,
      sampleIntervalMs: this._config.sampleIntervalMs,
    });
  }

  _buildEnemyStateFromDataset(datasetState) {
    const nextState = cloneJson(this._state ?? this._store.load());

    for (const [enemyType, enemyConfig] of Object.entries(this._enemyConfigs)) {
      if (!enemyConfig?.adaptive?.enabled) continue;

      const examples = datasetState.enemyExamples?.[enemyType] ?? [];
      if (examples.length === 0) {
        nextState.enemyModels[enemyType] = createDefaultModel();
        continue;
      }

      const winRegressor = new LogisticRegressor();
      const survivalRegressor = new LogisticRegressor();
      const pressureRegressor = new LogisticRegressor();
      const collisionRegressor = new LogisticRegressor();
      const bulletRegressor = new LogisticRegressor();
      const vectors = examples.map(example => example.vector);
      const winLabels = examples.map(example => example.labels?.win ?? 0);
      const survivalLabels = examples.map(example => example.labels?.survival ?? 0);
      const pressureLabels = examples.map(example => example.labels?.pressure ?? 0);
      const collisionLabels = examples.map(example => example.labels?.collision ?? 0);
      const bulletLabels = examples.map(example => example.labels?.bullet ?? 0);

      winRegressor.trainBatch(vectors, winLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      survivalRegressor.trainBatch(vectors, survivalLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      pressureRegressor.trainBatch(vectors, pressureLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      collisionRegressor.trainBatch(vectors, collisionLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      bulletRegressor.trainBatch(vectors, bulletLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });

      const divisor = Math.max(1, examples.length);
      const scores = examples.reduce((accumulator, example) => ({
        win: accumulator.win + winRegressor.predictProbability(example.vector),
        survival: accumulator.survival + survivalRegressor.predictProbability(example.vector),
        pressure: accumulator.pressure + pressureRegressor.predictProbability(example.vector),
        collision: accumulator.collision + collisionRegressor.predictProbability(example.vector),
        bullet: accumulator.bullet + bulletRegressor.predictProbability(example.vector),
      }), {
        win: 0,
        survival: 0,
        pressure: 0,
        collision: 0,
        bullet: 0,
      });

      nextState.enemyModels[enemyType] = {
        winModel: winRegressor.getState(),
        survivalModel: survivalRegressor.getState(),
        pressureModel: pressureRegressor.getState(),
        collisionModel: collisionRegressor.getState(),
        bulletModel: bulletRegressor.getState(),
        sampleCount: examples.length,
        lastScores: {
          win: scores.win / divisor,
          survival: scores.survival / divisor,
          pressure: scores.pressure / divisor,
          collision: scores.collision / divisor,
          bullet: scores.bullet / divisor,
        },
      };
    }

    return nextState;
  }

  async _buildEnemyStateFromDatasetAsync(datasetState) {
    const nextState = cloneJson(this._state ?? this._store.load());

    for (const [enemyType, enemyConfig] of Object.entries(this._enemyConfigs)) {
      if (!enemyConfig?.adaptive?.enabled) continue;

      const examples = datasetState.enemyExamples?.[enemyType] ?? [];
      if (examples.length === 0) {
        nextState.enemyModels[enemyType] = createDefaultModel();
        continue;
      }

      const winRegressor = new LogisticRegressor();
      const survivalRegressor = new LogisticRegressor();
      const pressureRegressor = new LogisticRegressor();
      const collisionRegressor = new LogisticRegressor();
      const bulletRegressor = new LogisticRegressor();
      const vectors = examples.map(example => example.vector);
      const winLabels = examples.map(example => example.labels?.win ?? 0);
      const survivalLabels = examples.map(example => example.labels?.survival ?? 0);
      const pressureLabels = examples.map(example => example.labels?.pressure ?? 0);
      const collisionLabels = examples.map(example => example.labels?.collision ?? 0);
      const bulletLabels = examples.map(example => example.labels?.bullet ?? 0);

      await winRegressor.trainBatchAsync(vectors, winLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      await survivalRegressor.trainBatchAsync(vectors, survivalLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      await pressureRegressor.trainBatchAsync(vectors, pressureLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      await collisionRegressor.trainBatchAsync(vectors, collisionLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });
      await bulletRegressor.trainBatchAsync(vectors, bulletLabels, {
        learningRate: this._config.learningRate,
        regularization: this._config.regularization,
        epochs: this._config.trainingEpochsPerRun,
      });

      const divisor = Math.max(1, examples.length);
      const scores = examples.reduce((accumulator, example) => ({
        win: accumulator.win + winRegressor.predictProbability(example.vector),
        survival: accumulator.survival + survivalRegressor.predictProbability(example.vector),
        pressure: accumulator.pressure + pressureRegressor.predictProbability(example.vector),
        collision: accumulator.collision + collisionRegressor.predictProbability(example.vector),
        bullet: accumulator.bullet + bulletRegressor.predictProbability(example.vector),
      }), {
        win: 0,
        survival: 0,
        pressure: 0,
        collision: 0,
        bullet: 0,
      });

      nextState.enemyModels[enemyType] = {
        winModel: winRegressor.getState(),
        survivalModel: survivalRegressor.getState(),
        pressureModel: pressureRegressor.getState(),
        collisionModel: collisionRegressor.getState(),
        bulletModel: bulletRegressor.getState(),
        sampleCount: examples.length,
        lastScores: {
          win: scores.win / divisor,
          survival: scores.survival / divisor,
          pressure: scores.pressure / divisor,
          collision: scores.collision / divisor,
          bullet: scores.bullet / divisor,
        },
      };

      await new Promise(resolve => globalThis.setTimeout?.(resolve, 0) ?? resolve());
    }

    return nextState;
  }

  _buildLevel2SquadStateFromDataset(datasetState) {
    const bootstrapExamples = datasetState.examples ?? [];
    const nextSquadState = cloneJson(this._squadState ?? this._squadStore.load());

    if (bootstrapExamples.length === 0) {
      return nextSquadState;
    }

    const modelState = nextSquadState.squadModels?.level2 ?? {};
    const network = new SquadPolicyNetwork(modelState);
    const scores = network.trainBatch(
      bootstrapExamples.map(example => example.vector),
      bootstrapExamples.map(example => example.labels),
      {
        learningRate: this._config.squadLearningRate,
        regularization: this._config.squadRegularization,
        epochs: this._config.squadTrainingEpochsPerRun,
      }
    );

    return {
      featureVersion: this._config.featureVersion,
      squadModels: {
        level2: {
          ...network.getState(),
          sampleCount: bootstrapExamples.length,
          lastScores: scores,
        },
      },
    };
  }

  async _buildLevel2SquadStateFromDatasetAsync(datasetState) {
    const bootstrapExamples = datasetState.examples ?? [];
    const nextSquadState = cloneJson(this._squadState ?? this._squadStore.load());

    if (bootstrapExamples.length === 0) {
      return nextSquadState;
    }

    const modelState = nextSquadState.squadModels?.level2 ?? {};
    const network = new SquadPolicyNetwork(modelState);
    const scores = await network.trainBatchAsync(
      bootstrapExamples.map(example => example.vector),
      bootstrapExamples.map(example => example.labels),
      {
        learningRate: this._config.squadLearningRate,
        regularization: this._config.squadRegularization,
        epochs: this._config.squadTrainingEpochsPerRun,
      }
    );

    return {
      featureVersion: this._config.featureVersion,
      squadModels: {
        level2: {
          ...network.getState(),
          sampleCount: bootstrapExamples.length,
          lastScores: scores,
        },
      },
    };
  }

  _scheduleBackgroundRetraining() {
    this._backgroundTrainingPromise = this._backgroundTrainingPromise
      .catch(() => null)
      .then(async () => {
        await new Promise(resolve => globalThis.setTimeout?.(resolve, 0) ?? resolve());
        const latestEnemyDataset = this._datasetStore.load();
        const latestSquadDataset = this._squadDatasetStore.load();
        const nextEnemyState = await this._buildEnemyStateFromDatasetAsync(latestEnemyDataset);
        const nextSquadState = await this._buildLevel2SquadStateFromDatasetAsync(latestSquadDataset);
        this._store.stage(nextEnemyState);
        this._squadStore.stage(nextSquadState);
      });
  }

  /**
   * @param {{buildTrainingRecords: Function, destroy?: Function}} session
   * @param {'enemy_win'|'player_win'} outcome
   * @returns {object}
   */
  trainFromSession(session, outcome) {
    if (!this._state) this.load();
    try {
      const records = session?.buildTrainingRecords?.(outcome) ?? [];
      const squadRecords = session?.buildSquadTrainingRecords?.(outcome) ?? [];
      const levelNumber = Math.max(1, Math.round(session?._levelNumber ?? 1));
      const enemyDataset = this._datasetStore.appendTrainingRecords(records, {
        outcome,
        levelNumber,
      });
      const squadDataset = this._squadDatasetStore.appendTrainingRecords(squadRecords, {
        outcome,
        levelNumber,
      });

      if (isBackgroundTrainingRuntime()) {
        this._scheduleBackgroundRetraining();
        return this.getSnapshot();
      }

      this._state = this._store.save(this._buildEnemyStateFromDataset(enemyDataset));
      this._squadState = this._squadStore.save(this._buildLevel2SquadStateFromDataset(squadDataset));
      return this.getSnapshot();
    } catch {
      return this.getSnapshot();
    } finally {
      session?.destroy?.();
    }
  }

  _buildSpeedScalars(minSpeedScalar, maxSpeedScalar) {
    const fractions = this._config.runtimePolicy?.speedScalars ?? [0, 0.5, 1];
    const minScale = Math.min(minSpeedScalar, maxSpeedScalar);
    const maxScale = Math.max(minSpeedScalar, maxSpeedScalar);

    return [...new Set(fractions.map(fraction => (
      clamp(minScale + (maxScale - minScale) * fraction, minScale, maxScale)
    )))];
  }

  /**
   * Score runtime candidate movement choices and return the best option.
   * @param {{
   *   enemy: object,
   *   enemyType: string,
   *   candidates: Array<{x: number, y: number, speedScalar: number}>,
   * }} options
   * @returns {{x: number, y: number, speedScalar: number, actionMode?: string, score: number, predictedEnemyWinRate: number, predictedSurvival: number, predictedPressure: number, predictedCollisionRisk: number, predictedBulletRisk: number}|null}
   */
  resolveBehavior(options) {
    const enemyType = options.enemyType;
    const adaptiveConfig = this._enemyConfigs[enemyType]?.adaptive;
    if (!adaptiveConfig?.enabled) {
      return options.candidates?.[0] ?? null;
    }

    const modelState = this._ensureModel(enemyType);
    const winRegressor = new LogisticRegressor(modelState.winModel);
    const survivalRegressor = new LogisticRegressor(modelState.survivalModel);
    const pressureRegressor = new LogisticRegressor(modelState.pressureModel);
    const collisionRegressor = new LogisticRegressor(modelState.collisionModel);
    const bulletRegressor = new LogisticRegressor(modelState.bulletModel);
    const liveEnemies = options.enemy?.scene?._enemies ?? [];
    const player = options.enemy?.scene?._getEnemyLearningPlayerSnapshot?.() ?? {
      x: options.enemy?.scene?._player?.x ?? 0,
      y: options.enemy?.scene?._player?.y ?? 0,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    };
    const weapon = options.enemy?.scene?._weapons?.getLearningSnapshot?.() ?? {
      primaryWeaponKey: null,
      heatRatio: 0,
      isOverheated: false,
      primaryDamageMultiplier: 1,
    };
    const playerBullets = options.enemy?.scene?._weapons?.pool?.getChildren?.()?.filter?.(bullet => bullet?.active) ?? [];
    const weights = this._config.runtimeWeights ?? {
      win: 0.7,
      survival: 0.2,
      pressure: 1,
      collision: 1.05,
      bullet: 1.15,
      spacing: 0.45,
      laneCrowding: 0.25,
      corner: 0.18,
    };

    let bestChoice = null;

    for (const candidate of options.candidates ?? []) {
      const squad = buildSquadSnapshot(liveEnemies, options.enemy?._squadId ?? null, {
        ...options.enemy,
        x: candidate.x,
        y: candidate.y,
      });
      const threat = buildPlayerBulletThreatSnapshot(playerBullets, {
        ...options.enemy,
        x: candidate.x,
        y: candidate.y,
      }, this._config.normalization);
      const sample = this._encoder.buildSample({
        enemyType,
        player,
        weapon,
        enemyX: candidate.x,
        enemyY: candidate.y,
        speed: Math.max(1, (options.enemy?._nativeSpeed ?? options.enemy?.speed ?? 1) * candidate.speedScalar),
        squad,
        threat,
        actionMode: candidate.actionMode ?? 'hold',
      });
      const encoded = this._encoder.encodeSample(sample);
      const predictedEnemyWinRate = winRegressor.predictProbability(encoded.vector);
      const predictedSurvival = survivalRegressor.predictProbability(encoded.vector);
      const predictedPressure = pressureRegressor.predictProbability(encoded.vector);
      const predictedCollisionRisk = collisionRegressor.predictProbability(encoded.vector);
      const predictedBulletRisk = bulletRegressor.predictProbability(encoded.vector);
      const spatialPenalties = resolveSpatialPenalties(candidate, options.enemy, liveEnemies, this._config);
      const score = (
        predictedEnemyWinRate * weights.win
        + predictedPressure * weights.pressure
        + predictedSurvival * (weights.survival ?? 0)
        - predictedCollisionRisk * weights.collision
        - predictedBulletRisk * (weights.bullet ?? 0)
        - spatialPenalties.spacingPenalty * (weights.spacing ?? 0)
        - spatialPenalties.laneCrowdingPenalty * (weights.laneCrowding ?? 0)
        - spatialPenalties.cornerPenalty * (weights.corner ?? 0)
      );

      if (!bestChoice || score > bestChoice.score) {
        bestChoice = {
          ...candidate,
          score,
          predictedEnemyWinRate,
          predictedSurvival,
          predictedPressure,
          predictedCollisionRisk,
          predictedBulletRisk,
        };
      }
    }

    return bestChoice ?? null;
  }

  scoreCurrentPosition(options) {
    if (typeof options.enemy?.canUseAdaptiveBehavior === 'function' && !options.enemy.canUseAdaptiveBehavior()) {
      return {
        x: options.enemy?.x ?? 0,
        y: options.enemy?.y ?? 0,
        speedScalar: options.enemy?.adaptiveProfile?.currentSpeedScalar ?? 1,
        actionMode: options.enemy?._adaptiveActionMode ?? 'hold',
        score: 0,
        predictedEnemyWinRate: options.enemy?.adaptiveProfile?.predictedEnemyWinRate ?? 0.5,
        predictedSurvival: options.enemy?.adaptiveProfile?.predictedSurvival ?? 0.5,
        predictedPressure: options.enemy?.adaptiveProfile?.predictedPressure ?? 0.5,
        predictedCollisionRisk: options.enemy?.adaptiveProfile?.predictedCollisionRisk ?? 0.5,
        predictedBulletRisk: options.enemy?.adaptiveProfile?.predictedBulletRisk ?? 0.5,
      };
    }

    return this.resolveBehavior({
      ...options,
      candidates: [{
        x: options.enemy?.x ?? 0,
        y: options.enemy?.y ?? 0,
        speedScalar: options.enemy?.adaptiveProfile?.currentSpeedScalar ?? 1,
        actionMode: options.enemy?._adaptiveActionMode ?? 'hold',
      }],
    });
  }

  /**
   * Resolve candidate speeds for a given class without duplicating config math
   * in entity classes.
   * @param {string} enemyType
   * @returns {number[]}
   */
  getSpeedCandidates(enemyType) {
    const adaptiveConfig = this._enemyConfigs[enemyType]?.adaptive;
    if (!adaptiveConfig?.enabled) return [1];
    return this._buildSpeedScalars(
      adaptiveConfig.minSpeedScalar ?? 1,
      adaptiveConfig.maxSpeedScalar ?? 1
    );
  }

  /**
   * @returns {number[]}
   */
  getPositionOffsets() {
    return [...(this._config.runtimePolicy?.positionOffsets ?? [-1, -0.5, 0, 0.5, 1])];
  }

  /**
   * @returns {number[]}
   */
  getVerticalOffsets() {
    return [...(this._config.runtimePolicy?.verticalOffsets ?? [-1, -0.5, 0, 0.5, 1])];
  }

  evaluateSquadDirective(options = {}) {
    if (!this._squadState) this.load();

    const modelState = this._squadState?.squadModels?.level2 ?? {};
    if ((modelState.sampleCount ?? 0) <= 0) return null;

    const liveEnemies = (options.liveEnemies ?? []).filter(enemy => enemy?.active !== false && enemy?.alive !== false);
    if (liveEnemies.length === 0) return null;

    const scene = options.scene ?? liveEnemies[0]?.scene;
    const player = scene?._getEnemyLearningPlayerSnapshot?.() ?? {
      x: scene?._player?.x ?? 0,
      y: scene?._player?.y ?? 0,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    };
    const weapon = scene?._weapons?.getLearningSnapshot?.() ?? {
      primaryWeaponKey: null,
      heatRatio: 0,
      isOverheated: false,
      primaryDamageMultiplier: 1,
    };
    const fallbackEnemy = liveEnemies[0];
    const squad = buildSquadSnapshot(
      liveEnemies,
      options.squadId ?? fallbackEnemy?._squadId ?? null,
      fallbackEnemy
    );
    const closestEnemyDistance = liveEnemies.reduce((closest, enemy) => (
      Math.min(
        closest,
        Math.hypot((enemy?.x ?? 0) - (player?.x ?? 0), (enemy?.y ?? 0) - (player?.y ?? 0))
      )
    ), Number.POSITIVE_INFINITY);
    const stats = options.stats ?? {};
    const sample = this._squadEncoder.buildSample({
      player,
      weapon,
      squad,
      closestEnemyDistance: Number.isFinite(closestEnemyDistance) ? closestEnemyDistance : 0,
      overlay: options.overlay,
      formation: options.formation,
      dance: options.dance,
      primaryEnemyType: options.primaryEnemyType ?? fallbackEnemy?.enemyType ?? 'skirm',
      stats: {
        spawnCount: stats.spawnCount ?? liveEnemies.length,
        shotCount: stats.shotCount ?? 0,
        playerHitCount: stats.playerHitCount ?? 0,
        hpDamageToPlayer: stats.hpDamageToPlayer ?? 0,
        shieldDamageToPlayer: stats.shieldDamageToPlayer ?? 0,
        collisionDeathCount: stats.collisionDeathCount ?? 0,
      },
    });
    const encoded = this._squadEncoder.encodeSample(sample);
    const network = new SquadPolicyNetwork(modelState);
    const predictions = network.predict(encoded.vector);
    const runtimePolicy = this._config.squadRuntimePolicy ?? {};
    const aggression = clamp(
      predictions.pressure * 0.75 + predictions.win * 0.4 - predictions.collision * 0.6,
      0,
      1
    );
    const caution = clamp(
      predictions.collision * 1.1 - predictions.pressure * 0.2,
      0,
      1
    );

    return {
      predictions,
      cadenceModifier: clamp(
        0.92 + predictions.pressure * 0.28 + predictions.win * 0.12 - predictions.collision * 0.25,
        runtimePolicy.cadenceFloor ?? 0.8,
        runtimePolicy.cadenceCeil ?? 1.35
      ),
      spreadMultiplier: clamp(
        1 + caution * 0.45 - aggression * 0.12,
        runtimePolicy.spreadFloor ?? 0.9,
        runtimePolicy.spreadCeil ?? 1.6
      ),
      driftMultiplier: clamp(
        1 + caution * 0.28,
        runtimePolicy.driftFloor ?? 0.9,
        runtimePolicy.driftCeil ?? 1.45
      ),
      verticalBiasPx: Math.round(clamp(
        (0.52 - predictions.pressure) * 48 + (predictions.collision - 0.5) * -24,
        runtimePolicy.verticalBiasMinPx ?? -26,
        runtimePolicy.verticalBiasMaxPx ?? 34
      )),
      volleySizeBonus: aggression > 0.55 && caution < 0.45 ? 1 : 0,
      pathPattern: caution >= 0.55
        ? 'single'
        : (aggression >= 0.58 ? (runtimePolicy.aggressivePattern ?? 'wings') : null),
      idlePattern: caution >= 0.55
        ? (runtimePolicy.cautiousPattern ?? 'alternating_rows')
        : (aggression >= 0.58 ? (runtimePolicy.aggressivePattern ?? 'wings') : null),
    };
  }
}
