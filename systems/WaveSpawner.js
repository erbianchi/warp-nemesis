/** @module WaveSpawner */

import { LEVELS } from '../config/levels.config.js';
import { ENEMIES, PLANE_PRESETS } from '../config/enemies.config.js';
import { EVENTS } from '../config/events.config.js';

// ── Stat resolution ───────────────────────────────────────────────────────────

/**
 * Resolves the final stats for a plane by compositing:
 *   hp/damage/score = base × level.difficultyBase × wave.difficultyFactor × plane.modifier
 *   speed           = base × plane.speedModifier  (NOT difficulty-scaled)
 *
 * @param {string} type             - Key in ENEMIES config
 * @param {number} difficultyBase   - Level multiplier
 * @param {number} difficultyFactor - Wave multiplier
 * @param {object} planeOverrides   - { preset?, hpModifier?, damageModifier?, speedModifier?, fireRateModifier?, shieldModifier? }
 * @returns {{ hp, damage, speed, fireRate, score, dropChance, bulletSpeed, shield }}
 */
export function resolveStats(type, difficultyBase, difficultyFactor, planeOverrides = {}) {
  const base = ENEMIES[type];
  if (!base) throw new Error(`WaveSpawner: unknown enemy type "${type}"`);

  const preset = PLANE_PRESETS[planeOverrides.preset ?? 'standard'];
  if (!preset) throw new Error(`WaveSpawner: unknown plane preset "${planeOverrides.preset}"`);

  const hpMod       = planeOverrides.hpModifier       ?? preset.hpModifier;
  const damageMod   = planeOverrides.damageModifier    ?? preset.damageModifier;
  const speedMod    = planeOverrides.speedModifier     ?? preset.speedModifier;
  const fireRateMod = planeOverrides.fireRateModifier  ?? preset.fireRateModifier;
  const shieldMod   = planeOverrides.shieldModifier    ?? preset.shieldModifier ?? 1;

  const difficulty = difficultyBase * difficultyFactor;

  return {
    hp:          Math.round(base.hp         * difficulty * hpMod),
    damage:      Math.round(base.damage     * difficulty * damageMod),
    speed:       Math.round(base.speed      * speedMod),
    fireRate:    Math.round(base.fireRate   / fireRateMod),
    score:       Math.round(base.score      * difficulty),
    dropChance:  base.dropChance,
    bulletSpeed: base.bulletSpeed,
    shield:      Math.round((base.shield ?? 0) * difficulty * shieldMod),
  };
}

// ── Formation positions ───────────────────────────────────────────────────────

/**
 * Computes pixel spawn positions for a squadron based on its formation.
 *
 * @param {object} squadron - Squadron config entry
 * @param {number} width    - Canvas width
 * @param {number} height   - Canvas height
 * @param {Function} [rng]  - Optional RNG used by randomized formations
 * @returns {Array<{x, y}>} - One position per plane, in planes[] order
 */
