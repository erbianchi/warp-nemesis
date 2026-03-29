/** @module SquadDatasetStore */

import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { clamp, normalizeInteger, normalizeNumber } from '../../utils/math.js';

export const SQUAD_DATASET_STORAGE_KEY = ENEMY_LEARNING_CONFIG.squadDatasetStorageKey;

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
      pressure: clamp(normalizeNumber(example.labels?.pressure, 0), 0, 1),
      collision: clamp(normalizeNumber(example.labels?.collision, 0), 0, 1),
    },
    meta: {
      levelNumber: normalizeInteger(example.meta?.levelNumber),
      telemetryLevelId: normalizeInteger(example.meta?.telemetryLevelId),
      squadId: typeof example.meta?.squadId === 'string' ? example.meta.squadId : null,
      squadTemplateId: typeof example.meta?.squadTemplateId === 'string' ? example.meta.squadTemplateId : null,
      formation: typeof example.meta?.formation === 'string' ? example.meta.formation : null,
      dance: typeof example.meta?.dance === 'string' ? example.meta.dance : null,
      outcome: typeof example.meta?.outcome === 'string' ? example.meta.outcome : 'player_win',
      overlay: Boolean(example.meta?.overlay),
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
  const limit = Math.max(1, normalizeInteger(ENEMY_LEARNING_CONFIG.maxSquadExamples));
  if (recentExamples.length <= limit) return recentExamples;
  return recentExamples.slice(-limit);
}

export function createDefaultSquadDatasetState() {
  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    examples: [],
  };
}

function normalizeState(rawState) {
  if (normalizeInteger(rawState?.featureVersion) !== ENEMY_LEARNING_CONFIG.featureVersion) {
    return createDefaultSquadDatasetState();
  }

  return {
    featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
    examples: Array.isArray(rawState?.examples)
      ? trimExamples(rawState.examples.map(example => normalizeExample(example)))
      : [],
  };
}

export class SquadDatasetStore {
  /**
   * @param {{storage?: Storage, storageKey?: string}} [options={}]
   */
  constructor(options = {}) {
    this._storage = getBrowserStorage(options.storage);
    this._storageKey = options.storageKey ?? SQUAD_DATASET_STORAGE_KEY;
  }

  load() {
    const fallback = createDefaultSquadDatasetState();
    if (!this._storage) return fallback;

    try {
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

  appendTrainingRecords(records = [], meta = {}) {
    const nextState = this.load();
    const levelNumber = normalizeInteger(meta.levelNumber);
    const telemetryLevelId = normalizeInteger(meta.telemetryLevelId);
    const outcome = typeof meta.outcome === 'string' ? meta.outcome : 'player_win';
    const defaultWin = outcome === 'enemy_win' ? 1 : 0;

    for (const record of records) {
      for (const example of record.examples ?? []) {
        nextState.examples.push(normalizeExample({
          vector: example.vector,
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
        }));
      }
    }

    nextState.examples = trimExamples(nextState.examples);

    return this.save(nextState);
  }
}
