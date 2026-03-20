import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const {
  LOOP_PATH,
  SLOTS,
  calcFormationSlots,
  SQUADRON_SHIP_LIFE,
  FORMATION_SPEED,
  FORMATION_CYCLE_MS,
  FORMATION_SHOOT_RATE,
  DRIFT_RANGE_X,
  DRIFT_RANGE_Y,
} = await import('../../scenes/GameScene.js');

const { WEAPONS } = await import('../../config/weapons.config.js');

const { GAME_CONFIG } = await import('../../config/game.config.js');
const { WIDTH, HEIGHT } = GAME_CONFIG;

// ---------------------------------------------------------------------------

describe('LOOP_PATH', () => {
  it('has 7 waypoints', () => {
    assert.equal(LOOP_PATH.length, 7);
  });

  it('every waypoint has numeric x, y, and dur', () => {
    for (const wp of LOOP_PATH) {
      assert.equal(typeof wp.x,   'number', `x must be number: ${JSON.stringify(wp)}`);
      assert.equal(typeof wp.y,   'number', `y must be number: ${JSON.stringify(wp)}`);
      assert.equal(typeof wp.dur, 'number', `dur must be number: ${JSON.stringify(wp)}`);
    }
  });

  it('all durations are positive', () => {
    for (const wp of LOOP_PATH) {
      assert.ok(wp.dur > 0, `dur must be > 0: ${JSON.stringify(wp)}`);
    }
  });

  it('x values stay within a generous canvas margin (−100 … WIDTH+100)', () => {
    for (const wp of LOOP_PATH) {
      assert.ok(wp.x >= -100 && wp.x <= WIDTH + 100, `x out of range: ${wp.x}`);
    }
  });

  it('loop descends below mid-screen (max y > HEIGHT/2)', () => {
    const maxY = Math.max(...LOOP_PATH.map(w => w.y));
    assert.ok(maxY > HEIGHT / 2, `loop should reach below mid-screen; max y = ${maxY}`);
  });

  it('last waypoint is near the top (y < HEIGHT/4)', () => {
    const lastY = LOOP_PATH[LOOP_PATH.length - 1].y;
    assert.ok(lastY < HEIGHT / 4, `last waypoint should be near top; y = ${lastY}`);
  });
});

// ---------------------------------------------------------------------------

