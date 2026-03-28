/** @module EnemyLearningStore */

import { ENEMIES } from '../../config/enemies.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';

export const ENEMY_LEARNING_STORAGE_KEY = ENEMY_LEARNING_CONFIG.storageKey;
export const ENEMY_LEARNING_STAGED_STORAGE_KEY = `${ENEMY_LEARNING_STORAGE_KEY}.staged`;

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

function createEmptyRegressorState(modelState = {}) {
  return {
    weights: Array.isArray(modelState?.weights)
      ? modelState.weights.map(value => normalizeNumber(value, 0))
      : [],
    bias: normalizeNumber(modelState?.bias, 0),
  };
}

/**
 * @returns {{winModel: {weights: number[], bias: number}, pressureModel: {weights: number[], bias: number}, collisionModel: {weights: number[], bias: number}, sampleCount: number, lastScores: {win: number, pressure: number, collision: number}}}
 */
function createDefaultEnemyModel() {
  return {
    winModel: createEmptyRegressorState(),
    survivalModel: createEmptyRegressorState(),
    pressureModel: createEmptyRegressorState(),
    collisionModel: createEmptyRegressorState(),
    bulletModel: createEmptyRegressorState(),
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

/**
 * @param {object} enemyConfigs
 * @returns {{featureVersion: number, enemyModels: Record<string, {winModel: {weights: number[], bias: number}, pressureModel: {weights: number[], bias: number}, collisionModel: {weights: number[], bias: number}, sampleCount: number, lastScores: {win: number, pressure: number, collision: number}}>} }
 */
export function createDefaultLearningState(enemyConfigs = ENEMIES) {
  const enemyModels = {};
  for (const [enemyType, enemyConfig] of Object.entries(enemyConfigs)) {
    if (!enemyConfig?.adaptive?.enabled) continue;
    enemyModels[enemyType] = createDefaultEnemyModel();
  }

  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    enemyModels,
  };
}

function normalizeModel(modelState) {
  const base = createDefaultEnemyModel();
  return {
    winModel: createEmptyRegressorState(modelState?.winModel),
    survivalModel: createEmptyRegressorState(modelState?.survivalModel),
    pressureModel: createEmptyRegressorState(modelState?.pressureModel),
    collisionModel: createEmptyRegressorState(modelState?.collisionModel),
    bulletModel: createEmptyRegressorState(modelState?.bulletModel),
    sampleCount: normalizeInteger(modelState?.sampleCount),
    lastScores: {
      win: clamp(normalizeNumber(modelState?.lastScores?.win, base.lastScores.win), 0, 1),
      survival: clamp(normalizeNumber(modelState?.lastScores?.survival, base.lastScores.survival), 0, 1),
      pressure: clamp(normalizeNumber(modelState?.lastScores?.pressure, base.lastScores.pressure), 0, 1),
      collision: clamp(normalizeNumber(modelState?.lastScores?.collision, base.lastScores.collision), 0, 1),
      bullet: clamp(normalizeNumber(modelState?.lastScores?.bullet, base.lastScores.bullet), 0, 1),
    },
  };
}

function normalizeState(rawState, enemyConfigs = ENEMIES) {
  if (normalizeInteger(rawState?.featureVersion) !== ENEMY_LEARNING_CONFIG.featureVersion) {
    return createDefaultLearningState(enemyConfigs);
  }

  const state = createDefaultLearningState(enemyConfigs);
  const enemyModels = { ...state.enemyModels };

  for (const [enemyType, enemyConfig] of Object.entries(enemyConfigs)) {
    if (!enemyConfig?.adaptive?.enabled) continue;
    enemyModels[enemyType] = normalizeModel(rawState?.enemyModels?.[enemyType]);
  }

  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    enemyModels,
  };
}

/**
 * LocalStorage-backed persistence for enemy adaptation state.
 */
export class EnemyLearningStore {
  /**
   * @param {{storage?: Storage, storageKey?: string, enemyConfigs?: object}} [options={}]
   */
  constructor(options = {}) {
    this._storage = getBrowserStorage(options.storage);
    this._storageKey = options.storageKey ?? ENEMY_LEARNING_STORAGE_KEY;
    this._stagedStorageKey = options.stagedStorageKey ?? ENEMY_LEARNING_STAGED_STORAGE_KEY;
    this._enemyConfigs = options.enemyConfigs ?? ENEMIES;
  }

  /**
   * @returns {{featureVersion: number, enemyModels: Record<string, {winModel: {weights: number[], bias: number}, pressureModel: {weights: number[], bias: number}, collisionModel: {weights: number[], bias: number}, sampleCount: number, lastScores: {win: number, pressure: number, collision: number}}>} }
   */
  load() {
    const fallback = createDefaultLearningState(this._enemyConfigs);
    if (!this._storage) return fallback;

    try {
      const staged = this._storage.getItem(this._stagedStorageKey);
      if (staged) {
        const promoted = normalizeState(JSON.parse(staged), this._enemyConfigs);
        this._storage.setItem(this._storageKey, JSON.stringify(promoted));
        this._storage.removeItem?.(this._stagedStorageKey);
        return promoted;
      }
      const raw = this._storage.getItem(this._storageKey);
      if (!raw) return fallback;
      return normalizeState(JSON.parse(raw), this._enemyConfigs);
    } catch {
      return fallback;
    }
  }

  /**
   * @param {{featureVersion: number, enemyModels: Record<string, {winModel: {weights: number[], bias: number}, pressureModel: {weights: number[], bias: number}, collisionModel: {weights: number[], bias: number}, sampleCount: number, lastScores: {win: number, pressure: number, collision: number}}>} } state
   * @returns {{featureVersion: number, enemyModels: Record<string, {winModel: {weights: number[], bias: number}, pressureModel: {weights: number[], bias: number}, collisionModel: {weights: number[], bias: number}, sampleCount: number, lastScores: {win: number, pressure: number, collision: number}}>} }
   */
  save(state) {
    const normalized = normalizeState(state, this._enemyConfigs);
    if (!this._storage) return normalized;

    try {
      this._storage.setItem(this._storageKey, JSON.stringify(normalized));
    } catch {}

    return normalized;
  }

  stage(state) {
    const normalized = normalizeState(state, this._enemyConfigs);
    if (!this._storage) return normalized;

    try {
      this._storage.setItem(this._stagedStorageKey, JSON.stringify(normalized));
    } catch {}

    return normalized;
  }
}
