/** @module SquadLearningStore */

import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';

export const SQUAD_LEARNING_STORAGE_KEY = ENEMY_LEARNING_CONFIG.squadStorageKey;
export const SQUAD_LEARNING_STAGED_STORAGE_KEY = `${SQUAD_LEARNING_STORAGE_KEY}.staged`;

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

function normalizeArray(values) {
  return Array.isArray(values) ? values.map(value => normalizeNumber(value, 0)) : [];
}

function createDefaultLevelModel() {
  return {
    inputSize: 0,
    hiddenUnits: ENEMY_LEARNING_CONFIG.squadHiddenUnits,
    dense1Kernel: [],
    dense1Bias: [],
    dense2Kernel: [],
    dense2Bias: [],
    sampleCount: 0,
    lastScores: {
      win: 0.5,
      pressure: 0.5,
      collision: 0.5,
    },
  };
}

export function createDefaultSquadLearningState() {
  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    squadModels: {
      level2: createDefaultLevelModel(),
    },
  };
}

function normalizeLevelModel(rawModel = {}) {
  const fallback = createDefaultLevelModel();
  return {
    inputSize: normalizeInteger(rawModel.inputSize),
    hiddenUnits: Math.max(1, normalizeInteger(rawModel.hiddenUnits || fallback.hiddenUnits)),
    dense1Kernel: normalizeArray(rawModel.dense1Kernel),
    dense1Bias: normalizeArray(rawModel.dense1Bias),
    dense2Kernel: normalizeArray(rawModel.dense2Kernel),
    dense2Bias: normalizeArray(rawModel.dense2Bias),
    sampleCount: normalizeInteger(rawModel.sampleCount),
    lastScores: {
      win: clamp(normalizeNumber(rawModel.lastScores?.win, fallback.lastScores.win), 0, 1),
      pressure: clamp(normalizeNumber(rawModel.lastScores?.pressure, fallback.lastScores.pressure), 0, 1),
      collision: clamp(normalizeNumber(rawModel.lastScores?.collision, fallback.lastScores.collision), 0, 1),
    },
  };
}

function normalizeState(rawState) {
  if (normalizeInteger(rawState?.featureVersion) !== ENEMY_LEARNING_CONFIG.featureVersion) {
    return createDefaultSquadLearningState();
  }

  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    squadModels: {
      level2: normalizeLevelModel(rawState?.squadModels?.level2),
    },
  };
}

export class SquadLearningStore {
  /**
   * @param {{storage?: Storage, storageKey?: string}} [options={}]
   */
  constructor(options = {}) {
    this._storage = getBrowserStorage(options.storage);
    this._storageKey = options.storageKey ?? SQUAD_LEARNING_STORAGE_KEY;
    this._stagedStorageKey = options.stagedStorageKey ?? SQUAD_LEARNING_STAGED_STORAGE_KEY;
  }

  load() {
    const fallback = createDefaultSquadLearningState();
    if (!this._storage) return fallback;

    try {
      const staged = this._storage.getItem(this._stagedStorageKey);
      if (staged) {
        const promoted = normalizeState(JSON.parse(staged));
        this._storage.setItem(this._storageKey, JSON.stringify(promoted));
        this._storage.removeItem?.(this._stagedStorageKey);
        return promoted;
      }
      const raw = this._storage.getItem(this._storageKey);
      if (!raw) return fallback;
      return normalizeState(JSON.parse(raw));
    } catch {
      return fallback;
    }
  }

  save(state) {
    const normalized = normalizeState(state);
    if (!this._storage) return normalized;

    try {
      this._storage.setItem(this._storageKey, JSON.stringify(normalized));
    } catch {}

    return normalized;
  }

  stage(state) {
    const normalized = normalizeState(state);
    if (!this._storage) return normalized;

    try {
      this._storage.setItem(this._stagedStorageKey, JSON.stringify(normalized));
    } catch {}

    return normalized;
  }
}
