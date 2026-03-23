/** @module MetaProgression
 * Cross-run persistence for meta currency and queued next-game bonuses. */

import { STORE_ITEMS_BY_KEY } from '../config/store.config.js';

export const META_PROGRESSION_STORAGE_KEY = 'warp-nemesis.metaProgression';
export const LEGACY_TOTAL_SCORE_STORAGE_KEY = 'warp-nemesis.totalScore';

/**
 * Clamp any stored or computed score to a safe non-negative integer.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

/**
 * Resolve browser storage if it is available in the current environment.
 * @returns {{getItem(key: string): string|null, setItem(key: string, value: string): void}|null}
 */
function getBrowserStorage() {
  const storage = globalThis.localStorage;
  if (!storage?.getItem || !storage?.setItem) return null;
  return storage;
}

/**
 * Normalize persistent starting bonuses bought from the meta store.
 * Accept the legacy `pendingBonuses` shape during migration.
 * @param {{hp?: unknown, shield?: unknown}|undefined|null} bonuses
 * @returns {{hp: number, shield: number}}
 */
function normalizeOwnedBonuses(bonuses) {
  return {
    hp: normalizeScore(bonuses?.hp),
    shield: normalizeScore(bonuses?.shield),
  };
}

/**
 * Normalize the persisted meta-progression payload.
 * Migrate legacy `pendingBonuses` into permanent owned bonuses.
 * @param {{totalScore?: unknown, ownedBonuses?: {hp?: unknown, shield?: unknown}, pendingBonuses?: {hp?: unknown, shield?: unknown}}|null|undefined} state
 * @returns {{totalScore: number, ownedBonuses: {hp: number, shield: number}}}
 */
function normalizeState(state) {
  return {
    totalScore: normalizeScore(state?.totalScore),
    ownedBonuses: normalizeOwnedBonuses(
      state?.ownedBonuses ?? state?.pendingBonuses
    ),
  };
}

/**
 * Build a detached snapshot for external consumers.
 * @param {{totalScore: number, ownedBonuses: {hp: number, shield: number}}} state
 * @returns {{totalScore: number, ownedBonuses: {hp: number, shield: number}}}
 */
function snapshotState(state) {
  return {
    totalScore: state.totalScore,
    ownedBonuses: {
      hp: state.ownedBonuses.hp,
      shield: state.ownedBonuses.shield,
    },
  };
}

/**
 * Apply a configured store effect to the player's permanent starting bonuses.
 * @param {{hp: number, shield: number}} ownedBonuses
 * @param {{type: string, value: number}} effect
 */
function applyStoreEffect(ownedBonuses, effect) {
  switch (effect?.type) {
    case 'starting_hp':
      ownedBonuses.hp += normalizeScore(effect.value);
      break;
    case 'starting_shield':
      ownedBonuses.shield += normalizeScore(effect.value);
      break;
    default:
      throw new Error(`Unknown store effect type "${effect?.type ?? 'undefined'}"`);
  }
}

export const MetaProgression = {
  totalScore: 0,
  ownedBonuses: {
    hp: 0,
    shield: 0,
  },

  /**
   * Return the current normalized state snapshot.
   * @returns {{totalScore: number, ownedBonuses: {hp: number, shield: number}}}
   */
  getSnapshot() {
    this.totalScore = normalizeScore(this.totalScore);
    this.ownedBonuses = normalizeOwnedBonuses(this.ownedBonuses);
    return snapshotState(this);
  },

  /**
   * Load meta progression from browser storage, with legacy score migration.
   * @returns {{totalScore: number, ownedBonuses: {hp: number, shield: number}}}
   */
  load() {
    const storage = getBrowserStorage();
    if (!storage) return this.getSnapshot();

    try {
      const rawState = storage.getItem(META_PROGRESSION_STORAGE_KEY);
      if (rawState) {
        const parsed = JSON.parse(rawState);
        Object.assign(this, normalizeState(parsed));
        return this.getSnapshot();
      }

      const legacyTotalScore = storage.getItem(LEGACY_TOTAL_SCORE_STORAGE_KEY);
      Object.assign(this, normalizeState({
        totalScore: legacyTotalScore,
        ownedBonuses: this.ownedBonuses,
      }));
      this.save();
    } catch {
      Object.assign(this, normalizeState(this));
    }

    return this.getSnapshot();
  },

  /**
   * Persist the current meta progression state to browser storage.
   * @returns {{totalScore: number, ownedBonuses: {hp: number, shield: number}}}
   */
  save() {
    const storage = getBrowserStorage();
    const state = this.getSnapshot();
    if (!storage) return state;

    try {
      storage.setItem(META_PROGRESSION_STORAGE_KEY, JSON.stringify(state));
    } catch {}

    return state;
  },

  /**
   * Add a completed level score into the persistent total score wallet.
   * @param {number} levelScore
   * @returns {{totalScore: number, ownedBonuses: {hp: number, shield: number}}}
   */
  recordCompletedLevel(levelScore) {
    this.load();
    this.totalScore += normalizeScore(levelScore);
    return this.save();
  },

  /**
   * Attempt to buy a configured store item.
   * @param {string} itemKey
   * @returns {{ok: boolean, reason: string|null, item: object|null, totalScore: number, ownedBonuses: {hp: number, shield: number}}}
   */
  purchase(itemKey) {
    const item = STORE_ITEMS_BY_KEY[itemKey] ?? null;
    if (!item) {
      const state = this.load();
      return {
        ok: false,
        reason: 'unknown_item',
        item: null,
        totalScore: state.totalScore,
        ownedBonuses: state.ownedBonuses,
      };
    }

    this.load();
    if (this.totalScore < item.price) {
      const state = this.getSnapshot();
      return {
        ok: false,
        reason: 'insufficient_score',
        item,
        totalScore: state.totalScore,
        ownedBonuses: state.ownedBonuses,
      };
    }

    this.totalScore -= item.price;
    applyStoreEffect(this.ownedBonuses, item.effect);
    const state = this.save();
    return {
      ok: true,
      reason: null,
      item,
      totalScore: state.totalScore,
      ownedBonuses: state.ownedBonuses,
    };
  },

  /**
   * Return the permanent starting bonuses applied at the beginning of every run.
   * @returns {{hp: number, shield: number}}
   */
  getStartingBonuses() {
    this.load();
    return {
      hp: this.ownedBonuses.hp,
      shield: this.ownedBonuses.shield,
    };
  },
};

MetaProgression.load();
