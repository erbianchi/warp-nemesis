/** @module BonusPickup */

import { BONUS_PICKUP_MOTION } from '../config/bonuses.config.js';
import { ShieldController } from '../systems/ShieldController.js';

const _BaseSprite = typeof Phaser !== 'undefined'
  ? Phaser.Physics.Arcade.Sprite
  : class {
      constructor(scene, x, y, texture) {
        this.scene = scene;
        this.x = x;
        this.y = y;
        this.texture = texture;
        this.body = null;
        this.active = true;
        this.visible = true;
        this.rotation = 0;
      }
      destroy() { this.active = false; }
      setActive(v) { this.active = v; return this; }
      setVisible(v) { this.visible = v; return this; }
      setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; }
    };

export class BonusPickup extends _BaseSprite {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x
   * @param {number} y
   * @param {object} config
   * @param {object} [opts]
   * @param {EffectsSystem} [opts.effects]
   * @param {number} [opts.fallSpeed=BONUS_PICKUP_MOTION.fallSpeed]
   * @param {number} [opts.shieldPoints=0]
   * @param {Function} [opts.rng=Math.random]
   */
  constructor(scene, x, y, config, opts = {}) {
    super(scene, x, y, 'bonus_octagon');

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.bonusKey = config.key;
    this.bonusConfig = config;
    this.fallSpeed = opts.fallSpeed ?? BONUS_PICKUP_MOTION.fallSpeed;
    this._baseScale = 1;
    this._bobTime = 0;
    this._spinRate = ((opts.rng ?? Math.random)() - 0.5) * 3.2;

    this.body.setVelocity?.(0, 0);
    this.body.allowGravity = false;
    this.body.setAllowGravity?.(false);

    const shieldPoints = Math.max(0, opts.shieldPoints ?? 0);
    this._shield = new ShieldController(scene, this, {
      effects:   opts.effects,
      points:    shieldPoints,
      radius:    18,
      depthOffset: 2,
    });
  }

  /** @returns {boolean} */
  canCollect() {
    return this.active && !(this._shield?.active);
  }

  /**
   * @param {number} delta
   */
  update(delta) {
    if (!this.active) return;

    const dt = delta / 1000;
    this.y += this.fallSpeed * dt;
    this.rotation += this._spinRate * dt;
    this._bobTime += dt * 5;

    const scale = this._baseScale + Math.sin(this._bobTime) * 0.04;
    this.setScale?.(scale, scale);
    this._shield.sync();
    this.body?.updateFromGameObject?.();
  }

  /**
   * Route damage through the optional shield. Bonuses persist after the shell breaks.
   * @param {number} amount
   * @returns {{absorbed: number, overflow: number, remaining: number, depleted: boolean}}
   */
  takeDamage(amount) {
    return this._shield.takeDamage(amount);
  }

  /** Remove this pickup without playing any extra effect. */
  remove() {
    if (!this.active) return;
    this.setActive(false).setVisible(false);
    this.body?.stop?.();
    if (this.body) this.body.enable = false;
    this.destroy();
  }

  destroy(fromScene) {
    this._shield?.destroy();
    this._shield = null;
    super.destroy?.(fromScene);
  }
}
