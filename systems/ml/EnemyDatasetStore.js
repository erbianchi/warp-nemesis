/** @module EnemyDatasetStore */

import { ENEMIES } from '../../config/enemies.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { clamp, normalizeInteger, normalizeNumber } from '../../utils/math.js';

export const ENEMY_DATASET_STORAGE_KEY = ENEMY_LEARNING_CONFIG.datasetStorageKey;

function getBrowserStorage(storage) {
  if (storage) return storage;
  const browserStorage = globalThis.localStorage;
  if (!browserStorage?.getItem || !browserStorage?.setItem) return null;
  return browserStorage;
}

function normalizeExample(example = {}) {
  return {
    vector: Array.isArray(example.vector)
      ? example.vector.map(value => normalizeNumber(value, 0))
      : [],
    labels: {
      win: clamp(normalizeNumber(example.labels?.win, 0), 0, 1),
      survival: clamp(normalizeNumber(example.labels?.survival, 0), 0, 1),
      pressure: clamp(normalizeNumber(example.labels?.pressure, 0), 0, 1),
      collision: clamp(normalizeNumber(example.labels?.collision, 0), 0, 1),
      bullet: clamp(normalizeNumber(example.labels?.bullet, 0), 0, 1),
    },
    meta: {
      levelNumber: normalizeInteger(example.meta?.levelNumber),
      telemetryLevelId: normalizeInteger(example.meta?.telemetryLevelId),
      outcome: typeof example.meta?.outcome === 'string' ? example.meta.outcome : 'player_win',
      squadId: typeof example.meta?.squadId === 'string' ? example.meta.squadId : null,
      waveId: typeof example.meta?.waveId === 'string' ? example.meta.waveId : null,
      reason: typeof example.meta?.reason === 'string' ? example.meta.reason : 'heartbeat',
      actionMode: typeof example.meta?.actionMode === 'string' ? example.meta.actionMode : 'hold',
      threatBucket: normalizeInteger(example.meta?.threatBucket),
      shieldBucket: normalizeInteger(example.meta?.shieldBucket),
      horizonMs: normalizeInteger(example.meta?.horizonMs),
      outcomeMagnitude: clamp(normalizeNumber(example.meta?.outcomeMagnitude, 0), 0, 1),
    },
  };
}

function resolveTelemetryKey(meta = {}) {
  const telemetryLevelId = normalizeInteger(meta.telemetryLevelId);
  if (telemetryLevelId > 0) return `telemetry:${telemetryLevelId}`;

  const levelNumber = normalizeInteger(meta.levelNumber);
  return levelNumber > 0 ? `legacy-level:${levelNumber}` : null;
}

function filterRecentTelemetryLevels(examples = []) {
  const windowSize = Math.max(1, normalizeInteger(ENEMY_LEARNING_CONFIG.recentTelemetryLevels ?? 3));
  if (examples.length <= 1) return examples;

  const keepKeys = new Set();
  for (let index = examples.length - 1; index >= 0 && keepKeys.size < windowSize; index -= 1) {
    const key = resolveTelemetryKey(examples[index]?.meta);
    if (!key) continue;
    keepKeys.add(key);
  }

  if (keepKeys.size === 0) return examples;
  return examples.filter(example => keepKeys.has(resolveTelemetryKey(example?.meta)));
}

function trimExamples(examples = []) {
  const recentExamples = filterRecentTelemetryLevels(examples);
  const limit = Math.max(1, normalizeInteger(ENEMY_LEARNING_CONFIG.maxExamplesPerEnemyType));
  if (recentExamples.length <= limit) return recentExamples;
  return recentExamples.slice(-limit);
}

export function createDefaultEnemyDatasetState(enemyConfigs = ENEMIES) {
  const enemyExamples = {};
  for (const [enemyType, enemyConfig] of Object.entries(enemyConfigs)) {
    if (!enemyConfig?.adaptive?.enabled) continue;
    enemyExamples[enemyType] = [];
  }

  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    enemyExamples,
  };
}

function normalizeState(rawState, enemyConfigs = ENEMIES) {
  if (normalizeInteger(rawState?.featureVersion) !== ENEMY_LEARNING_CONFIG.featureVersion) {
    return createDefaultEnemyDatasetState(enemyConfigs);
  }

  const state = createDefaultEnemyDatasetState(enemyConfigs);
  const enemyExamples = { ...state.enemyExamples };

  for (const [enemyType, enemyConfig] of Object.entries(enemyConfigs)) {
    if (!enemyConfig?.adaptive?.enabled) continue;
    const examples = rawState?.enemyExamples?.[enemyType];
    enemyExamples[enemyType] = Array.isArray(examples)
      ? trimExamples(examples.map(example => normalizeExample(example)))
      : [];
  }

  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    enemyExamples,
  };
}

export class EnemyDatasetStore {
  /**
   * @param {{storage?: Storage, storageKey?: string, enemyConfigs?: object}} [options={}]
   */
  constructor(options = {}) {
    this._storage = getBrowserStorage(options.storage);
    this._storageKey = options.storageKey ?? ENEMY_DATASET_STORAGE_KEY;
    this._enemyConfigs = options.enemyConfigs ?? ENEMIES;
  }

  load() {
    const fallback = createDefaultEnemyDatasetState(this._enemyConfigs);
    if (!this._storage) return fallback;

    try {
      const raw = this._storage.getItem(this._storageKey);
      if (!raw) return fallback;
      return normalizeState(JSON.parse(raw), this._enemyConfigs);
    } catch {
      return fallback;
    }
  }

  save(state) {
    const normalized = normalizeState(state, this._enemyConfigs);
    if (!this._storage) return normalized;

    try {
      this._storage.setItem(this._storageKey, JSON.stringify(normalized));
    } catch {}

    return normalized;
  }

  appendTrainingRecords(records = [], meta = {}) {
    const nextState = this.load();
    const levelNumber = normalizeInteger(meta.levelNumber);
    const telemetryLevelId = normalizeInteger(meta.telemetryLevelId);
    const outcome = typeof meta.outcome === 'string' ? meta.outcome : 'player_win';
    const defaultWin = outcome === 'enemy_win' ? 1 : 0;

    for (const record of records) {
      if (!nextState.enemyExamples[record.enemyType]) continue;

      for (const example of record.examples ?? []) {
        nextState.enemyExamples[record.enemyType].push(normalizeExample({
          vector: example.vector,
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
        }));
      }

      nextState.enemyExamples[record.enemyType] = trimExamples(nextState.enemyExamples[record.enemyType]);
    }

    return this.save(nextState);
  }
}