describe('SLOTS', () => {
  it('has exactly 8 slots', () => {
    assert.equal(SLOTS.length, 8);
  });

  it('every slot has numeric x and y', () => {
    for (const s of SLOTS) {
      assert.equal(typeof s.x, 'number', `x must be number: ${JSON.stringify(s)}`);
      assert.equal(typeof s.y, 'number', `y must be number: ${JSON.stringify(s)}`);
    }
  });

  it('all slots are within canvas bounds', () => {
    for (const s of SLOTS) {
      assert.ok(s.x >= 0 && s.x <= WIDTH,  `x out of bounds: ${s.x}`);
      assert.ok(s.y >= 0 && s.y <= HEIGHT, `y out of bounds: ${s.y}`);
    }
  });

  it('slots form exactly 2 rows (2 distinct y values)', () => {
    const rows = new Set(SLOTS.map(s => s.y));
    assert.equal(rows.size, 2, `expected 2 rows, got ${rows.size}`);
  });

  it('each row has exactly 4 ships', () => {
    const counts = {};
    for (const s of SLOTS) counts[s.y] = (counts[s.y] ?? 0) + 1;
    for (const [y, n] of Object.entries(counts)) {
      assert.equal(n, 4, `row y=${y} has ${n} ships, expected 4`);
    }
  });

  it('slots are near the top of the screen (y < HEIGHT/4)', () => {
    for (const s of SLOTS) {
      assert.ok(s.y < HEIGHT / 4, `slot y=${s.y} should be in top quarter`);
    }
  });

  it('no two slots share the same (x, y) position', () => {
    const seen = new Set();
    for (const s of SLOTS) {
      const key = `${s.x},${s.y}`;
      assert.ok(!seen.has(key), `duplicate slot position: ${key}`);
      seen.add(key);
    }
  });

  it('slot x-spacing is positive (ships have distinct columns)', () => {
    const xs = [...new Set(SLOTS.map(s => s.x))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      assert.ok(xs[i] > xs[i - 1], `duplicate column x=${xs[i - 1]}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('SQUADRON_SHIP_LIFE', () => {
  it('is a positive integer', () => {
    assert.ok(Number.isInteger(SQUADRON_SHIP_LIFE) && SQUADRON_SHIP_LIFE > 0);
  });

  it('equals the player starting life (balanced starting HP)', () => {
    assert.equal(SQUADRON_SHIP_LIFE, GAME_CONFIG.PLAYER_LIFE_DEFAULT);
  });

  it('laser kills a ship in exactly one hit', () => {
    assert.ok(
      WEAPONS.laser.damage >= SQUADRON_SHIP_LIFE,
      `laser damage (${WEAPONS.laser.damage}) should be >= ship life (${SQUADRON_SHIP_LIFE})`
    );
  });
});

// ---------------------------------------------------------------------------

describe('FORMATION_SPEED', () => {
  it('is a number', () => {
    assert.equal(typeof FORMATION_SPEED, 'number');
  });

  it('is within [SPEED_MIN, SPEED_MAX]', () => {
    assert.ok(
      FORMATION_SPEED >= GAME_CONFIG.SPEED_MIN && FORMATION_SPEED <= GAME_CONFIG.SPEED_MAX,
      `FORMATION_SPEED (${FORMATION_SPEED}) must be in [${GAME_CONFIG.SPEED_MIN}, ${GAME_CONFIG.SPEED_MAX}]`
    );
  });
});

// ---------------------------------------------------------------------------

describe('FORMATION_SHOOT_RATE', () => {
  it('is a positive number', () => {
    assert.ok(typeof FORMATION_SHOOT_RATE === 'number' && FORMATION_SHOOT_RATE > 0);
  });

  it('interval (1000 / rate) is an integer ms value', () => {
    assert.equal(Math.round(1000 / FORMATION_SHOOT_RATE), 1000 / FORMATION_SHOOT_RATE,
      'rate should divide evenly into 1000 ms');
  });

  it('fires at least once per second (rate >= 1)', () => {
    assert.ok(FORMATION_SHOOT_RATE >= 1, `rate should be >= 1; got ${FORMATION_SHOOT_RATE}`);
  });
});

// ---------------------------------------------------------------------------

describe('FORMATION_CYCLE_MS', () => {
  it('is a positive number', () => {
    assert.ok(typeof FORMATION_CYCLE_MS === 'number' && FORMATION_CYCLE_MS > 0);
  });

  it('gives players enough time to react (>= 5000 ms)', () => {
    assert.ok(FORMATION_CYCLE_MS >= 5000,
      `cycle should be at least 5 s; got ${FORMATION_CYCLE_MS} ms`);
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('calcFormationSlots', () => {
  it('returns 8 slots for 8 ships (matches SLOTS length)', () => {
    assert.equal(calcFormationSlots(8).length, 8);
  });

  it('returns correct count for any n (1–8)', () => {
    for (let n = 1; n <= 8; n++) {
      assert.equal(calcFormationSlots(n).length, n, `expected ${n} slots for n=${n}`);
    }
  });

  it('returns empty array for 0', () => {
    assert.equal(calcFormationSlots(0).length, 0);
  });

  it('every slot has numeric x and y', () => {
    for (const s of calcFormationSlots(5)) {
      assert.equal(typeof s.x, 'number');
      assert.equal(typeof s.y, 'number');
    }
  });

  it('all slots stay within canvas bounds', () => {
    for (let n = 1; n <= 8; n++) {
      for (const s of calcFormationSlots(n)) {
        assert.ok(s.x >= 0 && s.x <= WIDTH,  `x=${s.x} out of bounds for n=${n}`);
        assert.ok(s.y >= 0 && s.y <= HEIGHT, `y=${s.y} out of bounds for n=${n}`);
      }
    }
  });

  it('uses at most 2 rows', () => {
    for (let n = 1; n <= 8; n++) {
      const rows = new Set(calcFormationSlots(n).map(s => s.y));
      assert.ok(rows.size <= 2, `n=${n} produced ${rows.size} rows`);
    }
  });

  it('rows differ by y (when 2 rows)', () => {
    const slots = calcFormationSlots(8);
    const ys = [...new Set(slots.map(s => s.y))];
    assert.equal(ys.length, 2);
    assert.notEqual(ys[0], ys[1]);
  });

  it('slots are near the top of the screen (y < HEIGHT/4)', () => {
    for (const s of calcFormationSlots(8)) {
      assert.ok(s.y < HEIGHT / 4, `y=${s.y} is not in top quarter`);
    }
  });

  it('no duplicate (x, y) positions', () => {
    for (let n = 1; n <= 8; n++) {
      const seen = new Set();
      for (const s of calcFormationSlots(n)) {
        const key = `${s.x},${s.y}`;
        assert.ok(!seen.has(key), `duplicate slot at ${key} for n=${n}`);
        seen.add(key);
      }
    }
  });

  it('n=8 produces same x positions as SLOTS (backward-compatible)', () => {
    const computed = calcFormationSlots(8).map(s => s.x).sort((a, b) => a - b);
    const original = SLOTS.map(s => s.x).sort((a, b) => a - b);
    assert.deepEqual(computed, original);
  });

  it('slots are horizontally centered (mean x ≈ WIDTH/2)', () => {
    for (let n = 1; n <= 8; n++) {
      const slots = calcFormationSlots(n);
      const meanX = slots.reduce((s, p) => s + p.x, 0) / slots.length;
      assert.ok(
        Math.abs(meanX - WIDTH / 2) < 35,
        `n=${n}: mean x=${meanX.toFixed(1)} is not centered on WIDTH/2=${WIDTH / 2}`
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe('DRIFT_RANGE_X / DRIFT_RANGE_Y', () => {
  it('both are positive numbers', () => {
    assert.ok(typeof DRIFT_RANGE_X === 'number' && DRIFT_RANGE_X > 0);
    assert.ok(typeof DRIFT_RANGE_Y === 'number' && DRIFT_RANGE_Y > 0);
  });

  it('drift ranges are small enough not to leave the top quarter of the screen', () => {
    const topQuarter = HEIGHT / 4;
    const maxSlotY = Math.max(...SLOTS.map(s => s.y));
    assert.ok(maxSlotY + DRIFT_RANGE_Y < topQuarter,
      `max slot y (${maxSlotY}) + drift (${DRIFT_RANGE_Y}) would exit top quarter (${topQuarter})`);
  });
});
