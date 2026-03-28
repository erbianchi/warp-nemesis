/** @module EnemyDatasetStore */

import { ENEMIES } from '../../config/enemies.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';

export const ENEMY_DATASET_STORAGE_KEY = ENEMY_LEARNING_CONFIG.datasetStorageKey;

function normalizeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

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
      outcome: typeof example.meta?.outcome === 'string' ? example.meta.outcome : 'player_win',
      squadId: typeof example.meta?.squadId === 'string' ? example.meta.squadId : null,
      waveId: typeof example.meta?.waveId === 'string' ? example.meta.waveId : null,
    },
  };
}

function trimExamples(examples = []) {
  const limit = Math.max(1, normalizeInteger(ENEMY_LEARNING_CONFIG.maxExamplesPerEnemyType));
  if (examples.length <= limit) return examples;
  return examples.slice(-limit);
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
            outcome,
            squadId: record.summary?.squadId ?? null,
            waveId: record.summary?.waveId ?? null,
          },
        }));
      }

      nextState.enemyExamples[record.enemyType] = trimExamples(nextState.enemyExamples[record.enemyType]);
    }

    return this.save(nextState);
  }
}