export function resolveFormationPositions(squadron, width, height, rng = Math.random) {
  const { formation, entryEdge, entryX = 0.5, spacing = 60, planes } = squadron;
  const count = planes.length;
  const positions = [];

  let anchorX, anchorY;
  switch (entryEdge) {
    case 'top':   anchorX = width * entryX;  anchorY = -40;           break;
    case 'left':  anchorX = -40;             anchorY = height * entryX; break;
    case 'right': anchorX = width + 40;      anchorY = height * entryX; break;
    default: throw new Error(`WaveSpawner: unknown entryEdge "${entryEdge}"`);
  }

  const horizontal = entryEdge === 'top';

  switch (formation) {
    case 'line': {
      const totalSpan = (count - 1) * spacing;
      for (let i = 0; i < count; i++) {
        const offset = -totalSpan / 2 + i * spacing;
        positions.push(
          horizontal
            ? { x: anchorX + offset, y: anchorY }
            : { x: anchorX,          y: anchorY + offset }
        );
      }
      break;
    }
    case 'V': {
      const half = Math.floor(count / 2);
      for (let i = 0; i < count; i++) {
        const wing = i - half;
        positions.push(
          horizontal
            ? { x: anchorX + wing * spacing, y: anchorY + Math.abs(wing) * spacing * 0.8 }
            : { x: anchorX + Math.abs(wing) * spacing * 0.8, y: anchorY + wing * spacing }
        );
      }
      break;
    }
    case 'wedge': {
      const half = Math.floor(count / 2);
      for (let i = 0; i < count; i++) {
        const wing = i - half;
        positions.push(
          horizontal
            ? { x: anchorX + wing * spacing, y: anchorY - Math.abs(wing) * spacing * 0.8 }
            : { x: anchorX - Math.abs(wing) * spacing * 0.8, y: anchorY + wing * spacing }
        );
      }
      break;
    }
    case 'diamond': {
      if (count === 5) {
        for (const p of [
          { dx:  0,       dy: -spacing },
          { dx: -spacing, dy:  0 },
          { dx:  0,       dy:  0 },
          { dx:  spacing, dy:  0 },
          { dx:  0,       dy:  spacing },
        ]) positions.push({ x: anchorX + p.dx, y: anchorY + p.dy });
      } else {
        return resolveFormationPositions({ ...squadron, formation: 'line' }, width, height);
      }
      break;
    }
    case 'cluster': {
      const jitter = spacing / 2;
      for (let i = 0; i < count; i++) {
        positions.push({
          x: anchorX + (rng() - 0.5) * jitter * 2,
          y: anchorY + (rng() - 0.5) * jitter * 2,
        });
      }
      break;
    }
    case 'spread': {
      const step = width / (count + 1);
      for (let i = 0; i < count; i++) {
        positions.push(
          horizontal
            ? { x: step * (i + 1), y: anchorY }
            : { x: anchorX,        y: step * (i + 1) }
        );
      }
      break;
    }
    default:
      throw new Error(`WaveSpawner: unknown formation "${formation}"`);
  }

  return positions;
}

// ── Pool sampling ─────────────────────────────────────────────────────────────

/**
 * Randomly sample `count` items from `pool` without replacement.
 * Uses Fisher-Yates on a copy so the original pool is not mutated.
 *
 * @param {Array}   pool
 * @param {number}  count
 * @param {Function} [rng] - Optional RNG; defaults to Math.random (injectable for seeding)
 * @returns {Array}
 */
