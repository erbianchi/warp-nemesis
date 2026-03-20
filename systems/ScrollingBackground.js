/** @module ScrollingBackground
 * Phase 1: single-layer scrolling starfield. No parallax yet.
 * Stars are rendered via a Graphics object; positions tracked in a plain array. */

import { GAME_CONFIG } from '../config/game.config.js';

const { WIDTH, HEIGHT, STAR_COUNT, STAR_SPEED_MIN, STAR_SPEED_MAX } = GAME_CONFIG;

export class ScrollingBackground {
  /**
   * @param {Phaser.Scene} scene - The scene to render into.
   */
  constructor(scene) {
    this._scene = scene;
    this._stars = [];
    this._gfx = scene.add.graphics();
    this._init();
  }

  /** Populate star data with randomised positions, speeds, and sizes. */
  _init() {
    for (let i = 0; i < STAR_COUNT; i++) {
      const speed = Phaser.Math.FloatBetween(STAR_SPEED_MIN, STAR_SPEED_MAX);
      const t = (speed - STAR_SPEED_MIN) / (STAR_SPEED_MAX - STAR_SPEED_MIN);
      this._stars.push({
        x:     Phaser.Math.Between(0, WIDTH),
        y:     Phaser.Math.Between(0, HEIGHT),
        speed,
        size:  t > 0.65 ? 2 : 1,
        alpha: 0.25 + t * 0.75,
      });
    }
  }

  /**
   * Scroll stars downward and wrap them to the top.
   * @param {number} delta - Milliseconds since last frame.
   */
  update(delta) {
    const dt = delta / 1000;
    this._gfx.clear();

    for (const s of this._stars) {
      s.y += s.speed * dt;
      if (s.y > HEIGHT + 2) {
        s.y = -2;
        s.x = Phaser.Math.Between(0, WIDTH);
      }

      const v = Math.floor(s.alpha * 255);
      this._gfx.fillStyle(Phaser.Display.Color.GetColor(v, v, v), 1);
      this._gfx.fillRect(s.x, s.y, s.size, s.size);
    }
  }
}
