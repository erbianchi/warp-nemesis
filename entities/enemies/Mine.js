/** @module Mine */

import { EnemyBase } from '../EnemyBase.js';
import { GAME_CONFIG } from '../../config/game.config.js';

const MINE_SIZE = 28;
const MINE_BODY_SIZE = 20;
const DRIFT_RANGE_X = 30;
const DRIFT_LERP = 1.2;
const SCREEN_MARGIN_X = 34;
const DEFAULT_DANCE = 'creep_drop';
const { WIDTH: W } = GAME_CONFIG;
const MINE_GRAVITY_WELL = Object.freeze({
  radius: 78,
  pullRadius: 300,
  pullStrength: 3600,
  power: 14,
  epsilon: 120,
  gravity: 360,
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Mine — slow gravity hazard that drifts down the screen and pulls the player in.
 */
export class Mine extends EnemyBase {
  constructor(scene, x, y, stats, dance = DEFAULT_DANCE) {
    super(scene, x, y, 'mine', stats, dance);

    this._baseDisplayWidth = MINE_SIZE;
    this._baseDisplayHeight = MINE_SIZE;
    this.setDisplaySize?.(MINE_SIZE, MINE_SIZE);
    this.body?.setSize?.(MINE_BODY_SIZE, MINE_BODY_SIZE, true);

    this._driftClock = 0;
    this._anchorX = x;
    this._driftPhase = Math.random() * Math.PI * 2;
    this._gravityWell = scene._effects?.createGravityWell?.(
      this,
      scene._player,
      MINE_GRAVITY_WELL
    ) ?? null;
  }

  setupMovement() {
    this.body?.setVelocity?.(0, 0);
  }

  setupWeapon() {}

  update(delta) {
    if (!this.alive) return;
    this._advanceFlight(delta);
    this._gravityWell?.update?.(delta);
    super.update(delta);
  }

  onDeath(opts = {}) {
    super.onDeath(opts);
  }

  onDestroy(fromScene) {
    this._gravityWell?.destroy?.();
    this._gravityWell = null;
  }

  _advanceFlight(delta) {
    const dt = delta / 1000;
    this._driftClock += delta;
    this.y += this.speed * dt;

    const targetX = clamp(
      this._anchorX + Math.sin(this._driftClock / 1150 + this._driftPhase) * DRIFT_RANGE_X,
      SCREEN_MARGIN_X,
      W - SCREEN_MARGIN_X
    );
    this.x += (targetX - this.x) * Math.min(1, dt * DRIFT_LERP);
  }
}
