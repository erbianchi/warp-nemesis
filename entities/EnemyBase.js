/** @module EnemyBase */

import { EVENTS } from '../config/events.config.js';
import { GAME_CONFIG } from '../config/game.config.js';
import {
  DEFAULT_ENEMY_ACTION_MODE,
  ENEMY_ACTION_MODES,
  ENEMY_LEARNING_CONFIG,
} from '../config/enemyLearning.config.js';
import { ShieldController } from '../systems/ShieldController.js';
import {
  buildPlayerBulletThreatSnapshot,
  buildSquadSnapshot,
} from '../systems/ml/EnemyPolicyMath.js';
import { stripActionModes } from '../systems/ml/DanceWaypointNetwork.js';
import { resolveAdaptiveMovePlan as resolvePolicyAdaptiveMovePlan } from '../systems/ml/EnemyPositionEvaluator.js';
import { clamp } from '../utils/math.js';

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
 * @typedef {object} AdaptiveEnemyStats
 * @property {boolean} [enabled=false]
 * @property {number} [minSpeedScalar=1]
 * @property {number} [maxSpeedScalar=1]
 * @property {number} [maxSpeed]
 * @property {number} [predictedEnemyWinRate=0.5]
 * @property {number} [predictedSurvival=0.5]
 * @property {number} [predictedPressure=0.5]
 * @property {number} [predictedCollisionRisk=0.5]
 * @property {number} [predictedBulletRisk=0.5]
 */

/**
 * @typedef {object} EnemyStats
 * @property {number} hp
 * @property {number} damage
 * @property {number} [contactDamage]
 * @property {number} speed
 * @property {number} [baseSpeed]
 * @property {number} [speedCap]
 * @property {number} fireRate
 * @property {number} score
 * @property {number} dropChance
 * @property {number} bulletSpeed
 * @property {number} [shield]
 * @property {AdaptiveEnemyStats} [adaptive]
 */

/**
 * @typedef {object} EnemyRuntimeContext
 * @property {() => object|null} [getPlayer]
 * @property {() => object|null} [getWeapons]
 * @property {() => object|null} [getEffects]
 * @property {() => object[]} [getEnemies]
 * @property {() => object|null} [getAdaptivePolicy]
 * @property {() => object|null} [getPlayerSnapshot]
 * @property {() => object[]} [getPlayerBullets]
 * @property {() => object|null} [getServices]
 * @property {(target: object, opts?: object) => ShieldController} [createShieldController]
 */

