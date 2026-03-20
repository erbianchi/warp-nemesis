import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '../../config/events.config.js';

const REQUIRED_KEYS = [
  'GAME_START', 'GAME_OVER', 'LEVEL_COMPLETE', 'LEVEL_START',
  'PLAYER_HIT', 'PLAYER_DIED', 'HEALTH_CHANGED', 'SHIELD_CHANGED',
  'ENEMY_KILLED',
  'SCORE_CHANGED', 'LIVES_CHANGED',
  'WEAPON_CHANGED', 'BONUS_COLLECTED',
];

describe('EVENTS', () => {
  it('exports an object', () => {
    assert.equal(typeof EVENTS, 'object');
    assert.notEqual(EVENTS, null);
  });

  it('contains all required event keys', () => {
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in EVENTS, `Missing event key: ${key}`);
    }
  });

  it('all values are non-empty strings', () => {
    for (const [key, val] of Object.entries(EVENTS)) {
      assert.equal(typeof val, 'string', `${key} value must be a string`);
      assert.ok(val.length > 0, `${key} value must not be empty`);
    }
  });

  it('all event name strings are unique (no duplicates)', () => {
    const values = Object.values(EVENTS);
    const unique  = new Set(values);
    assert.equal(unique.size, values.length,
      `Duplicate event strings found: ${values.filter((v, i) => values.indexOf(v) !== i)}`);
  });

  it('event strings follow the namespace:action pattern', () => {
    for (const [key, val] of Object.entries(EVENTS)) {
      assert.ok(val.includes(':'), `${key} = "${val}" should follow "namespace:action" format`);
    }
  });
});