export function samplePool(pool, count, rng = Math.random) {
  if (count >= pool.length) return [...pool];
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// ── WaveSpawner class ─────────────────────────────────────────────────────────

/**
 * Drives enemy spawning for a level.
 *
 * Roguelike mode:
 *   If a wave has `squadronPool` + `squadronCount`, the spawner randomly
 *   draws `squadronCount` templates from the pool on `start()`, then
 *   dispatches them one by one with `interSquadronDelay` seconds between each.
 *
 * Static mode:
 *   If a wave has a `squadrons` array, it uses that order directly.
 *
 * Usage:
 *   const spawner = new WaveSpawner(scene, levelIndex, spawnFn);
 *   spawner.start();
 *   // Call spawner.update(delta) each frame.
 *
 * spawnFn signature:
 *   spawnFn(type, x, y, stats, dance) → enemy instance
 *
 * Events emitted on scene.events:
 *   EVENTS.WAVE_START          (waveConfig)
 *   EVENTS.WAVE_COMPLETE       (waveConfig)
 *   EVENTS.ALL_WAVES_COMPLETE  ()
 *   EVENTS.SQUADRON_SPAWNED    ({ dance, count, squadron })
 */
export class WaveSpawner {
  /**
   * @param {Phaser.Scene} scene
   * @param {number}       levelIndex - 0-based index into LEVELS
   * @param {Function}     spawnFn    - spawnFn(type, x, y, stats, dance)
   * @param {Function}     [rng]      - Optional RNG for pool sampling (default Math.random)
   */
  constructor(scene, levelIndex, spawnFn, rng = Math.random) {
    this._scene  = scene;
    this._spawnFn = spawnFn;
    this._rng     = rng;

    this._levelConfig = LEVELS[levelIndex];
    if (!this._levelConfig) {
      throw new Error(`WaveSpawner: no level config at index ${levelIndex}`);
    }

    this._waveQueue       = [];
    this._currentWave     = null;
    this._squadronQueue   = [];   // resolved squadron list for current wave
    this._elapsed         = 0;   // seconds since start()
    this._nextSquadronAt  = 0;   // seconds at which to spawn next squadron
    this._waitingForWave  = false;
    this._nextWaveAt      = 0;
    this._done            = false;
  }

  /**
   * True when a wave is in progress and not waiting for the inter-wave delay.
   * Use this to know when it's safe to call onWaveCleared().
   */
  get isWaveActive() {
    return !this._done && !this._waitingForWave && this._currentWave !== null;
  }

  /** Number of squadrons still queued to spawn in the current wave. */
  get pendingSquadrons() {
    return this._squadronQueue.length;
  }

  /** Begin spawning. Call once after the scene is ready. */
  start() {
    this._elapsed = 0;
    this._waveQueue = [...this._levelConfig.waves];
    this._launchNextWave();
  }

  /**
   * Advance the spawner. Call from GameScene.update().
   * @param {number} delta - Frame delta in milliseconds
   */
  update(delta) {
    if (this._done) return;
    this._elapsed += delta / 1000;

    // Waiting between waves
    if (this._waitingForWave) {
      if (this._elapsed >= this._nextWaveAt) {
        this._waitingForWave = false;
        this._launchNextWave();
      }
      return;
    }

    // Dispatch all squadrons whose time slot has arrived
    while (this._squadronQueue.length > 0 && this._elapsed >= this._nextSquadronAt) {
      const squadron = this._squadronQueue.shift();
      this._spawnSquadron(squadron);
      this._nextSquadronAt += (this._currentWave.interSquadronDelay ?? 0);
    }
  }

  /**
   * Notify the spawner that the current wave's enemies are all cleared.
   * Call from GameScene when the enemy group becomes empty.
   */
  onWaveCleared() {
    if (this._done) return;
    this._scene.events.emit(EVENTS.WAVE_COMPLETE, this._currentWave);

    if (this._waveQueue.length === 0) {
      this._done = true;
      this._scene.events.emit(EVENTS.ALL_WAVES_COMPLETE);
      return;
    }

    const nextWave = this._waveQueue[0];
    const delay    = nextWave.interSquadronDelay ?? 0;
    this._waitingForWave = true;
    this._nextWaveAt     = this._elapsed + delay;
  }

  // ── Private ───────────────────────────────────────────────────────────

  _launchNextWave() {
    this._currentWave = this._waveQueue.shift();

    // Resolve squadron list: pool (roguelike) or static array
    if (this._currentWave.squadronPool) {
      this._squadronQueue = samplePool(
        this._currentWave.squadronPool,
        this._currentWave.squadronCount ?? this._currentWave.squadronPool.length,
        this._rng
      );
    } else {
      this._squadronQueue = [...(this._currentWave.squadrons ?? [])];
    }

    this._nextSquadronAt = this._elapsed; // first squadron spawns immediately
    this._scene.events.emit(EVENTS.WAVE_START, this._currentWave);
  }

  /**
   * Re-queue the last spawned squadron so it launches again immediately.
   * Called by GameScene when the player respawns after losing a life.
   */
  replayLastSquadron() {
    if (!this._lastSquadron) return;
    this._squadronQueue.unshift(this._lastSquadron);
    this._nextSquadronAt = this._elapsed; // spawn on next update tick
  }

  _spawnSquadron(squadron) {
    const { width, height } = this._scene.scale;
    const { difficultyBase } = this._levelConfig;
    const { difficultyFactor } = this._currentWave;
    const defaultDance = squadron.dance ?? 'straight';

    const positions = resolveFormationPositions(squadron, width, height, this._rng);

    squadron.planes.forEach((plane, i) => {
      const stats = resolveStats(plane.type, difficultyBase, difficultyFactor, plane);
      const pos   = positions[i] ?? positions[positions.length - 1];
      const dance = plane.dance ?? defaultDance;
      this._spawnFn(plane.type, pos.x, pos.y, stats, dance);
    });

    this._lastSquadron = squadron; // saved for replayLastSquadron()

    this._scene.events.emit(EVENTS.SQUADRON_SPAWNED, {
      dance: defaultDance,
      count: squadron.planes.length,
      squadron,
    });
  }
}
