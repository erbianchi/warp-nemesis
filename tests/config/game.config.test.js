import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_CONFIG } from '../../config/game.config.js';

describe('GAME_CONFIG', () => {
  const REQUIRED_KEYS = [
    'WIDTH', 'HEIGHT',
    'PLAYER_SPEED',
    'WEAPON_SLOTS',
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

  it('WEAPON_SLOTS is 2', () => {
    assert.equal(GAME_CONFIG.WEAPON_SLOTS, 2);
  });
});