/**
 * Formation-facing enemy interface.
 * Keeps `FormationController` decoupled from enemy private fields.
 *
 * @typedef {object} IFormationMember
 * @property {number} x
 * @property {number} y
 * @property {boolean} active
 * @property {string} enemyType
 * @property {number} fireRate
 * @property {string} dance
 * @property {(requestedMultiplier?: number) => number} [resolveMovementDurationScale]
 * @property {(requestedDurationMs: number, targetX: number, targetY: number) => number} [resolveTravelDurationMs]
 * @property {(baseX: number, options?: object) => object} [resolveAdaptiveMovePlan]
 * @property {() => boolean} [shouldFireNow]
 * @property {() => boolean} [canUseAdaptiveBehavior]
 * @property {() => boolean} [isAdaptiveBehaviorReady]
 * @property {() => number} [getFormationMovementSpeedMultiplier]
 * @property {() => object} [getFormationMeta]
 * @property {(x: number, y: number) => void} [setFormationPosition]
 * @property {(controller: object, launchAnchor?: {x: number, y: number}) => void} [onFormationStart]
 * @property {() => void} [onFormationEnd]
 * @property {() => number} [getFormationFireCooldown]
 * @property {() => void} [resetFormationFireCooldown]
 * @property {(options?: object) => void} [emitFormationShot]
 */

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
   * @param {EnemyStats} stats - Resolved stats from WaveSpawner.resolveStats()
   * @param {string} dance - Movement pattern key (see DANCES in levels.config.js)
   * @param {{runtimeContext: EnemyRuntimeContext, shieldFactory?: (target: object, opts?: object) => ShieldController}} options
   */
  constructor(scene, x, y, texture, stats, dance = 'straight', options) {
    super(scene, x, y, texture);

    if (!options?.runtimeContext) {
      throw new Error(`EnemyBase(${texture}) requires an explicit runtimeContext.`);
    }

    scene.add.existing(this);
    scene.physics.add.existing(this);

    /** @type {string} */
    this.enemyType = texture;
    /** @type {string} */
    this.dance = dance;

    /** @type {EnemyRuntimeContext} */
    this._runtimeContext = options.runtimeContext;
    /** @type {(target: object, opts?: object) => ShieldController} */
    this._shieldFactory = options.shieldFactory
      ?? this._runtimeContext?.createShieldController
      ?? ((target, shieldOptions = {}) => new ShieldController(scene, target, shieldOptions));

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
    this.contactDamage = stats.contactDamage ?? (stats.hp + Math.max(0, stats.shield ?? 0));
    /** @type {number} */
    this.speed = stats.speed;
    /** @type {number} */
    this._nativeSpeed = stats.speed;
    const adaptiveMaxSpeed = Math.max(
      1,
      Math.round(
        stats.adaptive?.maxSpeed
        ?? stats.speedCap
        ?? (stats.speed * (stats.adaptive?.maxSpeedScalar ?? 1))
      )
    );
    /** @type {number} */
    this._maxSpeed = adaptiveMaxSpeed;
    /** @type {number} */
    this.baseSpeed = stats.baseSpeed ?? stats.speed;
    /** @type {number} */
    this.fireRate = stats.fireRate;
    /** @type {number} */
    this.scoreValue = stats.score;
    /** @type {number} */
    this.dropChance = stats.dropChance;
    /** @type {number} */
    this.bulletSpeed = stats.bulletSpeed;
    /** @type {{enabled: boolean, minSpeedScalar: number, maxSpeedScalar: number, currentSpeedScalar: number, predictedEnemyWinRate: number, predictedPressure: number, predictedCollisionRisk: number, predictedBulletRisk: number}} */
    this.adaptiveProfile = {
      enabled: stats.adaptive?.enabled ?? false,
      minSpeedScalar: stats.adaptive?.minSpeedScalar ?? 1,
      maxSpeedScalar: stats.adaptive?.maxSpeedScalar ?? 1,
      maxSpeed: adaptiveMaxSpeed,
      currentSpeedScalar: 1,
      predictedEnemyWinRate: stats.adaptive?.predictedEnemyWinRate ?? 0.5,
      predictedSurvival: stats.adaptive?.predictedSurvival ?? 0.5,
      predictedPressure: stats.adaptive?.predictedPressure ?? 0.5,
      predictedCollisionRisk: stats.adaptive?.predictedCollisionRisk ?? 0.5,
      predictedBulletRisk: stats.adaptive?.predictedBulletRisk ?? 0.5,
    };
    this._adaptiveUnlocked = !this.adaptiveProfile.enabled;
    this._adaptiveActionMode = DEFAULT_ENEMY_ACTION_MODE;

    /** @type {boolean} */
    this.alive = true;
    /** @type {boolean} */
    this._destroyed = false;
    /** @type {boolean} */
    this._learningResolved = false;
    /** @type {number} */
    this._movementSpeedMultiplier = 1;
    /** @type {number} */
    this._baseMovementSpeedMultiplier = this.baseSpeed > 0
      ? Math.max(0.25, this._nativeSpeed / this.baseSpeed)
      : 1;

    /** @type {number} - accumulated ms since last shot */
    this._fireCooldown = 0;
    /** @type {boolean} */
    this._formationFireControlled = false;
    /** @type {object|null} */
    this._formationController = null;
    /** @type {object|null} */
    this._squadDoctrineState = null;

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
    this._shield   = this._shieldFactory(this, {
      effects:      this._getEffects(),
      points:       this.shield,
      radius:       16,
      depthOffset:  1,
      onChange:     ({ points, maxPoints }) => {
        this.shield = points;
        this.maxShield = maxPoints;
      },
    });
    this._applyAdaptiveSpeedScalar(1);
    this.setupMovement();
    this.setupWeapon();
  }

  /**
   * Deterministically phase squad members around their existing fire cycle so
   * they do not all spawn at cooldown zero and miss their first legal shot.
   *
   * @param {number} slotIndex
   * @param {number} slotCount
   * @returns {number}
   */
  primeSquadFireCooldown(slotIndex, slotCount) {
    if (this.fireRate <= 0) return this._fireCooldown;

    const normalizedCount = Math.max(1, Math.round(slotCount ?? 1));
    if (normalizedCount <= 1) return this._fireCooldown;

    const normalizedIndex = clamp(Math.round(slotIndex ?? 0), 0, normalizedCount - 1);
    this._fireCooldown = Math.round(this.fireRate * (normalizedIndex / normalizedCount));
    return this._fireCooldown;
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

    this._fireCooldown += delta;
    if (this.y < 0) return; // don't fire until on screen, but let entry time count toward the first shot
    if (this.isFormationFireControlled()) return;
    if (this.fireRate > 0 && this._fireCooldown >= this.fireRate) {
      if (this.shouldFireNow()) {
        this._fireCooldown = 0;
        this.fire();
      }
    }
  }

  // ── Combat ────────────────────────────────────────────────────────────

  /**
   * Apply damage to this enemy.
   * @param {number} amount
   * @param {number|{scoreMultiplier?: number, cause?: string}} [options=1]
   */
  takeDamage(amount, options = 1) {
    if (!this.alive) return;
    const resolvedOptions = typeof options === 'object' && options !== null
      ? options
      : { scoreMultiplier: options };
    const shieldResult = this._shield.takeDamage(amount);
    if (shieldResult.overflow <= 0) return;

    this.hp -= shieldResult.overflow;
    if (this.hp <= 0) {
      this.hp = 0;
      this.die({
        scoreMultiplier: resolvedOptions.scoreMultiplier ?? 1,
        cause: resolvedOptions.cause,
      });
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
    this._learningResolved = true;
    this.scene.events.emit(EVENTS.ENEMY_DIED, {
      enemy:       this,
      x:          this.x,
      y:          this.y,
      type:       this.enemyType,
      vx:         this._velX,
      vy:         this._velY,
      score:      this.scoreValue,
      scoreMultiplier: opts.scoreMultiplier ?? 1,
      dropChance: this.dropChance,
      cause:      opts.cause ?? 'destroyed',
      squadId:    this._squadId ?? null,
      squadTemplateId: this._squadTemplateId ?? null,
    });
  }

  /** Emit a one-shot escape event for learning telemetry. */
  markEscaped() {
    if (this._learningResolved) return;
    this._learningResolved = true;
    this.scene.events.emit(EVENTS.ENEMY_ESCAPED, {
      enemy: this,
      x: this.x,
      y: this.y,
      type: this.enemyType,
      squadId: this._squadId ?? null,
      squadTemplateId: this._squadTemplateId ?? null,
    });
  }

  _applyAdaptiveSpeedScalar(speedScalar = 1) {
    const minSpeedScalar = this.adaptiveProfile?.minSpeedScalar ?? 1;
    const maxSpeedScalar = this.adaptiveProfile?.maxSpeedScalar ?? 1;
    const requestedScalar = clamp(speedScalar, minSpeedScalar, maxSpeedScalar);
    const maxSpeed = this.adaptiveProfile?.maxSpeed ?? this._maxSpeed ?? Math.max(1, this._nativeSpeed ?? 1);
    const resolvedSpeed = Math.min(
      Math.max(1, Math.round((this._nativeSpeed ?? 1) * requestedScalar)),
      maxSpeed
    );
    const resolvedScalar = clamp(
      resolvedSpeed / Math.max(1, this._nativeSpeed ?? 1),
      minSpeedScalar,
      maxSpeedScalar
    );

    this.adaptiveProfile.currentSpeedScalar = resolvedScalar;
    this.speed = resolvedSpeed;
    this._movementSpeedMultiplier = resolvedSpeed / Math.max(1, this.baseSpeed ?? this._nativeSpeed ?? 1);
    return resolvedScalar;
  }

  getMaxMovementSpeed() {
    return Math.max(
      1,
      this.adaptiveProfile?.maxSpeed
      ?? this._maxSpeed
      ?? this.speed
      ?? this._nativeSpeed
      ?? this.baseSpeed
      ?? 1
    );
  }

  resolveMovementDurationScale(requestedMultiplier = 1) {
    const baseSpeed = Math.max(1, this.baseSpeed ?? this._nativeSpeed ?? 1);
    const maxSpeed = this.getMaxMovementSpeed();
    const resolvedSpeed = Math.min(
      Math.max(1, Math.round(baseSpeed * requestedMultiplier)),
      maxSpeed
    );
    return resolvedSpeed / baseSpeed;
  }

  resolveTravelDurationMs(requestedDurationMs, targetX, targetY, originX = this.x, originY = this.y) {
    const baseDuration = Math.max(1, Math.round(requestedDurationMs ?? 0));
    const distance = Math.hypot((targetX ?? originX) - originX, (targetY ?? originY) - originY);
    if (distance <= 0.01) return baseDuration;

    const minDurationMs = Math.ceil((distance / this.getMaxMovementSpeed()) * 1000);
    return Math.max(baseDuration, minDurationMs);
  }

  applyClampedMovement(nextX, nextY, deltaMs) {
    const dt = Math.max(0, deltaMs) / 1000;
    if (dt <= 0) return { x: this.x, y: this.y, distance: 0, maxDistance: 0 };

    const startX = this.x;
    const startY = this.y;
    let dx = nextX - startX;
    let dy = nextY - startY;
    const distance = Math.hypot(dx, dy);
    const maxDistance = this.getMaxMovementSpeed() * dt;

    if (distance > maxDistance && distance > 0.0001) {
      const scale = maxDistance / distance;
      dx *= scale;
      dy *= scale;
      nextX = startX + dx;
      nextY = startY + dy;
    }

    this.x = nextX;
    this.y = nextY;
    this._syncBodyToSprite();

    return {
      x: this.x,
      y: this.y,
      distance: Math.hypot(this.x - startX, this.y - startY),
      maxDistance,
    };
  }

  moveTowardPoint(targetX, targetY, deltaMs, responseX = 1, responseY = responseX) {
    const dt = Math.max(0, deltaMs) / 1000;
    if (dt <= 0) return { x: this.x, y: this.y, distance: 0, maxDistance: 0 };

    const nextX = this.x + (targetX - this.x) * Math.min(1, dt * Math.max(0, responseX));
    const nextY = this.y + (targetY - this.y) * Math.min(1, dt * Math.max(0, responseY));
    return this.applyClampedMovement(nextX, nextY, deltaMs);
  }

  /**
   * @param {EnemyRuntimeContext|null} runtimeContext
   * @returns {this}
   */
  setRuntimeContext(runtimeContext) {
    if (!runtimeContext) {
      throw new Error(`EnemyBase(${this.enemyType}) cannot clear its runtimeContext.`);
    }
    this._runtimeContext = runtimeContext;
    return this;
  }

  getRuntimeContext() {
    return this._runtimeContext;
  }

  getRuntimeServices() {
    return this.getRuntimeContext()?.getServices?.() ?? null;
  }

  _getEffects() {
    return this.getRuntimeContext()?.getEffects?.() ?? null;
  }

  _getWeapons() {
    return this.getRuntimeContext()?.getWeapons?.() ?? null;
  }

  _getLiveEnemies() {
    return this.getRuntimeContext()?.getEnemies?.() ?? [];
  }

  _getAdaptivePolicy() {
    return this.getRuntimeContext()?.getAdaptivePolicy?.() ?? null;
  }

  configureSpawnMetadata(meta = {}) {
    this._learningId = meta.learningId ?? this._learningId ?? null;
    this._overlayRaid = Boolean(meta.overlay ?? this._overlayRaid);
    this._spawnWaveId = meta.waveId ?? this._spawnWaveId ?? null;
    this._sourceEventId = meta.sourceEventId ?? this._sourceEventId ?? null;
    this._squadId = meta.squadId ?? this._squadId ?? null;
    this._squadTemplateId = meta.squadTemplateId ?? this._squadTemplateId ?? null;
    this._squadSpawnCount = meta.squadSize ?? this._squadSpawnCount ?? 1;
    this._squadSpawnIndex = meta.squadIndex ?? this._squadSpawnIndex ?? 0;
    this._formationType = meta.formation ?? this._formationType ?? null;
    this._spawnDance = meta.dance ?? this._spawnDance ?? this.dance;
    this.primeSquadFireCooldown?.(this._squadSpawnIndex, this._squadSpawnCount);
    return this;
  }

  getFormationMeta() {
    return {
      squadId: this._squadId ?? null,
      squadTemplateId: this._squadTemplateId ?? null,
      formation: this._formationType ?? null,
      dance: this._spawnDance ?? this.dance ?? null,
      overlay: Boolean(this._overlayRaid),
    };
  }

  getFormationMovementSpeedMultiplier() {
    return this._baseMovementSpeedMultiplier ?? this._movementSpeedMultiplier ?? 1;
  }

  setFormationPosition(x, y) {
    this.x = x;
    this.y = y;
    this._syncBodyToSprite();
    this.body?.reset?.(x, y);
  }

  onFormationStart(controller, launchAnchor = null) {
    this._formationFireControlled = true;
    this._formationController = controller ?? null;
    if (launchAnchor) this.setFormationPosition(launchAnchor.x, launchAnchor.y);
  }

  onFormationEnd() {
    this._formationFireControlled = false;
    this._formationController = null;
    this.clearSquadDoctrineState();
  }

  isFormationFireControlled() {
    return this._formationFireControlled === true;
  }

  getFormationFireCooldown() {
    return this._fireCooldown ?? 0;
  }

  resetFormationFireCooldown() {
    this._fireCooldown = 0;
  }

  isAdaptiveBehaviorReady() {
    return this.canUseAdaptiveBehavior() || this._adaptiveUnlocked === true;
  }

  /**
   * Apply tactical squad-doctrine hints from a runtime squad controller.
   * These hints bias authored movement toward a living squad plan while still
   * respecting the class-native action space.
   *
   * @param {object|null} state
   * @returns {this}
   */
  setSquadDoctrineState(state = null) {
    if (!state || state.active === false) {
      this._squadDoctrineState = null;
      return this;
    }

    this._squadDoctrineState = {
      ...state,
      active: true,
      speedScalar: clamp(
        state.speedScalar ?? this.adaptiveProfile?.currentSpeedScalar ?? 1,
        this.adaptiveProfile?.minSpeedScalar ?? 1,
        this.adaptiveProfile?.maxSpeedScalar ?? 1
      ),
    };
    return this;
  }

  /**
   * Clear any controller-provided squad doctrine state.
   * @returns {this}
   */
  clearSquadDoctrineState() {
    this._squadDoctrineState = null;
    return this;
  }

  getSquadDoctrineState() {
    return this._squadDoctrineState;
  }

  _getPlayerSnapshot() {
    const runtimeContext = this.getRuntimeContext();
    const snapshot = runtimeContext?.getPlayerSnapshot?.();
    if (snapshot) return snapshot;

    const player = runtimeContext?.getPlayer?.();
    return {
      x: player?.x ?? GAME_CONFIG.WIDTH / 2,
      y: player?.y ?? GAME_CONFIG.HEIGHT - 80,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    };
  }

  _getPlayerBulletThreatSnapshot() {
    const playerBullets = this.getRuntimeContext()?.getPlayerBullets?.() ?? [];
    return buildPlayerBulletThreatSnapshot(
      playerBullets,
      this,
      this._getAdaptivePolicy()?._config?.normalization ?? {}
    );
  }

  _getNeuralFlowNavigationConfig() {
    return {
      marginPx: 24,
      topMarginPx: 24,
      bottomMarginPx: GAME_CONFIG.HEIGHT - 24,
      rangePx: 72,
      yRangePx: 56,
      pressTargetOffsetY: 90,
      pressAdvanceLimitPx: 60,
      flankOffsetBasePx: 80,
      flankOffsetRandomPx: 40,
      flankYJitterPx: 40,
      retreatBasePx: 50,
      retreatRandomPx: 40,
    };
  }

  _sampleNeuralMode(currentMode = DEFAULT_ENEMY_ACTION_MODE) {
    const policy = this._getAdaptivePolicy();
    const network = policy?.getDanceNetwork?.();
    const cfg = ENEMY_LEARNING_CONFIG.neuralDance ?? {};
    const encoder = policy?.getEncoder?.() ?? policy?._encoder;

    if (network?.isTrained && encoder?.buildSample && encoder?.encodeSample) {
      const temperature = this._resolveNeuralTemperature(network);
      const squad = buildSquadSnapshot(this._getLiveEnemies(), this._squadId ?? null, this);
      const weapon = this._getWeapons()?.getLearningSnapshot?.() ?? {};
      const sample = encoder.buildSample({
        enemyType: this.enemyType,
        player: this._getPlayerSnapshot(),
        weapon,
        enemyX: this.x,
        enemyY: this.y,
        speed: this.speed,
        squad,
        threat: this._getPlayerBulletThreatSnapshot(),
        actionMode: DEFAULT_ENEMY_ACTION_MODE,
      });
      if (sample) {
        const encoded = encoder.encodeSample(sample);
        const { mode, probabilities } = network.sample(
          stripActionModes(encoded.vector),
          temperature
        );
        const hysteresis = cfg.modeHysteresisThreshold ?? 0.15;
        const modes = cfg.actionModes ?? ENEMY_ACTION_MODES;
        const currentModeIdx = modes.indexOf(currentMode);
        const newModeIdx = modes.indexOf(mode);
        if (currentModeIdx >= 0 && newModeIdx >= 0 && mode !== currentMode) {
          const currentProbability = probabilities[currentModeIdx] ?? 0;
          const nextProbability = probabilities[newModeIdx] ?? 0;
          if ((nextProbability - currentProbability) < hysteresis) {
            return currentMode;
          }
        }
        return mode;
      }
    }

    const navigation = this._getNeuralFlowNavigationConfig();
    const fallback = resolvePolicyAdaptiveMovePlan(policy, this, this.x, {
      candidateY: this.y,
      rangePx: navigation.rangePx,
      yRangePx: navigation.yRangePx,
      marginPx: navigation.marginPx,
      topMarginPx: navigation.topMarginPx,
      bottomMarginPx: navigation.bottomMarginPx,
      commit: false,
    });
    return fallback?.actionMode ?? currentMode ?? DEFAULT_ENEMY_ACTION_MODE;
  }

  _resolveNeuralAnchor(mode) {
    const player = this._getPlayerSnapshot();
    const threat = this._getPlayerBulletThreatSnapshot();
    const navigation = this._getNeuralFlowNavigationConfig();
    const clampX = (x) => clamp(x, navigation.marginPx, GAME_CONFIG.WIDTH - navigation.marginPx);
    const clampY = (y) => clamp(y, navigation.topMarginPx, navigation.bottomMarginPx);

    switch (mode) {
      case 'press':
        return {
          x: clampX(player.x ?? this.x),
          y: clampY(Math.min(
            (player.y ?? this.y) - navigation.pressTargetOffsetY,
            this.y + navigation.pressAdvanceLimitPx
          )),
        };
      case 'flank': {
        const playerX = player.x ?? GAME_CONFIG.WIDTH / 2;
        const side = this.x <= playerX ? -1 : 1;
        return {
          x: clampX(playerX + side * (
            navigation.flankOffsetBasePx + Math.random() * navigation.flankOffsetRandomPx
          )),
          y: clampY(this.y + (Math.random() - 0.5) * navigation.flankYJitterPx),
        };
      }
      case 'evade':
        return {
          x: clampX(threat.suggestedSafeX ?? this.x),
          y: clampY(threat.suggestedSafeY ?? this.y),
        };
      case 'retreat':
        return {
          x: clampX(this.x),
          y: clampY(this.y - navigation.retreatBasePx - Math.random() * navigation.retreatRandomPx),
        };
      case 'hold':
      default:
        return { x: clampX(this.x), y: clampY(this.y) };
    }
  }

  _resolveNeuralTemperature(network) {
    const cfg = ENEMY_LEARNING_CONFIG.neuralDance ?? {};
    const temperatureInitial = cfg.temperatureInitial ?? 2.0;
    const temperatureFinal = cfg.temperatureFinal ?? 0.7;
    const convergeSamples = cfg.temperatureSampleConverge ?? 200;
    const t = Math.min((network?.sampleCount ?? 0) / Math.max(1, convergeSamples), 1);
    return temperatureInitial - (temperatureInitial - temperatureFinal) * t;
  }

  resolveAdaptiveMovePlan(baseX, options = {}) {
    return resolvePolicyAdaptiveMovePlan(this._getAdaptivePolicy(), this, baseX, options);
  }

  /**
   * Resolve a movement plan that blends local authored motion with a live
   * squad-doctrine anchor. If adaptive movement is not yet unlocked, this still
   * returns a doctrine-biased fallback so coordinated behavior can show up
   * before the neural policy fully takes over.
   *
   * @param {number} baseX
   * @param {object} [options={}]
   * @returns {{x: number, y: number, speedScalar: number, actionMode?: string}}
   */
  resolveDoctrineMovePlan(baseX, options = {}) {
    const doctrine = this.getSquadDoctrineState?.();
    if (!doctrine?.active) {
      return this.resolveAdaptiveMovePlan(baseX, options);
    }

    const normalization = this._getAdaptivePolicy()?._config?.normalization ?? ENEMY_LEARNING_CONFIG.normalization ?? {};
    const marginPx = Math.max(0, options.marginPx ?? 24);
    const topMarginPx = Math.max(0, options.topMarginPx ?? 24);
    const bottomMarginPx = Math.max(topMarginPx, options.bottomMarginPx ?? ((normalization.height ?? GAME_CONFIG.HEIGHT) - 24));
    const candidateY = options.candidateY ?? this.y ?? 0;
    const anchorWeight = clamp(doctrine.anchorWeight ?? 0.52, 0, 1);
    const targetX = clamp(
      baseX + (((doctrine.anchorX ?? baseX) - baseX) * anchorWeight),
      marginPx,
      (normalization.width ?? GAME_CONFIG.WIDTH) - marginPx
    );
    const targetY = clamp(
      candidateY + (((doctrine.anchorY ?? candidateY) - candidateY) * anchorWeight),
      topMarginPx,
      bottomMarginPx
    );
    const speedScalar = clamp(
      doctrine.speedScalar ?? this.adaptiveProfile?.currentSpeedScalar ?? 1,
      this.adaptiveProfile?.minSpeedScalar ?? 1,
      this.adaptiveProfile?.maxSpeedScalar ?? 1
    );

    if (!this.canUseAdaptiveBehavior()) {
      return {
        x: targetX,
        y: targetY,
        speedScalar,
        actionMode: this._adaptiveActionMode ?? DEFAULT_ENEMY_ACTION_MODE,
      };
    }

    return this.resolveAdaptiveMovePlan(targetX, {
      ...options,
      candidateY: targetY,
      rangePx: Math.max(options.rangePx ?? 0, doctrine.rangePx ?? 0),
      yRangePx: Math.max(options.yRangePx ?? 0, doctrine.yRangePx ?? 0),
      speedScalars: options.speedScalars ?? [speedScalar],
    });
  }

  shouldUseAdaptiveFireWindow() {
    return Boolean(this.canUseAdaptiveBehavior() && this._getAdaptivePolicy()?.scoreCurrentPosition);
  }

  shouldFireNow() {
    if (!this.shouldUseAdaptiveFireWindow()) return true;

    const playerBullets = this.getRuntimeContext()?.getPlayerBullets?.() ?? [];
    if (playerBullets.length === 0) return true;

    const evaluation = this._getAdaptivePolicy()?.scoreCurrentPosition?.({
      enemy: this,
      enemyType: this.enemyType,
    });
    if (!evaluation) return true;

    const policy = ENEMY_LEARNING_CONFIG.runtimePolicy ?? {};
    const bulletRiskCeil = policy.adaptiveFireBulletRiskCeil ?? 0.68;
    const collisionRiskCeil = policy.adaptiveFireCollisionRiskCeil ?? 0.62;
    const safeWindow = (evaluation.predictedBulletRisk ?? 0.5) <= bulletRiskCeil
      && (evaluation.predictedCollisionRisk ?? 0.5) <= collisionRiskCeil;
    return evaluation.score >= (policy.adaptiveFireScoreFloor ?? 0.22)
      || (safeWindow && evaluation.predictedPressure >= (policy.adaptivePressureFloor ?? 0.42))
      || (safeWindow && evaluation.predictedEnemyWinRate >= (policy.adaptiveWinFloor ?? 0.48))
      || this._fireCooldown >= this.fireRate * (policy.adaptiveForceFireMultiplier ?? 2.1);
  }

  canUseAdaptiveBehavior() {
    return Boolean(this.adaptiveProfile?.enabled && this._adaptiveUnlocked);
  }

  unlockAdaptiveBehavior() {
    if (!this.adaptiveProfile?.enabled) return false;
    this._adaptiveUnlocked = true;
    return true;
  }

  /**
   * @param {number} [speed=this.bulletSpeed]
   * @returns {Array<{vx: number, vy: number, width?: number, height?: number, color?: number}>}
   */
  getNativeFireBursts(speed = this.bulletSpeed) {
    return [{ vx: 0, vy: speed }];
  }

  /**
   * Emit the native shot pattern for the enemy class.
   * @param {{xOffset?: number, yOffset?: number, speedOverride?: number}} [options={}]
   */
  emitNativeFireBursts(options = {}) {
    const bursts = this.getNativeFireBursts(options.speedOverride ?? this.bulletSpeed);
    for (const burst of bursts) {
      this.scene.events.emit(EVENTS.ENEMY_FIRE, {
        x: this.x + (options.xOffset ?? 0),
        y: this.y + (options.yOffset ?? 0),
        vx: burst.vx,
        vy: burst.vy,
        damage: this.damage,
        width: burst.width,
        height: burst.height,
        color: burst.color,
        sourceType: this.enemyType,
        sourceEnemy: this,
        sourceEnemyId: this._learningId ?? null,
        squadId: this._squadId ?? null,
        squadTemplateId: this._squadTemplateId ?? null,
      });
    }
  }

  emitFormationShot(options = {}) {
    this.resetFormationFireCooldown();
    this.emitNativeFireBursts({
      yOffset: 14,
      speedOverride: 600,
      ...options,
    });
  }

  /**
   * Called during destroy() for shared subclass cleanup.
   * Override when an enemy owns extra teardown beyond the base shield cleanup.
   * @param {boolean} [fromScene]
   */
  onDestroy(fromScene) {}
}
