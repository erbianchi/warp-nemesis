/** @module Raptor */

import { EnemyBase } from '../EnemyBase.js';
import { GAME_CONFIG } from '../../config/game.config.js';

const RAPTOR_WIDTH = 40;
const RAPTOR_HEIGHT = 32;
const RAPTOR_BULLET_WIDTH = 7;
const RAPTOR_BULLET_HEIGHT = 22;
const RAPTOR_BULLET_COLOR = 0x4ab8ff;
const DIAGONAL_COMPONENT = Math.SQRT1_2;
const { WIDTH: W, HEIGHT: H } = GAME_CONFIG;
const RAPTOR_SCREEN_MARGIN_X = 56;
const RAPTOR_SCREEN_MARGIN_TOP = 96;
const RAPTOR_SCREEN_MARGIN_BOTTOM = 156;
const STAR_DIRECTIONS = Object.freeze([
  { x: 0, y: 1 },
  { x: DIAGONAL_COMPONENT, y: DIAGONAL_COMPONENT },
  { x: 1, y: 0 },
  { x: DIAGONAL_COMPONENT, y: -DIAGONAL_COMPONENT },
  { x: 0, y: -1 },
  { x: -DIAGONAL_COMPONENT, y: -DIAGONAL_COMPONENT },
  { x: -1, y: 0 },
  { x: -DIAGONAL_COMPONENT, y: DIAGONAL_COMPONENT },
]);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Raptor — heavy slow gunship with shielded bulk and a radial 8-way burst.
 */
export class Raptor extends EnemyBase {
  constructor(scene, x, y, stats, dance = 'side_left') {
    super(scene, x, y, 'raptor', stats, dance);

    this._baseDisplayWidth = RAPTOR_WIDTH;
    this._baseDisplayHeight = RAPTOR_HEIGHT;
    this.setDisplaySize?.(RAPTOR_WIDTH, RAPTOR_HEIGHT);
    this.body?.setSize?.(36, 28, true);
    this._shield._baseRadius = 22;
    this._persistUntilDestroyed = true;
    this._laneClock = 0;
  }

  setupMovement() {
    this.body.setVelocity(0, 0);
    this._sideDir = this.dance === 'side_right' ? -1 : 1;
    const entryPlan = this.resolveAdaptiveMovePlan(
      this._sideDir > 0 ? W * 0.26 : W * 0.74,
      {
        candidateY: this.y,
        rangePx: 90,
        yRangePx: 48,
        marginPx: RAPTOR_SCREEN_MARGIN_X,
        topMarginPx: RAPTOR_SCREEN_MARGIN_TOP,
        bottomMarginPx: H - RAPTOR_SCREEN_MARGIN_BOTTOM,
      }
    );
    this._entryTargetX = entryPlan.x;
    this._anchorX = this._entryTargetX;
    this._anchorY = clamp(this.y, RAPTOR_SCREEN_MARGIN_TOP + 8, H - RAPTOR_SCREEN_MARGIN_BOTTOM);
    this._entrySpeedX = this.speed * 3.4;
    this._entryWaveY = 16;
    this._patrolRangeX = 90;
    this._patrolRangeY = 110;
    this._patrolLerpX = 3.2;
    this._patrolLerpY = 2.8;
    this._lanePhase = Math.random() * Math.PI * 2;
    this._adaptiveDecisionCooldownMs = 0;
    this._adaptiveTargetX = this._entryTargetX;
  }

  setupWeapon() {}

  getNativeFireBursts(speed = this.bulletSpeed) {
    return STAR_DIRECTIONS.map(direction => ({
      vx: direction.x * speed,
      vy: direction.y * speed,
      width: RAPTOR_BULLET_WIDTH,
      height: RAPTOR_BULLET_HEIGHT,
      color: RAPTOR_BULLET_COLOR,
    }));
  }

  update(delta) {
    if (!this.alive) return;
    this._advanceFlight(delta);
    super.update(delta);
  }

  fire() {
    this.emitNativeFireBursts();
  }

  _advanceFlight(delta) {
    const dt = delta / 1000;
    this._laneClock += delta;

    const stillEntering = this._sideDir > 0
      ? this.x < this._entryTargetX
      : this.x > this._entryTargetX;

    if (stillEntering) {
      const nextX = this.x + this._sideDir * this._entrySpeedX * dt;
      this.x = this._sideDir > 0
        ? Math.min(nextX, this._entryTargetX)
        : Math.max(nextX, this._entryTargetX);

      const targetY = clamp(
        this._anchorY + Math.sin(this._laneClock / 880 + this._lanePhase) * this._entryWaveY,
        RAPTOR_SCREEN_MARGIN_TOP,
        H - RAPTOR_SCREEN_MARGIN_BOTTOM
      );
      this.y += (targetY - this.y) * Math.min(1, dt * 2.4);
      return;
    }

    if (!this.canUseAdaptiveBehavior()) {
      this.unlockAdaptiveBehavior();
    }

    const baseTargetX = this._anchorX + Math.sin(this._laneClock / 1000 + this._lanePhase) * this._patrolRangeX;
    const targetY = clamp(
      this._anchorY + Math.sin(this._laneClock / 760 + this._lanePhase * 0.85) * this._patrolRangeY,
      RAPTOR_SCREEN_MARGIN_TOP,
      H - RAPTOR_SCREEN_MARGIN_BOTTOM
    );
    this._adaptiveDecisionCooldownMs -= delta;

    if (this._adaptiveDecisionCooldownMs <= 0) {
      const plan = this.resolveAdaptiveMovePlan(baseTargetX, {
        candidateY: targetY,
        rangePx: 72,
        marginPx: RAPTOR_SCREEN_MARGIN_X,
        yRangePx: 64,
        topMarginPx: RAPTOR_SCREEN_MARGIN_TOP,
        bottomMarginPx: H - RAPTOR_SCREEN_MARGIN_BOTTOM,
      });
      this._adaptiveTargetX = plan.x;
      this._anchorY = plan.y;
      this._adaptiveDecisionCooldownMs = 180;
    }

    this.x += (this._adaptiveTargetX - this.x) * Math.min(1, dt * this._patrolLerpX * (this.adaptiveProfile?.currentSpeedScalar ?? 1));
    this.y += (this._anchorY - this.y) * Math.min(1, dt * this._patrolLerpY);
  }
}
