/** @module enemies.config */

const HEAVY_ADAPTIVE = Object.freeze({
  enabled: true,
  minSpeedScalar: 0.85,
  maxSpeedScalar: 1.25,
  minTrainingSpawns: 1,
});

const SKIRM_ADAPTIVE = Object.freeze({
  enabled: true,
  minSpeedScalar: 0.9,
  maxSpeedScalar: 1.15,
  minTrainingSpawns: 1,
});

/**
 * Base stats for each enemy type.
 * Actual in-game stats are computed by WaveSpawner:
 *   stat = base * level.difficultyBase * wave.difficultyFactor * plane.modifier
 *
 * speedModifier on a plane does NOT compound with difficulty — speed is always
 * plane-relative to the base, to keep movement readable at any difficulty.
 */
export const ENEMIES = {
  /** Skirm — basic cannon-fodder. Slow, low HP, shoots straight down. */
  skirm: {
    hp: 10,
    damage: 10,
    speed: 80,        // slow base cruise
    maxSpeed: 430,    // authored dance ceiling; fast enough to keep phrases alive without uncapping jink spikes
    fireRate: 2400,   // ms between shots; enough pressure that idle players get punished
    score: 50,
    dropChance: 0.10,
    bulletSpeed: 220,
    adaptive: SKIRM_ADAPTIVE,
  },

  /** Raptor — heavy slow gunship. Larger frame, shielded, fires an 8-way star burst. */
  raptor: {
    hp: 100,
    shield: 100,
    damage: 25,
    speed: 62,
    maxSpeed: 78,
    fireRate: 2800,   // deliberate burst cadence with real wing pressure
    score: 300,
    dropChance: 0.18,
    bulletSpeed: 230, // heavy bolts, but fast enough to feel threatening
    adaptive: HEAVY_ADAPTIVE,
  },

  /** Mine — slow drifting gravity trap. Heavy contact damage, no ranged attack. */
  mine: {
    hp: 500,
    damage: 0,
    contactDamage: 200,
    speed: 30,
    maxSpeed: 30,
    fireRate: 0,
    score: 200,
    dropChance: 0.10,
    bulletSpeed: 0,
    adaptive: HEAVY_ADAPTIVE,
  },

};

/**
 * Plane modifier presets — shorthand tags usable in level config.
 * A plane entry can reference a preset by name OR inline its own modifiers.
 *
 * All values are multipliers (1.0 = no change).
 * speedModifier is applied directly to the base speed (not difficulty-scaled).
 */
export const PLANE_PRESETS = {
  standard: { hpModifier: 1.0, damageModifier: 1.0, speedModifier: 1.0, fireRateModifier: 1.0, shieldModifier: 1.0 },
  heavy:    { hpModifier: 1.5, damageModifier: 1.2, speedModifier: 0.8, fireRateModifier: 0.9, shieldModifier: 1.0 },
  light:    { hpModifier: 0.7, damageModifier: 0.8, speedModifier: 1.3, fireRateModifier: 1.2, shieldModifier: 1.0 },
  ace:      { hpModifier: 1.2, damageModifier: 1.2, speedModifier: 1.2, fireRateModifier: 0.8, shieldModifier: 1.0 },
};
