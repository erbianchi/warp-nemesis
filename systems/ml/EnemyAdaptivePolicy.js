/** @module EnemyAdaptivePolicy */

import { ENEMIES } from '../../config/enemies.config.js';
import {
  ENEMY_LEARNING_CONFIG,
} from '../../config/enemyLearning.config.js';
import { EnemyDatasetStore } from './EnemyDatasetStore.js';
import { EnemyCombatValueNetwork } from './EnemyCombatValueNetwork.js';
import { EnemyFeatureEncoder } from './EnemyFeatureEncoder.js';
import { EnemyLearningStore } from './EnemyLearningStore.js';
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
    combatNetwork: null,
    sampleCount: 0,
    lastScores: {
      survival: 0.5,
      offense: 0.5,
      collision: 0.5,
      bullet: 0.5,
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function blendMetric(fallback, learned, weight) {
  return fallback + ((learned - fallback) * weight);
}

function resolveSquadBlendWeight(config = {}, modelState = {}) {
  const runtimePolicy = config.squadRuntimePolicy ?? {};
  const minSamples = Math.max(1, normalizeInteger(runtimePolicy.tacticBlendMinSamples, 10));
  const maxSamples = Math.max(minSamples, normalizeInteger(runtimePolicy.tacticBlendMaxSamples, 140));
  const sampleCount = Math.max(0, normalizeInteger(modelState?.sampleCount, 0));
  if (maxSamples === minSamples) return sampleCount >= maxSamples ? 1 : 0;
  return clamp((sampleCount - minSamples) / (maxSamples - minSamples), 0, 1);
}

function buildHeuristicSquadPredictions({
  player = {},
  squad = {},
  stats = {},
  liveEnemies = [],
  closestEnemyDistance = 0,
  normalization = {},
  playerBullets = [],
}) {
  const diagonal = Math.max(1, normalization.diagonal ?? 1);
  const maxHp = Math.max(1, normalization.maxHpDamagePerSquad ?? 1);
  const maxShield = Math.max(1, normalization.maxShieldDamagePerSquad ?? 1);
  const spawnCount = Math.max(1, normalizeInteger(stats.spawnCount, liveEnemies.length || 1));
  const bulletPressure = clamp((playerBullets.length ?? 0) / 12, 0, 1);
  const idleExposure = (playerBullets.length ?? 0) === 0 ? 0.20 : 0;
  const distancePressure = clamp(1 - (closestEnemyDistance / diagonal), 0, 1);
  const hitPressure = clamp(
    ((stats.playerHitCount ?? 0) / spawnCount) * 0.6
    + ((stats.hpDamageToPlayer ?? 0) / maxHp) * 0.7
    + ((stats.shieldDamageToPlayer ?? 0) / maxShield) * 0.28,
    0,
    1
  );
  const collisionPain = clamp(
    ((stats.collisionDeathCount ?? 0) / spawnCount) * 0.8
    + bulletPressure * 0.16,
    0,
    1
  );
  const widthPressure = clamp(1 - ((squad.width ?? 0) / Math.max(120, normalization.width ?? 1)), 0, 1);
  const survivalMass = clamp(squad.aliveRatio ?? 1, 0, 1);
  const shieldTax = player?.hasShield ? 0.12 : 0;

  const pressure = clamp(
    hitPressure * 0.56
    + distancePressure * 0.26
    + survivalMass * 0.16
    + idleExposure
    - bulletPressure * 0.14
    - shieldTax,
    0,
    1
  );

  const collision = clamp(
    collisionPain * 0.72
    + widthPressure * 0.14
    + shieldTax * 0.5,
    0,
    1
  );

  const win = clamp(
    pressure * 0.58
    + survivalMass * 0.30
    + idleExposure * 0.14
    - collision * 0.28,
    0,
    1
  );

  return { win, pressure, collision, bulletPressure, widthPressure };
}

function resolveSquadDoctrine(predictions, context = {}, runtimePolicy = {}) {
  const aggression = clamp(
    predictions.pressure * 0.78 + predictions.win * 0.42 - predictions.collision * 0.58,
    0,
    1
  );
  const caution = clamp(
    predictions.collision * 1.08 + (context.bulletPressure ?? 0) * 0.32 - predictions.pressure * 0.18,
    0,
    1
  );
  const liveCount = Math.max(1, normalizeInteger(context.liveCount, context.spawnCount ?? 1));
  const smallWing = liveCount <= 2;
  const overlayRaptorWing = Boolean(context.overlay)
    && context.primaryEnemyType === 'raptor'
    && smallWing;
  const skirmSquad = context.primaryEnemyType === 'skirm' && liveCount >= 3;
  const idlePlayer = (context.bulletPressure ?? 0) <= 0.02;
  const width = context.squad?.width ?? 0;
  const wideFormation = width >= 140 || (smallWing && width >= 72);

  if (caution >= 0.72 || (context.bulletPressure ?? 0) >= 0.78) {
    return { doctrine: 'scatter', aggression, caution };
  }
  if (overlayRaptorWing) {
    if (aggression >= 0.62 && Math.abs(context.playerOffsetX ?? 0) <= 0.14 && caution <= 0.46) {
      return { doctrine: 'collapse', aggression, caution };
    }
    if (Math.abs(context.playerOffsetX ?? 0) >= 0.16 || caution >= 0.42) {
      return { doctrine: 'encircle', aggression, caution };
    }
    return { doctrine: 'crossfire', aggression, caution };
  }
  if (skirmSquad && idlePlayer && caution <= 0.62) {
    if (wideFormation && Math.abs(context.playerOffsetX ?? 0) <= 0.16) {
      return { doctrine: 'collapse', aggression, caution };
    }
    if (wideFormation || (context.squad?.aliveRatio ?? 1) >= 0.65) {
      return {
        doctrine: Math.abs(context.playerOffsetX ?? 0) >= 0.18 ? 'encircle' : 'crossfire',
        aggression,
        caution,
      };
    }
  }
  if (aggression >= 0.70 && wideFormation && (context.squad?.aliveRatio ?? 1) >= 0.55) {
    return { doctrine: 'encircle', aggression, caution };
  }
  if (aggression >= 0.64 && Math.abs(context.playerOffsetX ?? 0) <= 0.24) {
    return { doctrine: 'collapse', aggression, caution };
  }
  if (aggression >= 0.55 && wideFormation) {
    return { doctrine: 'crossfire', aggression, caution };
  }
  if (caution >= 0.50) {
    return { doctrine: 'feint', aggression, caution };
  }
  return { doctrine: 'suppress', aggression, caution };
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
    this._runtimeNetworkCache = new Map();
    this._positionEvaluator = new EnemyPositionEvaluator(this);
    this._telemetryCollector = new EnemyTelemetryCollector(this);
  }

  load() {
    this._state = this._store.load();
    this._squadState = this._squadStore.load();
    this._runtimeNetworkCache.clear();
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
      this._runtimeNetworkCache.delete(enemyType);
    }
    return this._state.enemyModels[enemyType];
  }

  /**
   * @param {string} enemyType
   * @returns {{ enabled: boolean, minSpeedScalar: number, maxSpeedScalar: number, sampleCount: number, predictedSurvival: number, predictedOffense: number, predictedEnemyWinRate: number, predictedPressure: number, predictedCollisionRisk: number, predictedBulletRisk: number }}
   */
  getModifiers(enemyType) {
    const adaptiveConfig = this._enemyConfigs[enemyType]?.adaptive;
    if (!adaptiveConfig?.enabled) {
      return {
        enabled: false,
        minSpeedScalar: 1,
        maxSpeedScalar: 1,
        sampleCount: 0,
        predictedSurvival: 0.5,
        predictedOffense: 0.5,
        predictedEnemyWinRate: 0.5,
        predictedPressure: 0.5,
        predictedCollisionRisk: 0.5,
        predictedBulletRisk: 0.5,
      };
    }

    const model = this._ensureModel(enemyType);
    const survival = model.lastScores?.survival ?? 0.5;
    const offense  = model.lastScores?.offense  ?? 0.5;
    const collision = model.lastScores?.collision ?? 0.5;
    const bullet = model.lastScores?.bullet ?? 0.5;
    return {
      enabled: true,
      minSpeedScalar: adaptiveConfig.minSpeedScalar ?? 1,
      maxSpeedScalar: adaptiveConfig.maxSpeedScalar ?? 1,
      sampleCount: model.sampleCount ?? 0,
      predictedSurvival: survival,
      predictedOffense:  offense,
      // Legacy aliases used by EnemyBase / adaptiveProfile
      predictedEnemyWinRate:  offense,
      predictedPressure:      offense,
      predictedCollisionRisk: collision,
      predictedBulletRisk:    bullet,
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
    const offenseWeights = this._config.combatNetwork?.offenseLabelWeights
      ?? { pressure: 0.35, win: 0.65 };
    const pressureW = offenseWeights.pressure ?? 0.35;
    const winW      = offenseWeights.win      ?? 0.65;

    const vectors        = curatedExamples.map(example => example.vector ?? []);
    const survivalLabels = curatedExamples.map(example => example.labels?.survival ?? 0);
    const offenseLabels  = curatedExamples.map(example =>
      clamp((example.labels?.pressure ?? 0) * pressureW + (example.labels?.win ?? 0) * winW, 0, 1)
    );
    const collisionLabels = curatedExamples.map(example => clamp(example.labels?.collision ?? 0, 0, 1));
    const bulletLabels = curatedExamples.map(example => clamp(example.labels?.bullet ?? 0, 0, 1));
    const recencyWeights        = buildTelemetryRecencyWeights(curatedExamples);
    const outcomeMagnitudeWeights = buildOutcomeMagnitudeWeights(curatedExamples);
    const trainingWeights       = combineSampleWeights(recencyWeights, outcomeMagnitudeWeights);

    return {
      examples: curatedExamples,
      vectors,
      survivalLabels,
      offenseLabels,
      collisionLabels,
      bulletLabels,
      recencyWeights,
      outcomeMagnitudeWeights,
      trainingWeights,
    };
  }

  _buildEnemyModelState(trainingSet, network) {
    const divisor = Math.max(1, trainingSet.examples.length);
    let totalSurvival = 0;
    let totalOffense  = 0;
    let totalCollision = 0;
    let totalBullet = 0;
    for (const example of trainingSet.examples) {
      const {
        survival,
        offense,
        collision,
        bullet,
      } = network.predict(example.vector);
      totalSurvival += survival;
      totalOffense  += offense;
      totalCollision += collision;
      totalBullet += bullet;
    }
    return {
      combatNetwork: network.getState(),
      sampleCount: trainingSet.examples.length,
      lastScores: {
        survival: totalSurvival / divisor,
        offense:  totalOffense  / divisor,
        collision: totalCollision / divisor,
        bullet: totalBullet / divisor,
      },
    };
  }

  _trainEnemyModelFromExamples(examples = [], enemyType = '') {
    const trainingSet = this._buildEnemyTrainingSet(examples);
    if (trainingSet.examples.length === 0) return createDefaultModel();

    const inputSize   = trainingSet.vectors[0]?.length ?? 0;
    const hiddenUnits = this._config.combatNetwork?.hiddenUnits ?? [48, 24, 12];
    const existingState = this._state?.enemyModels?.[enemyType]?.combatNetwork ?? null;
    const network = EnemyCombatValueNetwork.fromState(existingState, inputSize, hiddenUnits);

    network.trainBatch(
      trainingSet.vectors,
      trainingSet.survivalLabels,
      trainingSet.offenseLabels,
      trainingSet.trainingWeights,
      {
        learningRate:   this._config.combatNetwork?.learningRate   ?? 0.001,
        regularization: this._config.combatNetwork?.regularization ?? 0.0005,
        epochs:         this._config.combatNetwork?.epochs         ?? 8,
        collisionLabels: trainingSet.collisionLabels,
        bulletLabels: trainingSet.bulletLabels,
      }
    );
    network.sampleCount = trainingSet.examples.length;

    return this._buildEnemyModelState(trainingSet, network);
  }

  async _trainEnemyModelFromExamplesAsync(examples = [], enemyType = '') {
    const trainingSet = this._buildEnemyTrainingSet(examples);
    if (trainingSet.examples.length === 0) return createDefaultModel();

    const inputSize   = trainingSet.vectors[0]?.length ?? 0;
    const hiddenUnits = this._config.combatNetwork?.hiddenUnits ?? [48, 24, 12];
    const existingState = this._state?.enemyModels?.[enemyType]?.combatNetwork ?? null;
    const network = EnemyCombatValueNetwork.fromState(existingState, inputSize, hiddenUnits);

    await network.trainBatchAsync(
      trainingSet.vectors,
      trainingSet.survivalLabels,
      trainingSet.offenseLabels,
      trainingSet.trainingWeights,
      {
        learningRate:   this._config.combatNetwork?.learningRate   ?? 0.001,
        regularization: this._config.combatNetwork?.regularization ?? 0.0005,
        epochs:         this._config.combatNetwork?.epochs         ?? 8,
        collisionLabels: trainingSet.collisionLabels,
        bulletLabels: trainingSet.bulletLabels,
      }
    );
    network.sampleCount = trainingSet.examples.length;

    return this._buildEnemyModelState(trainingSet, network);
  }

  _createRuntimeCombatNetwork(enemyType) {
    const modelState    = this._ensureModel(enemyType);
    const inputSize     = this._encoder.getFeatureNames().length;
    const hiddenUnits   = this._config.combatNetwork?.hiddenUnits ?? [48, 24, 12];
    const networkState  = modelState.combatNetwork ?? null;
    const network = EnemyCombatValueNetwork.fromState(networkState, inputSize, hiddenUnits);
    return { modelState, network };
  }

  _getRuntimeCombatNetwork(enemyType) {
    const modelState = this._ensureModel(enemyType);
    const cached = this._runtimeNetworkCache.get(enemyType);
    if (cached?.modelState === modelState) return cached;
    const entry = this._createRuntimeCombatNetwork(enemyType);
    this._runtimeNetworkCache.set(enemyType, entry);
    return entry;
  }

  _buildEnemyStateFromDataset(datasetState) {
    const nextState = cloneJson(this._state ?? this._store.load());

    for (const [enemyType, enemyConfig] of Object.entries(this._enemyConfigs)) {
      if (!enemyConfig?.adaptive?.enabled) continue;

      nextState.enemyModels[enemyType] = this._trainEnemyModelFromExamples(
        datasetState.enemyExamples?.[enemyType] ?? [],
        enemyType
      );
    }

    return nextState;
  }

  async _buildEnemyStateFromDatasetAsync(datasetState) {
    const nextState = cloneJson(this._state ?? this._store.load());

    for (const [enemyType, enemyConfig] of Object.entries(this._enemyConfigs)) {
      if (!enemyConfig?.adaptive?.enabled) continue;

      nextState.enemyModels[enemyType] = await this._trainEnemyModelFromExamplesAsync(
        datasetState.enemyExamples?.[enemyType] ?? [],
        enemyType
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
    this._runtimeNetworkCache.clear();
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
      this._runtimeNetworkCache.clear();
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
    const playerBullets = options.playerBullets ?? services?.player?.getBullets?.() ?? [];
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
    const runtimePolicy = this._config.squadRuntimePolicy ?? {};
    const normalization = this._config.normalization ?? {};
    const heuristicPredictions = buildHeuristicSquadPredictions({
      player,
      squad,
      stats: {
        spawnCount: stats.spawnCount ?? liveEnemies.length,
        shotCount: stats.shotCount ?? 0,
        playerHitCount: stats.playerHitCount ?? 0,
        hpDamageToPlayer: stats.hpDamageToPlayer ?? 0,
        shieldDamageToPlayer: stats.shieldDamageToPlayer ?? 0,
        collisionDeathCount: stats.collisionDeathCount ?? 0,
      },
      liveEnemies,
      closestEnemyDistance: Number.isFinite(closestEnemyDistance) ? closestEnemyDistance : 0,
      normalization,
      playerBullets,
    });
    const learnedPredictions = network.predict(encoded.vector);
    const learnedWeight = resolveSquadBlendWeight(this._config, modelState);
    const predictions = {
      win: blendMetric(heuristicPredictions.win, learnedPredictions.win ?? 0.5, learnedWeight),
      pressure: blendMetric(heuristicPredictions.pressure, learnedPredictions.pressure ?? 0.5, learnedWeight),
      collision: blendMetric(heuristicPredictions.collision, learnedPredictions.collision ?? 0.5, learnedWeight),
    };
    const playerOffsetX = clamp(
      ((player?.x ?? squad.centroidX ?? 0) - (squad.centroidX ?? 0)) / Math.max(1, normalization.width ?? 1),
      -1,
      1
    );
    const {
      doctrine,
      aggression,
      caution,
    } = resolveSquadDoctrine(predictions, {
      bulletPressure: heuristicPredictions.bulletPressure,
      playerOffsetX,
      squad,
      overlay: Boolean(options.overlay),
      primaryEnemyType: options.primaryEnemyType ?? fallbackEnemy?.enemyType ?? 'skirm',
      spawnCount: stats.spawnCount ?? liveEnemies.length,
      liveCount: liveEnemies.length,
    }, runtimePolicy);
    const focusX = clamp(player?.x ?? squad.centroidX ?? 0, 24, (normalization.width ?? 0) - 24);
    const focusPull = clamp(
      0.24 + aggression * 0.42 - caution * 0.12,
      runtimePolicy.focusPullFloor ?? 0.18,
      runtimePolicy.focusPullCeil ?? 0.88
    );
    const flankOffsetPx = Math.round(clamp(
      58 + caution * 34 + Math.abs(playerOffsetX) * 46,
      runtimePolicy.flankOffsetFloorPx ?? 48,
      runtimePolicy.flankOffsetCeilPx ?? 128
    ));

    const doctrineConfig = {
      suppress: {
        pathPattern: runtimePolicy.suppressPattern ?? 'focus_lane',
        idlePattern: runtimePolicy.suppressPattern ?? 'focus_lane',
        slotSpacingMultiplier: 0.94,
        spreadMultiplier: clamp(0.96 + caution * 0.20, runtimePolicy.spreadFloor ?? 0.9, runtimePolicy.spreadCeil ?? 1.6),
        driftMultiplier: clamp(0.92 + caution * 0.18, runtimePolicy.driftFloor ?? 0.9, runtimePolicy.driftCeil ?? 1.45),
        verticalBiasPx: 8,
        rowShiftPx: 0,
        sideLaneSpreadBonusPx: 4,
        pathSpreadBonusPx: 0,
        volleySizeBonus: aggression > 0.56 ? 1 : 0,
      },
      crossfire: {
        pathPattern: runtimePolicy.crossfirePattern ?? 'crossfire',
        idlePattern: runtimePolicy.crossfirePattern ?? 'crossfire',
        slotSpacingMultiplier: 1.12,
        spreadMultiplier: clamp(1.16 + caution * 0.16, runtimePolicy.spreadFloor ?? 0.9, runtimePolicy.spreadCeil ?? 1.6),
        driftMultiplier: clamp(1.02 + caution * 0.12, runtimePolicy.driftFloor ?? 0.9, runtimePolicy.driftCeil ?? 1.45),
        verticalBiasPx: 10,
        rowShiftPx: 4,
        sideLaneSpreadBonusPx: 18,
        pathSpreadBonusPx: 10,
        volleySizeBonus: 1,
      },
      encircle: {
        pathPattern: runtimePolicy.encirclePattern ?? 'encircle',
        idlePattern: runtimePolicy.encirclePattern ?? 'encircle',
        slotSpacingMultiplier: 1.18,
        spreadMultiplier: clamp(1.22 + caution * 0.18, runtimePolicy.spreadFloor ?? 0.9, runtimePolicy.spreadCeil ?? 1.6),
        driftMultiplier: clamp(1.04 + caution * 0.16, runtimePolicy.driftFloor ?? 0.9, runtimePolicy.driftCeil ?? 1.45),
        verticalBiasPx: 14,
        rowShiftPx: 8,
        sideLaneSpreadBonusPx: 24,
        pathSpreadBonusPx: 16,
        volleySizeBonus: aggression > 0.64 ? 1 : 0,
      },
      collapse: {
        pathPattern: runtimePolicy.collapsePattern ?? 'collapse',
        idlePattern: runtimePolicy.collapsePattern ?? 'collapse',
        slotSpacingMultiplier: 0.86,
        spreadMultiplier: clamp(0.88 + caution * 0.16, runtimePolicy.spreadFloor ?? 0.9, runtimePolicy.spreadCeil ?? 1.6),
        driftMultiplier: clamp(0.94 + caution * 0.14, runtimePolicy.driftFloor ?? 0.9, runtimePolicy.driftCeil ?? 1.45),
        verticalBiasPx: 18,
        rowShiftPx: 12,
        sideLaneSpreadBonusPx: -4,
        pathSpreadBonusPx: -6,
        volleySizeBonus: 1,
      },
      feint: {
        pathPattern: runtimePolicy.feintPattern ?? 'stagger_pin',
        idlePattern: runtimePolicy.feintPattern ?? 'stagger_pin',
        slotSpacingMultiplier: 1.04,
        spreadMultiplier: clamp(1.06 + caution * 0.14, runtimePolicy.spreadFloor ?? 0.9, runtimePolicy.spreadCeil ?? 1.6),
        driftMultiplier: clamp(1.08 + caution * 0.20, runtimePolicy.driftFloor ?? 0.9, runtimePolicy.driftCeil ?? 1.45),
        verticalBiasPx: -6,
        rowShiftPx: -4,
        sideLaneSpreadBonusPx: 8,
        pathSpreadBonusPx: 6,
        volleySizeBonus: 0,
      },
      scatter: {
        pathPattern: runtimePolicy.scatterPattern ?? 'single',
        idlePattern: runtimePolicy.scatterPattern ?? 'single',
        slotSpacingMultiplier: 1.28,
        spreadMultiplier: clamp(1.28 + caution * 0.20, runtimePolicy.spreadFloor ?? 0.9, runtimePolicy.spreadCeil ?? 1.6),
        driftMultiplier: clamp(1.20 + caution * 0.18, runtimePolicy.driftFloor ?? 0.9, runtimePolicy.driftCeil ?? 1.45),
        verticalBiasPx: -18,
        rowShiftPx: -10,
        sideLaneSpreadBonusPx: 20,
        pathSpreadBonusPx: 14,
        volleySizeBonus: 0,
      },
    }[doctrine] ?? {
      pathPattern: runtimePolicy.suppressPattern ?? 'focus_lane',
      idlePattern: runtimePolicy.suppressPattern ?? 'focus_lane',
      slotSpacingMultiplier: 1,
      spreadMultiplier: 1,
      driftMultiplier: 1,
      verticalBiasPx: 0,
      rowShiftPx: 0,
      sideLaneSpreadBonusPx: 0,
      pathSpreadBonusPx: 0,
      volleySizeBonus: 0,
    };

    return {
      predictions,
      heuristicPredictions,
      learnedWeight,
      doctrine,
      aggression,
      caution,
      cadenceModifier: clamp(
        0.90
        + predictions.pressure * 0.24
        + predictions.win * 0.12
        - predictions.collision * 0.22
        + (doctrine === 'collapse' ? 0.10 : 0)
        + (doctrine === 'suppress' ? 0.05 : 0)
        - (doctrine === 'scatter' ? 0.10 : 0),
        runtimePolicy.cadenceFloor ?? 0.8,
        runtimePolicy.cadenceCeil ?? 1.35
      ),
      spreadMultiplier: doctrineConfig.spreadMultiplier,
      driftMultiplier: doctrineConfig.driftMultiplier,
      verticalBiasPx: Math.round(clamp(
        doctrineConfig.verticalBiasPx + (0.50 - predictions.pressure) * 14 + (predictions.collision - 0.5) * -12,
        runtimePolicy.verticalBiasMinPx ?? -26,
        runtimePolicy.verticalBiasMaxPx ?? 34
      )),
      volleySizeBonus: doctrineConfig.volleySizeBonus,
      pathPattern: doctrineConfig.pathPattern,
      idlePattern: doctrineConfig.idlePattern,
      focusX,
      focusPull,
      flankOffsetPx,
      slotSpacingMultiplier: doctrineConfig.slotSpacingMultiplier,
      pathSpreadBonusPx: doctrineConfig.pathSpreadBonusPx,
      sideLaneSpreadBonusPx: doctrineConfig.sideLaneSpreadBonusPx,
      rowShiftPx: doctrineConfig.rowShiftPx,
    };
  }
}
