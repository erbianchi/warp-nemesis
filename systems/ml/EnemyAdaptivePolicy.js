/** @module EnemyAdaptivePolicy */

import { ENEMIES } from '../../config/enemies.config.js';
import {
  ENEMY_LEARNING_CONFIG,
} from '../../config/enemyLearning.config.js';
import { EnemyDatasetStore } from './EnemyDatasetStore.js';
import { EnemyFeatureEncoder } from './EnemyFeatureEncoder.js';
import { EnemyLearningStore } from './EnemyLearningStore.js';
import { LogisticRegressor } from './LogisticRegressor.js';
import { buildSquadSnapshot } from './EnemyPolicyMath.js';
import { SquadDatasetStore } from './SquadDatasetStore.js';
import { SquadFeatureEncoder } from './SquadFeatureEncoder.js';
import { SquadLearningStore } from './SquadLearningStore.js';
import { SquadPolicyNetwork } from './SquadPolicyNetwork.js';
import { EnemyTelemetryCollector } from './EnemyTelemetryCollector.js';
import { EnemyPositionEvaluator } from './EnemyPositionEvaluator.js';
import {
  ACTION_MODE_COUNT,
  ACTION_MODE_OFFSET,
  DanceWaypointNetwork,
  stripActionModes,
} from './DanceWaypointNetwork.js';
import { DanceWaypointStore } from './DanceWaypointStore.js';
import { clamp, normalizeInteger } from '../../utils/math.js';

export { resolveAdaptiveMovePlan } from './EnemyPositionEvaluator.js';

function normalizeSampleWeights(weights = []) {
  if (!Array.isArray(weights) || weights.length === 0) return [];
  const normalized = weights.map(weight => Math.max(0, Number(weight) || 0));
  const meanWeight = normalized.reduce((sum, weight) => sum + weight, 0) / Math.max(1, normalized.length);
  if (meanWeight <= 0) return new Array(normalized.length).fill(1);
  return normalized.map(weight => weight / meanWeight);
}

function combineSampleWeights(...weightSets) {
  const size = weightSets.find(weights => Array.isArray(weights) && weights.length > 0)?.length ?? 0;
  if (size <= 0) return [];

  const combined = new Array(size).fill(1);
  for (const weightSet of weightSets) {
    if (!Array.isArray(weightSet) || weightSet.length !== size) continue;
    for (let index = 0; index < size; index += 1) {
      combined[index] *= Math.max(0, Number(weightSet[index]) || 0);
    }
  }

  return normalizeSampleWeights(combined);
}

function buildSoftClassBalanceWeights(labels = []) {
  if (!Array.isArray(labels) || labels.length === 0) return [];

  const positiveMass = labels.reduce((sum, label) => sum + clamp(Number(label) || 0, 0, 1), 0);
  const negativeMass = labels.length - positiveMass;
  if (positiveMass <= 0 || negativeMass <= 0) {
    return new Array(labels.length).fill(1);
  }

  const positiveWeight = labels.length / (2 * positiveMass);
  const negativeWeight = labels.length / (2 * negativeMass);
  return normalizeSampleWeights(labels.map(label => {
    const clampedLabel = clamp(Number(label) || 0, 0, 1);
    return clampedLabel * positiveWeight + (1 - clampedLabel) * negativeWeight;
  }));
}

function resolveTelemetryTrainingKey(meta = {}) {
  const telemetryLevelId = normalizeInteger(meta.telemetryLevelId);
  if (telemetryLevelId > 0) return `telemetry:${telemetryLevelId}`;

  const levelNumber = normalizeInteger(meta.levelNumber);
  return levelNumber > 0 ? `legacy-level:${levelNumber}` : null;
}

function filterRecentTelemetryExamples(examples = [], windowSize = ENEMY_LEARNING_CONFIG.recentTelemetryLevels ?? 3) {
  const normalizedWindowSize = Math.max(1, normalizeInteger(windowSize, 3));
  if (!Array.isArray(examples) || examples.length <= 1) return Array.isArray(examples) ? [...examples] : [];

  const keepKeys = new Set();
  for (let index = examples.length - 1; index >= 0 && keepKeys.size < normalizedWindowSize; index -= 1) {
    const key = resolveTelemetryTrainingKey(examples[index]?.meta);
    if (!key) continue;
    keepKeys.add(key);
  }

  if (keepKeys.size === 0) return [...examples];
  return examples.filter(example => keepKeys.has(resolveTelemetryTrainingKey(example?.meta)));
}

