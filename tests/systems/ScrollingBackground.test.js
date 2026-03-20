import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { ScrollingBackground } = await import('../../systems/ScrollingBackground.js');
const { GAME_CONFIG }         = await import('../../config/game.config.js');
const { WIDTH, HEIGHT, STAR_COUNT, STAR_SPEED_MIN, STAR_SPEED_MAX } = GAME_CONFIG;

describe('ScrollingBackground', () => {
  let scene;
  let bg;

  beforeEach(() => {
    scene = createMockScene();
    bg    = new ScrollingBackground(scene);
  });

  // --- Construction ---

  it('creates exactly STAR_COUNT stars', () => {
    assert.equal(bg._stars.length, STAR_COUNT);
  });

  it('all stars start within canvas bounds', () => {
    for (const s of bg._stars) {
      assert.ok(s.x >= 0 && s.x <= WIDTH,  `star.x ${s.x} out of [0, ${WIDTH}]`);
      assert.ok(s.y >= 0 && s.y <= HEIGHT, `star.y ${s.y} out of [0, ${HEIGHT}]`);
    }
  });

  it('all stars have speed within [STAR_SPEED_MIN, STAR_SPEED_MAX]', () => {
    for (const s of bg._stars) {
      assert.ok(s.speed >= STAR_SPEED_MIN && s.speed <= STAR_SPEED_MAX,
        `star.speed ${s.speed} out of [${STAR_SPEED_MIN}, ${STAR_SPEED_MAX}]`);
    }
  });

  it('star size is 1 or 2', () => {
    for (const s of bg._stars) {
      assert.ok(s.size === 1 || s.size === 2, `unexpected star.size: ${s.size}`);
    }
  });

  it('faster stars get size 2', () => {
    const speedThreshold = STAR_SPEED_MIN + 0.65 * (STAR_SPEED_MAX - STAR_SPEED_MIN);
    const fastStars = bg._stars.filter(s => s.speed > speedThreshold);
    assert.ok(fastStars.length > 0, 'expected some fast stars');
    for (const s of fastStars) {
      assert.equal(s.size, 2, `fast star (speed=${s.speed.toFixed(1)}) should have size 2`);
    }
  });

  it('star alpha is in (0, 1]', () => {
    for (const s of bg._stars) {
      assert.ok(s.alpha > 0 && s.alpha <= 1, `star.alpha ${s.alpha} out of (0, 1]`);
    }
  });

  it('faster stars are brighter (higher alpha)', () => {
    const sorted = [...bg._stars].sort((a, b) => a.speed - b.speed);
    const slowest = sorted[0];
    const fastest = sorted[sorted.length - 1];
    assert.ok(fastest.alpha >= slowest.alpha,
      `fastest star alpha (${fastest.alpha}) should be >= slowest (${slowest.alpha})`);
  });

  it('exposes a Graphics object', () => {
    assert.ok(bg._gfx !== undefined && bg._gfx !== null);
  });

  // --- Update: scrolling ---

  it('stars move downward on update', () => {
    const before = bg._stars.map(s => s.y);
    bg.update(200); // 200ms
    for (let i = 0; i < bg._stars.length; i++) {
      // Exclude stars that may have wrapped
      if (bg._stars[i].y > before[i]) {
        assert.ok(bg._stars[i].y > before[i], `star ${i} should have moved down`);
      }
    }
  });

  it('y displacement matches speed * dt within floating point tolerance', () => {
    // Pick one specific star and verify the math exactly
    const s = bg._stars[0];
    const initialY = s.y = 100; // fix position to avoid wrap
    const delta = 500; // 500 ms
    const expectedDisplacement = s.speed * (delta / 1000);

    bg.update(delta);

    const actualDisplacement = s.y - initialY;
    assert.ok(
      Math.abs(actualDisplacement - expectedDisplacement) < 0.001,
      `expected Δy ≈ ${expectedDisplacement.toFixed(3)}, got ${actualDisplacement.toFixed(3)}`
    );
  });

  // --- Update: wrapping ---

  it('stars that pass the bottom edge wrap to the top', () => {
    // Force a star past the wrap boundary
    const s = bg._stars[0];
    s.y = HEIGHT + 10; // already past HEIGHT + 2

    bg.update(1); // 1ms — tiny movement, star is already past threshold

    assert.ok(s.y < 10,
      `star should have wrapped near y=0, got y=${s.y}`);
  });

  it('wrapped stars get a new x within canvas bounds', () => {
    for (const s of bg._stars) s.y = HEIGHT + 10;

    bg.update(1);

    for (const s of bg._stars) {
      assert.ok(s.x >= 0 && s.x <= WIDTH,
        `wrapped star.x ${s.x} out of [0, ${WIDTH}]`);
    }
  });

  it('stars at y=0 do not wrap prematurely', () => {
    for (const s of bg._stars) s.y = 0;

    bg.update(16); // one frame (~16ms)

    // With STAR_SPEED_MAX=220, max movement in 16ms = 220*0.016 = 3.52px
    // None should have reached HEIGHT + 2 from y=0
    for (const s of bg._stars) {
      assert.ok(s.y >= 0 && s.y < 10,
        `star moved too far in one frame: y=${s.y}`);
    }
  });
});
