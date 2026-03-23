/** @module EnemyBase */

import { EVENTS } from '../config/events.config.js';
import { ShieldController } from '../systems/ShieldController.js';

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
   * @param {number} [stats.contactDamage]
   * @param {number} stats.speed
   * @param {number} stats.fireRate    - ms between shots (0 = no ranged attack)
   * @param {number} stats.score
   * @param {number} stats.dropChance
   * @param {number} stats.bulletSpeed
   * @param {number} [stats.shield]
   */
  /**
   * @param {string} dance - Movement pattern key (see DANCES in levels.config.js)
   */
  constructor(scene, x, y, texture, stats, dance = 'straight') {
    super(scene, x, y, texture);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    /** @type {string} */
    this.enemyType = texture;
    /** @type {string} */
    this.dance = dance;

    /** @type {number} */
    this.maxHp = stats.hp;
    /** @type {number} */
    this.hp = stats.hp;
    /** @type {number} */
    this.maxShield = Math.max(0, stats.shield ?? 0);
    /** @type {number} */
    this.shield = this.maxShield;
    /** @type {number} */
    this.damage = stats.damage;
    /** @type {number} */
    this.contactDamage = stats.contactDamage ?? stats.damage;
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
    /** @type {boolean} */
    this._destroyed = false;

    /** @type {number} - accumulated ms since last shot */
    this._fireCooldown = 0;

    // Velocity tracking (position-diff each frame — works for tween-driven movement)
    this._prevX = x;
    this._prevY = y;
    this._velX  = 0;
    this._velY  = 0;

    // Spring-damped push offset — applied on top of tween position each frame
    this._pushOffX = 0; // current displacement from tween path
    this._pushOffY = 0;
    this._pushVx   = 0; // velocity of the displacement
    this._pushVy   = 0;
    this._shield   = new ShieldController(scene, this, {
      effects:      scene._effects,
      points:       this.shield,
      radius:       16,
      depthOffset:  1,
      onChange:     ({ points, maxPoints }) => {
        this.shield = points;
        this.maxShield = maxPoints;
      },
    });
    this.setupMovement();
    this.setupWeapon();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** @param {number} delta - Frame delta in ms */
  update(delta) {
    if (!this.alive) return;

    // Track velocity from position delta (works for tween-driven movement)
    const dt = delta / 1000;
    if (dt > 0) {
      this._velX = (this.x - this._prevX) / dt;
      this._velY = (this.y - this._prevY) / dt;
    }
    this._prevX = this.x;
    this._prevY = this.y;

    // Spring-damped turbulence: displacement offset applied on top of tween position.
    // Spring pulls offset back to zero → plane returns smoothly to its flight path.
    // Overdamped (ζ > 1) → no oscillation, pure smooth glide.
    if (this._pushVx !== 0 || this._pushVy !== 0 ||
        this._pushOffX !== 0 || this._pushOffY !== 0) {
      const SPRING  = 10; // restoring force per px of offset
      const DAMPING = 12; // ζ = 12/(2√10) ≈ 1.9 → overdamped, no bounce
      const MAX_STEP = 1 / 60;
      let remaining = dt;
      let moved     = false;

      while (remaining > 0 && (
        this._pushVx !== 0 || this._pushVy !== 0 ||
        this._pushOffX !== 0 || this._pushOffY !== 0
      )) {
        const step = Math.min(remaining, MAX_STEP);
        remaining -= step;

        const ax = -SPRING * this._pushOffX - DAMPING * this._pushVx;
        const ay = -SPRING * this._pushOffY - DAMPING * this._pushVy;

        this._pushVx += ax * step;
        this._pushVy += ay * step;

        const dx = this._pushVx * step;
        const dy = this._pushVy * step;
        this._pushOffX += dx;
        this._pushOffY += dy;
        this.x += dx;
        this.y += dy;
        moved = moved || dx !== 0 || dy !== 0;

        if (Math.abs(this._pushVx)   < 0.5 && Math.abs(this._pushVy)   < 0.5 &&
            Math.abs(this._pushOffX) < 0.5 && Math.abs(this._pushOffY) < 0.5) {
          this.x -= this._pushOffX; // remove residual sub-pixel offset
          this.y -= this._pushOffY;
          this._pushOffX = 0; this._pushOffY = 0;
          this._pushVx   = 0; this._pushVy   = 0;
          moved = true;
          break;
        }
      }

      if (moved) this._syncBodyToSprite();
    }

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
   * @param {number} [scoreMultiplier=1]
   */
  takeDamage(amount, scoreMultiplier = 1) {
    if (!this.alive) return;
    const shieldResult = this._shield.takeDamage(amount);
    if (shieldResult.overflow <= 0) return;

    this.hp -= shieldResult.overflow;
    if (this.hp <= 0) {
      this.hp = 0;
      this.die({ scoreMultiplier });
    }
  }

  /**
   * Apply a velocity impulse to the spring-damped offset.
   * The offset is added on top of the tween-driven position each frame,
   * and the spring pulls it back to zero — the plane returns to its flight path
   * with natural, smooth deceleration (no snap, no oscillation).
   * @param {number} vx
   * @param {number} vy
   */
  applyPush(vx, vy) {
    this._pushVx += vx;
    this._pushVy += vy;
  }

  /** Sync the Arcade body after manual displacement so visuals and hitbox stay aligned. */
  _syncBodyToSprite() {
    if (!this.body || typeof this.body.updateFromGameObject !== 'function') return;
    this.body.updateFromGameObject();
  }

  /**
   * Kill this enemy immediately (e.g., nuke / screen-clear).
   * @param {{scoreMultiplier?: number}} [opts]
   */
  die(opts = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.onDeath(opts);
    this.destroy();
  }

  /**
   * Destroy shared enemy resources and Phaser state.
   * Silent destroys (off-screen exits, scene cleanup) should call this directly.
   * Death effects and score are emitted separately through die()/onDeath().
   * @param {boolean} [fromScene]
   * @returns {object|undefined}
   */
  destroy(fromScene) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.alive = false;
    this._shield?.destroy?.();
    this.onDestroy(fromScene);
    return super.destroy?.(fromScene);
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
   * @param {{scoreMultiplier?: number}} [opts]
   */
  onDeath(opts = {}) {
    this.scene.events.emit(EVENTS.ENEMY_DIED, {
      x:          this.x,
      y:          this.y,
      type:       this.enemyType,
      vx:         this._velX,
      vy:         this._velY,
      score:      this.scoreValue,
      scoreMultiplier: opts.scoreMultiplier ?? 1,
      dropChance: this.dropChance,
    });
  }

  /**
   * Called during destroy() for shared subclass cleanup.
   * Override when an enemy owns extra teardown beyond the base shield cleanup.
   * @param {boolean} [fromScene]
   */
  onDestroy(fromScene) {}
}
