/** @module ScrollingBackground
 * Single-layer scrolling starfield with an optional warp-exit mode.
 * Stars are rendered via a Graphics object; positions tracked in a plain array. */

import { GAME_CONFIG } from '../config/game.config.js';

const { WIDTH, HEIGHT, STAR_COUNT, STAR_SPEED_MIN, STAR_SPEED_MAX } = GAME_CONFIG;
const WARP_SPEED_BOOST = 14;
const WARP_TRAIL_MIN = 6;
const WARP_TRAIL_MAX = 30;
const WARP_BRIGHTEN = 0.2;
const FADE_OVERLAY_DEPTH = 19;

export class ScrollingBackground {
  /**
   * @param {Phaser.Scene} scene - The scene to render into.
   */
  constructor(scene) {
    this._scene = scene;
    this._stars = [];
    this._gfx = scene.add.graphics();
    this._fadeOverlay = scene.add.rectangle(0, 0, WIDTH, HEIGHT, 0x000000)
      .setOrigin(0, 0)
      .setDepth(FADE_OVERLAY_DEPTH)
      .setAlpha(0);
    this._warpActive = false;
    this._warpElapsedMs = 0;
    this._warpDurationMs = 1;
    this._warpProgress = 0;
    this._fadeActive = false;
    this._fadeElapsedMs = 0;
    this._fadeDurationMs = 1;
    this._fadeProgress = 0;
    this._starsHidden = false;
    this._init();
  }

  /**
   * Ramp the starfield into a speed-line warp effect.
   * @param {number} [durationMs=1200]
   */
  startWarpExit(durationMs = 1200) {
    this._warpActive = true;
    this._warpElapsedMs = 0;
    this._warpDurationMs = Math.max(1, durationMs);
    this._warpProgress = 0;
    this._fadeActive = false;
    this._fadeElapsedMs = 0;
    this._fadeProgress = 0;
    this._starsHidden = false;
    this._fadeOverlay.setAlpha?.(0);
  }

  /** Stop the warp effect and return to normal star drift. */
  stopWarpExit() {
    this._warpActive = false;
    this._warpElapsedMs = 0;
    this._warpProgress = 0;
  }

  /**
   * Stop drawing the starfield and fade to black.
   * @param {number} [durationMs=600]
   */
  fadeToBlack(durationMs = 600) {
    this.stopWarpExit();
    this._fadeActive = true;
    this._fadeElapsedMs = 0;
    this._fadeDurationMs = Math.max(1, durationMs);
    this._fadeProgress = 0;
    this._starsHidden = true;
    this._gfx.clear();
    this._fadeOverlay.setAlpha?.(0);
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
    if (this._fadeActive) {
      this._fadeElapsedMs += delta;
      this._fadeProgress = Math.min(1, this._fadeElapsedMs / this._fadeDurationMs);
      this._fadeOverlay.setAlpha?.(this._fadeProgress);
      this._gfx.clear();
      if (this._fadeProgress === 1) this._fadeActive = false;
      return;
    }

    if (this._starsHidden) {
      this._gfx.clear();
      return;
    }

    const dt = delta / 1000;
    if (this._warpActive) {
      this._warpElapsedMs += delta;
      this._warpProgress = Math.min(1, this._warpElapsedMs / this._warpDurationMs);
    } else {
      this._warpProgress = 0;
    }

    const speedScale = 1 + this._warpProgress * WARP_SPEED_BOOST;
    this._gfx.clear();

    for (const s of this._stars) {
      const speedRatio = (s.speed - STAR_SPEED_MIN) / (STAR_SPEED_MAX - STAR_SPEED_MIN);
      s.y += s.speed * speedScale * dt;
      if (s.y > HEIGHT + 2) {
        s.y = -2;
        s.x = Phaser.Math.Between(0, WIDTH);
      }

      const alpha = Math.min(1, s.alpha + this._warpProgress * WARP_BRIGHTEN);
      const v = Math.floor(alpha * 255);
      const trailHeight = s.size + Math.round(
        this._warpProgress * (WARP_TRAIL_MIN + speedRatio * (WARP_TRAIL_MAX - WARP_TRAIL_MIN))
      );
      const drawY = s.y - trailHeight + s.size;
      this._gfx.fillStyle(Phaser.Display.Color.GetColor(v, v, v), 1);
      this._gfx.fillRect(s.x, drawY, s.size, trailHeight);
    }
  }
}