function buildTelemetryRecencyWeights(examples = []) {
  if (!Array.isArray(examples) || examples.length === 0) return [];

  const orderedKeys = [];
  const seenKeys = new Set();
  for (const example of examples) {
    const key = resolveTelemetryTrainingKey(example?.meta);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    orderedKeys.push(key);
  }

  if (orderedKeys.length === 0) return new Array(examples.length).fill(1);
  const rankByKey = new Map(orderedKeys.map((key, index) => [key, index + 1]));
  return normalizeSampleWeights(examples.map(example => (
    rankByKey.get(resolveTelemetryTrainingKey(example?.meta)) ?? 1
  )));
}

function resolveExampleOutcomeMagnitude(example = {}) {
  const storedMagnitude = Number(example?.meta?.outcomeMagnitude);
  if (Number.isFinite(storedMagnitude)) {
    return clamp(storedMagnitude, 0, 1);
  }

  return clamp(Math.max(
    Math.abs((example?.labels?.win ?? 0.5) - 0.5) * 2,
    Math.abs((example?.labels?.survival ?? 0.5) - 0.5) * 2,
    clamp(example?.labels?.pressure ?? 0, 0, 1),
    clamp(example?.labels?.collision ?? 0, 0, 1),
    clamp(example?.labels?.bullet ?? 0, 0, 1)
  ), 0, 1);
}

function classifyTrainingExample(example = {}) {
  const collision = clamp(example?.labels?.collision ?? 0, 0, 1);
  const bullet = clamp(example?.labels?.bullet ?? 0, 0, 1);
  const pressure = clamp(example?.labels?.pressure ?? 0, 0, 1);
  const survival = clamp(example?.labels?.survival ?? 0, 0, 1);

  if (collision > 0 || bullet > 0) return 'terminalNegative';
  if (pressure > 0) return 'eventfulPositive';
  if (survival >= 0.75) return 'safePositive';
  return 'neutral';
}

function compareInformativeExamples(left, right) {
  const leftTelemetryId = normalizeInteger(left?.example?.meta?.telemetryLevelId ?? left?.example?.meta?.levelNumber);
  const rightTelemetryId = normalizeInteger(right?.example?.meta?.telemetryLevelId ?? right?.example?.meta?.levelNumber);
  if (rightTelemetryId !== leftTelemetryId) return rightTelemetryId - leftTelemetryId;

  if ((right?.outcomeMagnitude ?? 0) !== (left?.outcomeMagnitude ?? 0)) {
    return (right?.outcomeMagnitude ?? 0) - (left?.outcomeMagnitude ?? 0);
  }

  const rightHorizon = normalizeInteger(right?.example?.meta?.horizonMs);
  const leftHorizon = normalizeInteger(left?.example?.meta?.horizonMs);
  if (rightHorizon !== leftHorizon) return rightHorizon - leftHorizon;

  return (left?.index ?? 0) - (right?.index ?? 0);
}

function buildOutcomeMagnitudeWeights(examples = []) {
  if (!Array.isArray(examples) || examples.length === 0) return [];

  return normalizeSampleWeights(examples.map((example) => {
    const labels = example?.labels ?? {};
    const outcomeMagnitude = resolveExampleOutcomeMagnitude(example);
    let weight = 0.5 + (2.5 * outcomeMagnitude);

    if ((labels.collision ?? 0) > 0 || (labels.bullet ?? 0) > 0) {
      weight *= 5;
    } else if ((labels.pressure ?? 0) > 0) {
      weight *= 4;
    } else if ((labels.survival ?? 0) >= 0.75) {
      weight *= 2;
    } else {
      weight *= 0.5;
    }

    return weight;
  }));
}

