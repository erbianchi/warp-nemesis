import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_CONFIG } from '../../config/game.config.js';

describe('GAME_CONFIG', () => {
  const REQUIRED_KEYS = [
    'WIDTH', 'HEIGHT',
    'PLAYER_SPEED', 'PLAYER_LIVES_DEFAULT',
    'WEAPON_SLOTS',
    'PLAYER_HEAT_MAX', 'PLAYER_HEAT_RECOVERY_MS', 'PLAYER_OVERHEAT_RECOVERY_SHOTS',
    'PLAYER_HEAT_WARNING_RATIO', 'PLAYER_HEAT_WARNING_BLINK_MS',
    'PLAYER_HEAT_WARNING_SHAKE_MS', 'PLAYER_HEAT_WARNING_SHAKE_INTENSITY',
    'PLAYER_HEAT_WARNING_BONUS_PER_SHOT', 'PLAYER_HEAT_WARNING_SHOT_SHAKE_MS',
    'PLAYER_HEAT_WARNING_SHOT_SHAKE_MS_STEP', 'PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY',
    'PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY_STEP',
    'SPEED_MIN', 'SPEED_MAX', 'PLAYER_SPEED_DEFAULT',
    'STAR_COUNT', 'STAR_SPEED_MIN', 'STAR_SPEED_MAX',
  ];

  it('exports an object', () => {
    assert.equal(typeof GAME_CONFIG, 'object');
    assert.notEqual(GAME_CONFIG, null);
  });

  it('contains all required keys', () => {
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in GAME_CONFIG, `Missing key: ${key}`);
    }
  });

  it('all values are finite positive numbers', () => {
    for (const key of REQUIRED_KEYS) {
      const v = GAME_CONFIG[key];
      assert.ok(typeof v === 'number' && isFinite(v) && v > 0, `${key} must be a finite positive number, got ${v}`);
    }
  });

  it('WIDTH and HEIGHT are integers', () => {
    assert.equal(GAME_CONFIG.WIDTH  % 1, 0, 'WIDTH must be an integer');
    assert.equal(GAME_CONFIG.HEIGHT % 1, 0, 'HEIGHT must be an integer');
  });

  it('canvas dimensions are reasonable for a vertical shooter (portrait)', () => {
    assert.ok(GAME_CONFIG.HEIGHT > GAME_CONFIG.WIDTH, 'HEIGHT should exceed WIDTH for a vertical shooter');
    assert.ok(GAME_CONFIG.WIDTH  >= 320, 'WIDTH too narrow');
    assert.ok(GAME_CONFIG.HEIGHT >= 480, 'HEIGHT too short');
  });

  it('STAR_SPEED_MIN is less than STAR_SPEED_MAX', () => {
    assert.ok(GAME_CONFIG.STAR_SPEED_MIN < GAME_CONFIG.STAR_SPEED_MAX,
      `STAR_SPEED_MIN (${GAME_CONFIG.STAR_SPEED_MIN}) must be < STAR_SPEED_MAX (${GAME_CONFIG.STAR_SPEED_MAX})`);
  });

  it('STAR_COUNT is a positive integer', () => {
    assert.ok(Number.isInteger(GAME_CONFIG.STAR_COUNT) && GAME_CONFIG.STAR_COUNT > 0);
  });

  it('PLAYER_SPEED is at least 100', () => {
    assert.ok(GAME_CONFIG.PLAYER_SPEED >= 100, 'PLAYER_SPEED too slow to be playable');
  });

  it('SPEED_MIN is less than SPEED_MAX', () => {
    assert.ok(GAME_CONFIG.SPEED_MIN < GAME_CONFIG.SPEED_MAX,
      `SPEED_MIN (${GAME_CONFIG.SPEED_MIN}) must be < SPEED_MAX (${GAME_CONFIG.SPEED_MAX})`);
  });

  it('PLAYER_SPEED_DEFAULT is within [SPEED_MIN, SPEED_MAX]', () => {
    const { SPEED_MIN, SPEED_MAX, PLAYER_SPEED_DEFAULT } = GAME_CONFIG;
    assert.ok(
      PLAYER_SPEED_DEFAULT >= SPEED_MIN && PLAYER_SPEED_DEFAULT <= SPEED_MAX,
      `PLAYER_SPEED_DEFAULT (${PLAYER_SPEED_DEFAULT}) must be in [${SPEED_MIN}, ${SPEED_MAX}]`
    );
  });

  // ── Heat system structural constraints ───────────────────────────────────

  it('overheat recovery shots are less than max heat (unlock is reachable)', () => {
    const { PLAYER_HEAT_MAX, PLAYER_OVERHEAT_RECOVERY_SHOTS } = GAME_CONFIG;
    assert.ok(
      PLAYER_OVERHEAT_RECOVERY_SHOTS < PLAYER_HEAT_MAX,
      `PLAYER_OVERHEAT_RECOVERY_SHOTS (${PLAYER_OVERHEAT_RECOVERY_SHOTS}) must be < PLAYER_HEAT_MAX (${PLAYER_HEAT_MAX})`
    );
  });

  it('weapon unlocks below the warning zone so firing resumes normally after overheat', () => {
    const { PLAYER_HEAT_MAX, PLAYER_OVERHEAT_RECOVERY_SHOTS, PLAYER_HEAT_WARNING_RATIO } = GAME_CONFIG;
    const unlockAt      = PLAYER_HEAT_MAX - PLAYER_OVERHEAT_RECOVERY_SHOTS;
    const warningStart  = PLAYER_HEAT_MAX * PLAYER_HEAT_WARNING_RATIO;
    assert.ok(
      unlockAt < warningStart,
      `unlock heat (${unlockAt}) must be below warning zone start (${warningStart})`
    );
  });

  it('heat warning ratio is a valid fraction strictly between 0 and 1', () => {
    const r = GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO;
    assert.ok(r > 0 && r < 1, `PLAYER_HEAT_WARNING_RATIO (${r}) must be in (0, 1)`);
  });

  it('heat warning bonus per shot produces multipliers above 1', () => {
    assert.ok(GAME_CONFIG.PLAYER_HEAT_WARNING_BONUS_PER_SHOT > 0,
      'PLAYER_HEAT_WARNING_BONUS_PER_SHOT must be positive to have any effect');
  });

  it('shot shake step values are smaller than their base values', () => {
    const {
      PLAYER_HEAT_WARNING_SHOT_SHAKE_MS,
      PLAYER_HEAT_WARNING_SHOT_SHAKE_MS_STEP,
      PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY,
      PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY_STEP,
    } = GAME_CONFIG;
    assert.ok(PLAYER_HEAT_WARNING_SHOT_SHAKE_MS_STEP < PLAYER_HEAT_WARNING_SHOT_SHAKE_MS,
      'shake MS step must be smaller than base shake MS');
    assert.ok(PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY_STEP < PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY,
      'shake intensity step must be smaller than base shake intensity');
  });

  it('WEAPON_SLOTS is at least 1', () => {
    assert.ok(GAME_CONFIG.WEAPON_SLOTS >= 1, 'player needs at least 1 weapon slot');
    assert.ok(Number.isInteger(GAME_CONFIG.WEAPON_SLOTS));
  });
});
