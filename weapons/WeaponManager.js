/** @module WeaponManager
 * Manages the player's 2 weapon slots.
 * Slot 0 starts loaded with the laser; slot 1 starts empty.
 * Owns the bullet pool for each equipped weapon. */

import { GAME_CONFIG } from '../config/game.config.js';
import { WEAPONS }     from '../config/weapons.config.js';

export class WeaponManager {
  /**
   * @param {Phaser.Scene} scene
   */
  constructor(scene) {
    this._scene = scene;

    /** @type {Array<string|null>} weapon key per slot, null = empty */
    this._slots = Array(GAME_CONFIG.WEAPON_SLOTS).fill(null);
    this._slots[0] = 'laser';

    this._cooldown = 0;
    this._cfg      = WEAPONS[this._slots[0]];

    this._pool = scene.physics.add.group({
      classType:      Phaser.Physics.Arcade.Image,
      defaultKey:     'bullet_laser',
      maxSize:        this._cfg.poolSize,
      runChildUpdate: false,
      allowGravity:   false,
    });
  }

  /** The bullet group — used by CollisionSystem to register overlaps. */
  get pool() { return this._pool; }

  /** Damage dealt per bullet by the currently active weapon. */
  get damage() { return this._cfg.damage; }

  /**
   * Returns a snapshot of all slots for UI rendering.
   * Populated slots return `{ key, name, color }`; empty slots return `null`.
   * @returns {Array<{key: string, name: string, color: number}|null>}
   */
  getSlots() {
    return this._slots.map(key =>
      key ? { key, name: key.toUpperCase(), color: WEAPONS[key].color } : null
    );
  }

  /**
   * Tick cooldown and recycle bullets that have left the canvas.
   * Call once per frame before tryFire.
   * @param {number} delta - ms since last frame
   */
  update(delta) {
    this._cooldown = Math.max(0, this._cooldown - delta);

    for (const b of this._pool.getChildren()) {
      if (b.active && b.y < -20) {
        this._pool.killAndHide(b);
        b.body.stop();
        b.body.enable = false;
      }
    }
  }

  /**
   * Fire slot 0's weapon from (x, y) if the cooldown has elapsed.
   * Safe to call every frame while the fire key is held.
   * @param {number} x
   * @param {number} y
   */
  tryFire(x, y) {
    if (this._cooldown > 0 || !this._slots[0]) return;

    const bullet = this._pool.get(x, y - 18);
    if (!bullet) return;

    bullet.setActive(true).setVisible(true);
    bullet.body.reset(x, y - 18);
    bullet.body.enable = true;
    bullet.body.setVelocityY(-this._cfg.speed);
    bullet.body.allowGravity = false;

    this._cooldown = this._cfg.fireRate;
  }
}
