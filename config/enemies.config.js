/** @module enemies.config */

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
    speed: 80,        // slow
    fireRate: 4400,   // ms between shots
    score: 50,
    dropChance: 0.10,
    bulletSpeed: 220,
  },

  fighter: {
    hp: 20,
    damage: 10,
    speed: 120,
    fireRate: 1500,   // ms between shots
    score: 100,
    dropChance: 0.15,
    bulletSpeed: 280,
  },

  bomber: {
    hp: 50,
    damage: 20,
    speed: 70,
    fireRate: 2500,
    score: 250,
    dropChance: 0.35,
    bulletSpeed: 200,
  },

  interceptor: {
    hp: 15,
    damage: 8,
    speed: 220,
    fireRate: 1000,
    score: 150,
    dropChance: 0.10,
    bulletSpeed: 350,
  },

  turretDrone: {
    hp: 40,
    damage: 12,
    speed: 50,
    fireRate: 800,
    score: 200,
    dropChance: 0.20,
    bulletSpeed: 260,
  },

  kamikaze: {
    hp: 10,
    damage: 30,   // collision damage — rams the player
    speed: 280,
    fireRate: 0,  // no ranged attack
    score: 80,
    dropChance: 0.05,
    bulletSpeed: 0,
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
  standard: { hpModifier: 1.0, damageModifier: 1.0, speedModifier: 1.0, fireRateModifier: 1.0 },
  heavy:    { hpModifier: 1.5, damageModifier: 1.2, speedModifier: 0.8, fireRateModifier: 0.9 },
  light:    { hpModifier: 0.7, damageModifier: 0.8, speedModifier: 1.3, fireRateModifier: 1.2 },
  ace:      { hpModifier: 1.2, damageModifier: 1.2, speedModifier: 1.2, fireRateModifier: 0.8 },
};