function curateEnemyTrainingExamples(
  examples = [],
  limit = ENEMY_LEARNING_CONFIG.maxExamplesPerEnemyType ?? 480
) {
  if (!Array.isArray(examples) || examples.length === 0) return [];

  const wrapped = examples.map((example, index) => ({
    example,
    index,
    category: classifyTrainingExample(example),
    outcomeMagnitude: resolveExampleOutcomeMagnitude(example),
  }));

  const groups = {
    eventfulPositive: [],
    terminalNegative: [],
    safePositive: [],
    neutral: [],
  };

  for (const entry of wrapped) {
    groups[entry.category].push(entry);
  }

  Object.values(groups).forEach(entries => entries.sort(compareInformativeExamples));

  const normalizedLimit = Math.max(1, normalizeInteger(limit, 480));
  const baselineCount = groups.eventfulPositive.length + groups.terminalNegative.length;
  const safeLimit = baselineCount > 0
    ? baselineCount
    : Math.min(groups.safePositive.length, normalizedLimit);
  const neutralLimit = baselineCount > 0
    ? Math.floor(baselineCount * 0.25)
    : 0;

  const selected = [
    ...groups.eventfulPositive,
    ...groups.terminalNegative,
    ...groups.safePositive.slice(0, safeLimit),
    ...groups.neutral.slice(0, neutralLimit),
  ];

  const categoryPriority = new Map([
    ['eventfulPositive', 0],
    ['terminalNegative', 1],
    ['safePositive', 2],
    ['neutral', 3],
  ]);
  selected.sort((left, right) => (
    (categoryPriority.get(left.category) ?? 99) - (categoryPriority.get(right.category) ?? 99)
    || compareInformativeExamples(left, right)
  ));

  return selected.slice(0, normalizedLimit).map(entry => entry.example);
}

