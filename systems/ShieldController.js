/** @module ShieldController
 * Reusable shield logic + visuals attachable to any game object. */

import { GAME_CONFIG } from '../config/game.config.js';

const DEFAULT_COLOR = 0x7fd8ff;
const DEFAULT_FILL_ALPHA = 0.12;
const DEFAULT_STROKE_ALPHA = 0.85;
const DEFAULT_PULSE_MS = 720;
const DEFAULT_HIT_MS = 110;
const BAR_HEIGHT = 4;
const BAR_INSET = 1;
const BAR_BG_COLOR = 0x081018;
const BAR_BORDER_COLOR = 0xbfe8ff;
const UNIVERSAL_SHIELD_MAX = GAME_CONFIG.PLAYER_SHIELD_MAX;

/**
 * Routes incoming damage through the current shield pool.
 * @param {number} shieldPoints
 * @param {number} damage
 * @returns {{absorbed: number, overflow: number, remaining: number}}
 */
export function resolveShieldDamage(shieldPoints, damage) {
  const safeShield = Math.max(0, shieldPoints ?? 0);
  const safeDamage = Math.max(0, damage ?? 0);
  const absorbed = Math.min(safeShield, safeDamage);

  return {
    absorbed,
    overflow: safeDamage - absorbed,
    remaining: safeShield - absorbed,
  };
}

