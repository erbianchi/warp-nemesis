/** @module EnemyBase */

import { EVENTS } from '../config/events.config.js';

/**
 * In-browser: Phaser is a CDN global, available before any ES module evaluates.
 * In unit tests: Phaser is absent; use an empty stub so logic tests run without a canvas.
 */
const _BaseSprite = typeof Phaser !== 'undefined'
  ? Phaser.Physics.Arcade.Sprite
  : class {
      constructor(scene, x, y) { this.scene = scene; this.x = x; this.y = y; this.body = null; this.active = true; }
      destroy() { this.active = false; }
    };

/**
 * Abstract base class for all enemies.
 *
 * Concrete enemies (Fighter, Bomber, etc.) extend this and override:
 *   - setupMovement()  — define the movement pattern
 *   - setupWeapon()    — configure the weapon/fire pattern
 *   - onDeath()        — custom death VFX / drops (call super.onDeath() first)
 *
 * Stats are injected at construction time by WaveSpawner after being resolved
 * from the hierarchy: base × level.difficultyBase × wave.difficultyFactor × plane.modifier
 */
export class EnemyBase extends _BaseSprite {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x
   * @param {number} y
   * @param {string} texture
   * @param {object} stats   - Resolved stats from WaveSpawner.resolveStats()
   * @param {number} stats.hp
   * @param {number} stats.damage
   * @param {number} stats.speed
   * @param {number} stats.fireRate    - ms between shots (0 = no ranged attack)
   * @param {number} stats.score
   * @param {number} stats.dropChance
   * @param {number} stats.bulletSpeed
   */
  /**
   * @param {string} dance - Movement pattern key (see DANCES in levels.config.js)
   */
  constructor(scene, x, y, texture, stats, dance = 'straight') {
    super(scene, x, y, texture);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    /** @type {string} */
    this.dance = dance;

    /** @type {number} */
    this.maxHp = stats.hp;
    /** @type {number} */
    this.hp = stats.hp;
    /** @type {number} */
    this.damage = stats.damage;
    /** @type {number} */
    this.speed = stats.speed;
    /** @type {number} */
    this.fireRate = stats.fireRate;
    /** @type {number} */
    this.scoreValue = stats.score;
    /** @type {number} */
    this.dropChance = stats.dropChance;
    /** @type {number} */
    this.bulletSpeed = stats.bulletSpeed;

    /** @type {boolean} */
    this.alive = true;

    /** @type {number} - accumulated ms since last shot */
    this._fireCooldown = 0;

    this.setupMovement();
    this.setupWeapon();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** @param {number} delta - Frame delta in ms */
  update(delta) {
    if (!this.alive) return;
    if (this.y < 0) return; // don't fire until on screen
    this._fireCooldown += delta;
    if (this.fireRate > 0 && this._fireCooldown >= this.fireRate) {
      this._fireCooldown = 0;
      this.fire();
    }
  }

  // ── Combat ────────────────────────────────────────────────────────────

  /**
   * Apply damage to this enemy.
   * @param {number} amount
   */
  takeDamage(amount) {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.die();
    }
  }

  /** Kill this enemy immediately (e.g., nuke / screen-clear). */
  die() {
    if (!this.alive) return;
    this.alive = false;
    this.onDeath();
    this.destroy();
  }

  // ── Overridable hooks ─────────────────────────────────────────────────

  /** Set up the movement pattern. Called once in constructor. */
  setupMovement() {}

  /** Set up the weapon / fire configuration. Called once in constructor. */
  setupWeapon() {}

  /** Fire a projectile. Called by update() when fireRate cooldown elapses. */
  fire() {}

  /**
   * Called on death before destroy(). Override for custom VFX / drops.
   * Always call super.onDeath() when overriding.
   */
  onDeath() {
    this.scene.events.emit(EVENTS.ENEMY_DIED, {
      x:          this.x,
      y:          this.y,
      score:      this.scoreValue,
      dropChance: this.dropChance,
    });
  }
}