function reportTrainingFailure(context, error) {
  globalThis.console?.error?.(`[EnemyAdaptivePolicy] ${context} failed.`, error);
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

function getEnemyDatasetTelemetryCursor(datasetState = {}) {
  return Object.values(datasetState.enemyExamples ?? {}).reduce((maxValue, examples) => (
    examples.reduce((innerMax, example) => (
      Math.max(innerMax, Math.max(0, Math.round(example?.meta?.telemetryLevelId ?? 0)))
    ), maxValue)
  ), 0);
}

function getSquadDatasetTelemetryCursor(datasetState = {}) {
  return (datasetState.examples ?? []).reduce((maxValue, example) => (
    Math.max(maxValue, Math.max(0, Math.round(example?.meta?.telemetryLevelId ?? 0)))
  ), 0);
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
    this._danceStore = options.danceStore ?? new DanceWaypointStore(
      (options.config ?? ENEMY_LEARNING_CONFIG).neuralDance?.storageKey
    );
    this._danceNetwork = null;
    this._lastPlayerStyleProfile = null;
    this._backgroundTrainingPromise = Promise.resolve();
    this._telemetryLevelCursor = 0;
    this._runtimeRegressorCache = new Map();
    this._positionEvaluator = new EnemyPositionEvaluator(this);
    this._telemetryCollector = new EnemyTelemetryCollector(this);
  }

  load() {
    this._state = this._store.load();
    this._squadState = this._squadStore.load();
    this._runtimeRegressorCache.clear();
    const enemyDataset = this._datasetStore.load();
    const squadDataset = this._squadDatasetStore.load();
    this._telemetryLevelCursor = Math.max(
      getEnemyDatasetTelemetryCursor(enemyDataset),
      getSquadDatasetTelemetryCursor(squadDataset),
      this._telemetryLevelCursor
    );
    const danceState = this._danceStore.load();
    this._danceNetwork = new DanceWaypointNetwork({
      ...danceState,
      hiddenUnits: this._config.neuralDance?.hiddenUnits ?? 16,
    });
    return this.getSnapshot();
  }

  _nextTelemetryLevelId() {
    this._telemetryLevelCursor = Math.max(0, Math.round(this._telemetryLevelCursor ?? 0)) + 1;
    return this._telemetryLevelCursor;
  }

  /**
   * Return the loaded DanceWaypointNetwork instance.
   * Used by DanceGenerator (injected at GameScene level).
   * @returns {DanceWaypointNetwork}
   */
  getDanceNetwork() {
    if (!this._danceNetwork) this.load();
    return this._danceNetwork;
  }

  getEncoder() {
    return this._encoder;
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
      this._runtimeRegressorCache.delete(enemyType);
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
    return this._telemetryCollector.createRunSession(options);
  }

  _buildEnemyTrainingSet(examples = []) {
    const filteredExamples = filterRecentTelemetryExamples(
      examples,
      this._config.recentTelemetryLevels ?? 3
    );
    const curatedExamples = curateEnemyTrainingExamples(
      filteredExamples,
      this._config.maxExamplesPerEnemyType ?? 480
    );
    const vectors = curatedExamples.map(example => example.vector ?? []);
    const winLabels = curatedExamples.map(example => example.labels?.win ?? 0);
    const survivalLabels = curatedExamples.map(example => example.labels?.survival ?? 0);
    const pressureLabels = curatedExamples.map(example => example.labels?.pressure ?? 0);
    const collisionLabels = curatedExamples.map(example => example.labels?.collision ?? 0);
    const bulletLabels = curatedExamples.map(example => example.labels?.bullet ?? 0);
    const recencyWeights = buildTelemetryRecencyWeights(curatedExamples);
    const outcomeMagnitudeWeights = buildOutcomeMagnitudeWeights(curatedExamples);
    const trainingWeights = combineSampleWeights(recencyWeights, outcomeMagnitudeWeights);

    return {
      examples: curatedExamples,
      vectors,
      winLabels,
      survivalLabels,
      pressureLabels,
      collisionLabels,
      bulletLabels,
      recencyWeights,
      outcomeMagnitudeWeights,
      trainingWeights,
      collisionWeights: combineSampleWeights(
        trainingWeights,
        buildSoftClassBalanceWeights(collisionLabels)
      ),
      bulletWeights: combineSampleWeights(
        trainingWeights,
        buildSoftClassBalanceWeights(bulletLabels)
      ),
    };
  }

  _buildEnemyModelState(trainingSet, regressors) {
    const divisor = Math.max(1, trainingSet.examples.length);
    const scores = trainingSet.examples.reduce((accumulator, example) => ({
      win: accumulator.win + regressors.win.predictProbability(example.vector),
      survival: accumulator.survival + regressors.survival.predictProbability(example.vector),
      pressure: accumulator.pressure + regressors.pressure.predictProbability(example.vector),
      collision: accumulator.collision + regressors.collision.predictProbability(example.vector),
      bullet: accumulator.bullet + regressors.bullet.predictProbability(example.vector),
    }), {
      win: 0,
      survival: 0,
      pressure: 0,
      collision: 0,
      bullet: 0,
    });

    return {
      winModel: regressors.win.getState(),
      survivalModel: regressors.survival.getState(),
      pressureModel: regressors.pressure.getState(),
      collisionModel: regressors.collision.getState(),
      bulletModel: regressors.bullet.getState(),
      sampleCount: trainingSet.examples.length,
      lastScores: {
        win: scores.win / divisor,
        survival: scores.survival / divisor,
        pressure: scores.pressure / divisor,
        collision: scores.collision / divisor,
        bullet: scores.bullet / divisor,
      },
    };
  }

  _trainEnemyModelFromExamples(examples = []) {
    const trainingSet = this._buildEnemyTrainingSet(examples);
    if (trainingSet.examples.length === 0) return createDefaultModel();

    const regressors = {
      win: new LogisticRegressor(),
      survival: new LogisticRegressor(),
      pressure: new LogisticRegressor(),
      collision: new LogisticRegressor(),
      bullet: new LogisticRegressor(),
    };
    const baseOptions = {
      learningRate: this._config.learningRate,
      regularization: this._config.regularization,
      epochs: this._config.trainingEpochsPerRun,
    };

    regressors.win.trainBatch(trainingSet.vectors, trainingSet.winLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.trainingWeights,
    });
    regressors.survival.trainBatch(trainingSet.vectors, trainingSet.survivalLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.trainingWeights,
    });
    regressors.pressure.trainBatch(trainingSet.vectors, trainingSet.pressureLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.trainingWeights,
    });
    regressors.collision.trainBatch(trainingSet.vectors, trainingSet.collisionLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.collisionWeights,
    });
    regressors.bullet.trainBatch(trainingSet.vectors, trainingSet.bulletLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.bulletWeights,
    });

    return this._buildEnemyModelState(trainingSet, regressors);
  }

  async _trainEnemyModelFromExamplesAsync(examples = []) {
    const trainingSet = this._buildEnemyTrainingSet(examples);
    if (trainingSet.examples.length === 0) return createDefaultModel();

    const regressors = {
      win: new LogisticRegressor(),
      survival: new LogisticRegressor(),
      pressure: new LogisticRegressor(),
      collision: new LogisticRegressor(),
      bullet: new LogisticRegressor(),
    };
    const baseOptions = {
      learningRate: this._config.learningRate,
      regularization: this._config.regularization,
      epochs: this._config.trainingEpochsPerRun,
    };

    await regressors.win.trainBatchAsync(trainingSet.vectors, trainingSet.winLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.trainingWeights,
    });
    await regressors.survival.trainBatchAsync(trainingSet.vectors, trainingSet.survivalLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.trainingWeights,
    });
    await regressors.pressure.trainBatchAsync(trainingSet.vectors, trainingSet.pressureLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.trainingWeights,
    });
    await regressors.collision.trainBatchAsync(trainingSet.vectors, trainingSet.collisionLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.collisionWeights,
    });
    await regressors.bullet.trainBatchAsync(trainingSet.vectors, trainingSet.bulletLabels, {
      ...baseOptions,
      sampleWeights: trainingSet.bulletWeights,
    });

    return this._buildEnemyModelState(trainingSet, regressors);
  }

  _createRuntimeRegressorBundle(enemyType) {
    const modelState = this._ensureModel(enemyType);
    const expectedInputSize = this._encoder.getFeatureNames().length;
    const buildRegressor = (state, label) => {
      const regressor = new LogisticRegressor({
        ...state,
        inputSize: state?.inputSize ?? expectedInputSize,
      });
      try {
        regressor._assertFeatureDimension(expectedInputSize);
        return regressor;
      } catch (error) {
        reportTrainingFailure(`invalid runtime ${label} regressor for "${enemyType}"`, error);
        return new LogisticRegressor({ inputSize: expectedInputSize });
      }
    };

    return {
      modelState,
      win: buildRegressor(modelState.winModel, 'win'),
      survival: buildRegressor(modelState.survivalModel, 'survival'),
      pressure: buildRegressor(modelState.pressureModel, 'pressure'),
      collision: buildRegressor(modelState.collisionModel, 'collision'),
      bullet: buildRegressor(modelState.bulletModel, 'bullet'),
    };
  }

  _getRuntimeRegressorBundle(enemyType) {
    const modelState = this._ensureModel(enemyType);
    const cachedBundle = this._runtimeRegressorCache.get(enemyType);
    if (cachedBundle?.modelState === modelState) return cachedBundle;

    const bundle = this._createRuntimeRegressorBundle(enemyType);
    this._runtimeRegressorCache.set(enemyType, bundle);
    return bundle;
  }

  _buildEnemyStateFromDataset(datasetState) {
    const nextState = cloneJson(this._state ?? this._store.load());

    for (const [enemyType, enemyConfig] of Object.entries(this._enemyConfigs)) {
      if (!enemyConfig?.adaptive?.enabled) continue;

      nextState.enemyModels[enemyType] = this._trainEnemyModelFromExamples(
        datasetState.enemyExamples?.[enemyType] ?? []
      );
    }

    return nextState;
  }

  async _buildEnemyStateFromDatasetAsync(datasetState) {
    const nextState = cloneJson(this._state ?? this._store.load());

    for (const [enemyType, enemyConfig] of Object.entries(this._enemyConfigs)) {
      if (!enemyConfig?.adaptive?.enabled) continue;

      nextState.enemyModels[enemyType] = await this._trainEnemyModelFromExamplesAsync(
        datasetState.enemyExamples?.[enemyType] ?? []
      );

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
      .catch((error) => {
        reportTrainingFailure('background retraining queue', error);
        return null;
      })
      .then(async () => {
        try {
          await new Promise(resolve => globalThis.setTimeout?.(resolve, 0) ?? resolve());
          const latestEnemyDataset = this._datasetStore.load();
          const latestSquadDataset = this._squadDatasetStore.load();
          const nextEnemyState = await this._buildEnemyStateFromDatasetAsync(latestEnemyDataset);
          const nextSquadState = await this._buildLevel2SquadStateFromDatasetAsync(latestSquadDataset);
          const nextDanceState = await this._buildDanceNetworkFromDatasetAsync(latestEnemyDataset);
          this._store.stage(nextEnemyState);
          this._squadStore.stage(nextSquadState);
          this._danceStore.stage(nextDanceState);
        } catch (error) {
          reportTrainingFailure('background retraining', error);
          throw error;
        }
      });
  }

  _buildWeightedEnemyDataset(datasetState, records = [], meta = {}, extraWeight = 0) {
    const duplicateCount = Math.max(0, Math.round(extraWeight));
    if (duplicateCount <= 0) return datasetState;

    const nextState = cloneJson(datasetState);
    const levelNumber = Math.max(1, Math.round(meta.levelNumber ?? 1));
    const telemetryLevelId = Math.max(0, Math.round(meta.telemetryLevelId ?? 0));
    const outcome = meta.outcome === 'enemy_win' ? 'enemy_win' : 'player_win';
    const defaultWin = outcome === 'enemy_win' ? 1 : 0;

    for (const record of records) {
      if (!nextState.enemyExamples?.[record.enemyType]) continue;

      for (const example of record.examples ?? []) {
        for (let copyIndex = 0; copyIndex < duplicateCount; copyIndex += 1) {
          nextState.enemyExamples[record.enemyType].push({
            vector: cloneJson(example.vector ?? []),
            labels: {
              win: example.labels?.win ?? defaultWin,
              survival: example.labels?.survival ?? 0,
              pressure: example.labels?.pressure ?? 0,
              collision: example.labels?.collision ?? 0,
              bullet: example.labels?.bullet ?? 0,
            },
            meta: {
              levelNumber,
              telemetryLevelId,
              outcome,
              squadId: record.summary?.squadId ?? null,
              waveId: record.summary?.waveId ?? null,
              reason: example.meta?.reason ?? 'heartbeat',
              actionMode: example.meta?.actionMode ?? 'hold',
              threatBucket: example.meta?.threatBucket ?? 0,
              shieldBucket: example.meta?.shieldBucket ?? 0,
              horizonMs: example.meta?.horizonMs ?? 0,
              outcomeMagnitude: example.meta?.outcomeMagnitude ?? 0,
            },
          });
        }
      }
    }

    return nextState;
  }

  _buildWeightedSquadDataset(datasetState, records = [], meta = {}, extraWeight = 0) {
    const duplicateCount = Math.max(0, Math.round(extraWeight));
    if (duplicateCount <= 0) return datasetState;

    const nextState = cloneJson(datasetState);
    const levelNumber = Math.max(1, Math.round(meta.levelNumber ?? 1));
    const telemetryLevelId = Math.max(0, Math.round(meta.telemetryLevelId ?? 0));
    const outcome = meta.outcome === 'enemy_win' ? 'enemy_win' : 'player_win';
    const defaultWin = outcome === 'enemy_win' ? 1 : 0;

    for (const record of records) {
      for (const example of record.examples ?? []) {
        for (let copyIndex = 0; copyIndex < duplicateCount; copyIndex += 1) {
          nextState.examples.push({
            vector: cloneJson(example.vector ?? []),
            labels: {
              win: example.labels?.win ?? defaultWin,
              pressure: example.labels?.pressure ?? 0,
              collision: example.labels?.collision ?? 0,
            },
            meta: {
              levelNumber,
              telemetryLevelId,
              squadId: record.squadId ?? null,
              squadTemplateId: record.squadTemplateId ?? null,
              formation: record.formation ?? null,
              dance: record.dance ?? null,
              outcome,
              overlay: record.overlay ?? false,
            },
          });
        }
      }
    }

    return nextState;
  }

  _applyImmediateTraining(enemyDatasetState, squadDatasetState) {
    const nextEnemyState = this._buildEnemyStateFromDataset(enemyDatasetState);
    const nextSquadState = this._buildLevel2SquadStateFromDataset(squadDatasetState);
    const nextDanceState = this._buildDanceNetworkFromDataset(enemyDatasetState);

    this._state = this._store.save(nextEnemyState);
    this._squadState = this._squadStore.save(nextSquadState);
    this._danceStore.save(nextDanceState);
    this._runtimeRegressorCache.clear();
    this._danceNetwork = new DanceWaypointNetwork({
      ...nextDanceState,
      hiddenUnits: this._config.neuralDance?.hiddenUnits ?? 16,
    });

    return this.getSnapshot();
  }

  // ── Dance network training ─────────────────────────────────────────────────

  /**
   * Extract "effective moment" examples from the enemy dataset and train the
   * DanceWaypointNetwork on them.
   *
   * Effective = survival > survivalFloor AND pressure > pressureFloor.
   * Label     = action-mode one-hot extracted from the original feature vector.
   * Input     = feature vector with the action-mode block stripped.
   *
   * @param {object} datasetState — result of EnemyDatasetStore.load()
   * @returns {object}  DanceWaypointNetwork serialised state
   */
  _buildDanceNetworkFromDataset(datasetState) {
    const { vectors, labels } = this._extractDanceExamples(datasetState);
    if (vectors.length === 0) return this._danceNetwork?.getState() ?? {};

    const cfg = this._config.neuralDance ?? {};
    const network = new DanceWaypointNetwork({
      ...(this._danceNetwork?.getState() ?? {}),
      hiddenUnits: cfg.hiddenUnits ?? 16,
    });
    const result = network.trainBatch(vectors, labels, {
      learningRate:  cfg.learningRate  ?? 0.08,
      regularization: cfg.regularization ?? 0.001,
      epochs:         cfg.epochs ?? 10,
    });
    network.sampleCount  = vectors.length;
    network.lastAccuracy = result.accuracy;
    return network.getState();
  }

  async _buildDanceNetworkFromDatasetAsync(datasetState) {
    const { vectors, labels } = this._extractDanceExamples(datasetState);
    if (vectors.length === 0) return this._danceNetwork?.getState() ?? {};

    const cfg = this._config.neuralDance ?? {};
    const network = new DanceWaypointNetwork({
      ...(this._danceNetwork?.getState() ?? {}),
      hiddenUnits: cfg.hiddenUnits ?? 16,
    });
    const result = await network.trainBatchAsync(vectors, labels, {
      learningRate:   cfg.learningRate   ?? 0.08,
      regularization: cfg.regularization ?? 0.001,
      epochs:         cfg.epochs ?? 10,
    });
    network.sampleCount  = vectors.length;
    network.lastAccuracy = result.accuracy;
    return network.getState();
  }

  /**
   * Filter the dataset for effective moments and build stripped input/label pairs.
   * @param {object} datasetState
   * @returns {{ vectors: number[][], labels: number[][] }}
   */
  _extractDanceExamples(datasetState) {
    const cfg            = this._config.neuralDance ?? {};
    const survivalFloor  = cfg.survivalFloor  ?? 0.55;
    const pressureFloor  = cfg.pressureFloor  ?? 0.25;
    const minSamples     = cfg.minSamplesForActivation ?? 40;

    const vectors = [];
    const labels  = [];

    for (const examples of Object.values(datasetState.enemyExamples ?? {})) {
      for (const example of examples) {
        if ((example.labels?.survival ?? 0) < survivalFloor) continue;
        if ((example.labels?.pressure ?? 0) < pressureFloor) continue;
        const modeOneHot = example.vector.slice(
          ACTION_MODE_OFFSET,
          ACTION_MODE_OFFSET + ACTION_MODE_COUNT
        );
        if (modeOneHot.every(v => v === 0)) continue; // malformed sample
        vectors.push(stripActionModes(example.vector));
        labels.push(modeOneHot);
      }
    }

    if (vectors.length < minSamples) return { vectors: [], labels: [] };
    return { vectors, labels };
  }

  /**
   * @param {{buildTrainingRecords: Function, destroy?: Function}} session
   * @param {'enemy_win'|'player_win'} outcome
   * @returns {object}
   */
  trainFromSession(session, outcome, options = {}) {
    if (!this._state) this.load();
    try {
      const records = session?.buildTrainingRecords?.(outcome) ?? [];
      const squadRecords = session?.buildSquadTrainingRecords?.(outcome) ?? [];
      const playerStyleProfile = session?.buildPlayerStyleProfile?.() ?? null;
      const levelNumber = Math.max(1, Math.round(session?._levelNumber ?? 1));
      const telemetryLevelId = this._nextTelemetryLevelId();
      const enemyDataset = this._datasetStore.appendTrainingRecords(records, {
        outcome,
        levelNumber,
        telemetryLevelId,
      });
      const squadDataset = this._squadDatasetStore.appendTrainingRecords(squadRecords, {
        outcome,
        levelNumber,
        telemetryLevelId,
      });
      this._lastPlayerStyleProfile = playerStyleProfile;

      const shouldImmediateTransitionTrain = Boolean(options?.immediate)
        || Math.max(0, Math.round(options?.nextLevelNumber ?? 0)) === (this._config.level2Number ?? 2);
      if (shouldImmediateTransitionTrain) {
        const extraWeight = this._config.levelTransitionTraining?.currentRunExtraWeight ?? 0;
        const weightedEnemyDataset = this._buildWeightedEnemyDataset(enemyDataset, records, {
          outcome,
          levelNumber,
          telemetryLevelId,
        }, extraWeight);
        const weightedSquadDataset = this._buildWeightedSquadDataset(squadDataset, squadRecords, {
          outcome,
          levelNumber,
          telemetryLevelId,
        }, extraWeight);
        return {
          ...this._applyImmediateTraining(weightedEnemyDataset, weightedSquadDataset),
          playerStyleProfile,
          telemetryLevelId,
          usedImmediateTraining: true,
        };
      }

      if (isBackgroundTrainingRuntime()) {
        this._scheduleBackgroundRetraining();
        return {
          ...this.getSnapshot(),
          playerStyleProfile,
          telemetryLevelId,
          usedImmediateTraining: false,
        };
      }

      this._state = this._store.save(this._buildEnemyStateFromDataset(enemyDataset));
      this._squadState = this._squadStore.save(this._buildLevel2SquadStateFromDataset(squadDataset));
      this._runtimeRegressorCache.clear();
      return {
        ...this.getSnapshot(),
        playerStyleProfile,
        telemetryLevelId,
        usedImmediateTraining: false,
      };
    } catch (error) {
      reportTrainingFailure('trainFromSession', error);
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

  rankBehaviors(options, limit = 1) {
    return this._positionEvaluator.rankBehaviors(options, limit);
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
    return this._positionEvaluator.resolveBehavior(options);
  }

  resolveMovePlan(enemy, baseX, options = {}) {
    return this._positionEvaluator.resolveMovePlan(enemy, baseX, options);
  }

  scoreCurrentPosition(options) {
    return this._positionEvaluator.scoreCurrentPosition(options);
  }

  /**
   * Resolve candidate speeds for a given class without duplicating config math
   * in entity classes.
   * @param {string} enemyType
   * @returns {number[]}
   */
  getSpeedCandidates(enemyType) {
    return this._positionEvaluator.getSpeedCandidates(enemyType);
  }

  /**
   * @returns {number[]}
   */
  getPositionOffsets() {
    return this._positionEvaluator.getPositionOffsets();
  }

  /**
   * @returns {number[]}
   */
  getVerticalOffsets() {
    return this._positionEvaluator.getVerticalOffsets();
  }

  evaluateSquadDirective(options = {}) {
    if (!this._squadState) this.load();

    const modelState = this._squadState?.squadModels?.level2 ?? {};
    if ((modelState.sampleCount ?? 0) <= 0) return null;

    const liveEnemies = (options.liveEnemies ?? []).filter(enemy => enemy?.active !== false && enemy?.alive !== false);
    if (liveEnemies.length === 0) return null;

    const services = options.services ?? liveEnemies[0]?.getRuntimeContext?.()?.getServices?.() ?? null;
    const scene = options.scene ?? null;
    const player = options.player ?? services?.player?.getSnapshot?.() ?? {
      x: scene?._getEnemyLearningPlayerSnapshot?.()?.x ?? services?.player?.get?.()?.x ?? scene?._player?.x ?? 0,
      y: scene?._getEnemyLearningPlayerSnapshot?.()?.y ?? services?.player?.get?.()?.y ?? scene?._player?.y ?? 0,
      hasShield: scene?._getEnemyLearningPlayerSnapshot?.()?.hasShield ?? false,
      shieldRatio: scene?._getEnemyLearningPlayerSnapshot?.()?.shieldRatio ?? 0,
      hpRatio: scene?._getEnemyLearningPlayerSnapshot?.()?.hpRatio ?? 1,
    };
    const weapon = options.weapon ?? services?.weapons?.getSnapshot?.() ?? scene?._weapons?.getLearningSnapshot?.() ?? {
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