export class ShieldController {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} target
   * @param {object} [opts]
   * @param {number} [opts.points=0]
   * @param {number} [opts.maxPoints=opts.points]
   * @param {number} [opts.radius=20]
   * @param {number} [opts.color=0x7fd8ff]
   * @param {number} [opts.depthOffset=1]
   * @param {'top'|'bottom'} [opts.barPlacement='top']
   * @param {EffectsSystem} [opts.effects]
   * @param {(payload: object) => void} [opts.onChange]
   * @param {(payload: object) => void} [opts.onBreak]
   */
  constructor(scene, target, opts = {}) {
    this._scene = scene;
    this._target = target;
    this._effects = opts.effects ?? null;
    this._color = opts.color ?? DEFAULT_COLOR;
    this._baseRadius = opts.radius ?? 20;
    this._depthOffset = opts.depthOffset ?? 1;
    this._barPlacement = opts.barPlacement === 'bottom' ? 'bottom' : 'top';
    this._onChange = opts.onChange ?? null;
    this._onBreak = opts.onBreak ?? null;

    const requestedCapacity = opts.maxPoints;
    this._maxPoints = this._clampShieldCapacity(
      requestedCapacity == null || requestedCapacity <= 0
        ? UNIVERSAL_SHIELD_MAX
        : requestedCapacity
    );
    this._points = Math.min(Math.max(0, opts.points ?? 0), this._maxPoints);

    this._ring = null;
    this._barBg = null;
    this._barFill = null;
    this._pulseTween = null;
    this._hitTween = null;
    this._glowTween = null;

    this._boundSync = () => this.sync();
    this._scene.events?.on?.('update', this._boundSync);

    if (this._points > 0) this._ensureVisual();
    this._emitChange({ delta: 0, absorbed: 0, overflow: 0, depleted: false });
  }

  /** @returns {number} */
  get points() {
    return this._points;
  }

  /** @returns {number} */
  get maxPoints() {
    return this._maxPoints;
  }

  /** @returns {boolean} */
  get active() {
    return this._points > 0;
  }

  /**
   * Set the shield maximum and clamp the current points into range.
   * @param {number} maxPoints
   * @returns {number}
   */
  setMaxPoints(maxPoints) {
    this._maxPoints = this._clampShieldCapacity(maxPoints);
    this._points = Math.min(this._points, this._maxPoints);
    this._refreshVisual();
    this._emitChange({ delta: 0, absorbed: 0, overflow: 0, depleted: this._points === 0 });
    return this._maxPoints;
  }

  /**
   * Set the current shield points.
   * @param {number} points
   * @returns {number}
   */
  setPoints(points, opts = {}) {
    const nextPoints = Math.max(0, points ?? 0);
    const allowMaxGrowth = opts.allowMaxGrowth === true;
    if (allowMaxGrowth && nextPoints > this._maxPoints) {
      this._maxPoints = this._clampShieldCapacity(nextPoints);
    }
    this._points = Math.min(nextPoints, this._maxPoints);
    this._refreshVisual();
    this._emitChange({ delta: 0, absorbed: 0, overflow: 0, depleted: this._points === 0 });
    return this._points;
  }

  /**
   * Add shield points, clamped to maxPoints.
   * @param {number} amount
   * @returns {number}
   */
  addPoints(amount, opts = {}) {
    if ((amount ?? 0) <= 0) return this._points;
    if (this._maxPoints <= 0) {
      return this.setPoints(this._points + amount, { ...opts, allowMaxGrowth: true });
    }
    return this.setPoints(this._points + amount, opts);
  }

  /**
   * Absorb damage into the shield before HP takes any overflow.
   * @param {number} damage
   * @returns {{absorbed: number, overflow: number, remaining: number, depleted: boolean}}
   */
  takeDamage(damage) {
    const result = resolveShieldDamage(this._points, damage);
    const hadShield = this._points > 0;
    this._points = result.remaining;

    if (result.absorbed > 0) {
      this._playHitAnimation();
      this._effects?.showDamageNumber?.(
        this._target?.x ?? 0,
        (this._target?.y ?? 0) - this._baseRadius * 0.45,
        result.absorbed,
        { color: '#bfe8ff' }
      );
    }

    const depleted = hadShield && this._points === 0 && result.absorbed > 0;
    if (depleted) this._break();
    else this._refreshVisual();

    this._emitChange({
      delta: -result.absorbed,
      absorbed: result.absorbed,
      overflow: result.overflow,
      depleted,
    });

    return { ...result, depleted };
  }

  /** Follow the target every frame. */
  sync() {
    if ((!this._ring && !this._barBg && !this._barFill) || !this._target) return;
    if (this._target.active === false || this._target.visible === false) {
      this._ring.setVisible?.(false);
      this._barBg?.setVisible?.(false);
      this._barFill?.setVisible?.(false);
      return;
    }

    const scaleX = Math.abs(this._target.scaleX ?? 1);
    const scaleY = Math.abs(this._target.scaleY ?? 1);
    const scale = Math.max(scaleX, scaleY, 1);
    const depth = (this._target.depth ?? 0) + this._depthOffset;
    const barWidth = this._resolveBarWidth();
    const barLeft = this._resolveBarLeft(barWidth);
    const barRatio = this._maxPoints > 0 ? Math.max(0, Math.min(1, this._points / this._maxPoints)) : 0;
    const innerBarWidth = Math.max(0, barWidth - BAR_INSET * 2);
    const fillWidth = innerBarWidth * barRatio;
    const targetHeight = this._resolveTargetHeight();
    const barY = this._resolveBarY(targetHeight);

    if (this._ring) {
      this._ring.x = this._target.x;
      this._ring.y = this._target.y;
      this._ring.setScale?.(scale, scale);
      this._ring.setDepth?.(depth);
      this._ring.setVisible?.(this._points > 0);
    }

    if (this._barBg) {
      this._barBg.x = barLeft;
      this._barBg.y = barY;
      this._barBg.width = barWidth;
      this._barBg.displayWidth = barWidth;
      this._barBg.displayHeight = BAR_HEIGHT;
      this._barBg.setDepth?.(depth + 0.1);
      this._barBg.setVisible?.(this._points > 0);
    }

    if (this._barFill) {
      this._barFill.x = barLeft + BAR_INSET;
      this._barFill.y = barY;
      this._barFill.width = fillWidth;
      this._barFill.displayWidth = fillWidth;
      this._barFill.displayHeight = Math.max(2, BAR_HEIGHT - 2);
      this._barFill.setDepth?.(depth + 0.2);
      this._barFill.setVisible?.(this._points > 0 && barRatio > 0);
    }
  }

  /** Destroy all visuals and detach listeners. */
  destroy() {
    this._pulseTween?.stop?.();
    this._hitTween?.stop?.();
    this._glowTween?.stop?.();
    this._ring?.destroy?.();
    this._barBg?.destroy?.();
    this._barFill?.destroy?.();
    this._ring = null;
    this._barBg = null;
    this._barFill = null;
    this._scene.events?.off?.('update', this._boundSync);
  }

  _ensureVisual() {
    if (this._points <= 0) return;

    if (!this._ring) {
      const circle = this._scene.add?.circle?.(
        this._target?.x ?? 0,
        this._target?.y ?? 0,
        this._baseRadius,
        this._color,
        DEFAULT_FILL_ALPHA
      );

      if (circle) {
        circle.setStrokeStyle?.(2, this._color, DEFAULT_STROKE_ALPHA);
        circle.setDepth?.((this._target?.depth ?? 0) + this._depthOffset);
        circle.setVisible?.(true);
        this._attachGlow(circle);
        this._ring = circle;
        this._pulseTween = this._scene.tweens?.add?.({
          targets:  circle,
          alpha:    { from: 0.28, to: 0.72 },
          scaleX:   { from: 0.96, to: 1.08 },
          scaleY:   { from: 0.96, to: 1.08 },
          duration: DEFAULT_PULSE_MS,
          ease:     'Sine.easeInOut',
          yoyo:     true,
          repeat:   -1,
        }) ?? null;
      }
    }

    if (!this._barBg) {
      this._barBg = this._scene.add?.rectangle?.(
        this._resolveBarLeft(this._resolveBarWidth()),
        this._resolveBarY(this._resolveTargetHeight()),
        this._resolveBarWidth(),
        BAR_HEIGHT,
        BAR_BG_COLOR
      ) ?? null;
      this._barBg?.setDepth?.((this._target?.depth ?? 0) + this._depthOffset + 1);
      this._barBg?.setOrigin?.(0, 0.5);
      this._barBg?.setStrokeStyle?.(1, BAR_BORDER_COLOR, 0.9);
      this._barBg?.setVisible?.(true);
    }

    if (!this._barFill) {
      this._barFill = this._scene.add?.rectangle?.(
        this._resolveBarLeft(this._resolveBarWidth()) + BAR_INSET,
        this._resolveBarY(this._resolveTargetHeight()),
        Math.max(0, this._resolveBarWidth() - BAR_INSET * 2),
        Math.max(2, BAR_HEIGHT - 2),
        this._color
      ) ?? null;
      this._barFill?.setDepth?.((this._target?.depth ?? 0) + this._depthOffset + 2);
      this._barFill?.setOrigin?.(0, 0.5);
      this._barFill?.setVisible?.(true);
    }

    this.sync();
  }

  _refreshVisual() {
    if (this._points > 0) {
      this._ensureVisual();
      this.sync();
      return;
    }

    this._pulseTween?.stop?.();
    this._pulseTween = null;
    this._hitTween?.stop?.();
    this._hitTween = null;
    this._glowTween?.stop?.();
    this._glowTween = null;
    this._ring?.destroy?.();
    this._barBg?.destroy?.();
    this._barFill?.destroy?.();
    this._ring = null;
    this._barBg = null;
    this._barFill = null;
  }

  _playHitAnimation() {
    this._ensureVisual();
    if (!this._ring) return;

    this._hitTween?.stop?.();
    this._ring.setAlpha?.(0.95);
    this._ring.setScale?.(1.16, 1.16);

    this._hitTween = this._scene.tweens?.add?.({
      targets:  this._ring,
      alpha:    0.6,
      scaleX:   1,
      scaleY:   1,
      duration: DEFAULT_HIT_MS,
      ease:     'Quad.easeOut',
    }) ?? null;
  }

  _break() {
    const x = this._target?.x ?? 0;
    const y = this._target?.y ?? 0;
    const radius = this._baseRadius;

    this._effects?.explodeShield?.(x, y, radius);
    this._refreshVisual();
    this._onBreak?.({ points: 0, maxPoints: this._maxPoints, x, y, radius });
  }

  _emitChange(payload) {
    this._onChange?.({
      points: this._points,
      maxPoints: this._maxPoints,
      active: this._points > 0,
      ...payload,
    });
  }

  _attachGlow(circle) {
    const fx = circle.preFX ?? circle.postFX;
    const glow = fx?.addGlow?.(this._color, 6, 0, false, 0.16, 16);
    if (!glow) return;

    this._glowTween = this._scene.tweens?.add?.({
      targets:  glow,
      outerStrength: { from: 4, to: 10 },
      duration: DEFAULT_PULSE_MS,
      ease:     'Sine.easeInOut',
      yoyo:     true,
      repeat:   -1,
    });
  }

  _resolveBarWidth() {
    const targetWidth = this._resolveTargetWidth();
    return Math.max(8, targetWidth * 0.82);
  }

  _resolveBarY(targetHeight = this._resolveTargetHeight()) {
    const targetY = this._target?.y ?? 0;
    const offset = targetHeight * 0.5 + 8;
    return this._barPlacement === 'bottom'
      ? targetY + offset
      : targetY - offset;
  }

  _resolveBarLeft(barWidth = this._resolveBarWidth()) {
    const targetX = this._target?.x ?? 0;
    return targetX - barWidth / 2;
  }

  _resolveTargetWidth() {
    const width = this._target?.displayWidth
      ?? this._target?.width
      ?? this._baseRadius * 1.6;
    return Math.max(8, width);
  }

  _resolveTargetHeight() {
    const height = this._target?.displayHeight
      ?? this._target?.height
      ?? this._baseRadius * 1.6;
    return Math.max(8, height);
  }

  _clampShieldCapacity(points) {
    return Math.max(0, Math.min(UNIVERSAL_SHIELD_MAX, points ?? UNIVERSAL_SHIELD_MAX));
  }
}
