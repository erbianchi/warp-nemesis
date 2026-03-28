/** @module EnemyBase */

import { EVENTS } from '../config/events.config.js';
import { GAME_CONFIG } from '../config/game.config.js';
import { ENEMY_LEARNING_CONFIG } from '../config/enemyLearning.config.js';
import { ShieldController } from '../systems/ShieldController.js';
import { buildPlayerBulletThreatSnapshot } from '../systems/ml/EnemyPolicyMath.js';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

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
    this._applyAdaptiveSpeedScalar(1);
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

    this._fireCooldown += delta;
    if (this.y < 0) return; // don't fire until on screen, but let entry time count toward the first shot
    if (this._formationFireControlled) return;
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

  _getPlayerSnapshot() {
    return this.scene?._getEnemyLearningPlayerSnapshot?.() ?? {
      x: this.scene?._player?.x ?? GAME_CONFIG.WIDTH / 2,
      y: this.scene?._player?.y ?? GAME_CONFIG.HEIGHT - 80,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    };
  }

  _getPlayerBulletThreatSnapshot() {
    const playerBullets = this.scene?._weapons?.pool?.getChildren?.()?.filter?.(bullet => bullet?.active) ?? [];
    return buildPlayerBulletThreatSnapshot(playerBullets, this, this.scene?._enemyAdaptivePolicy?._config?.normalization ?? {});
  }

  _buildAdaptiveAnchors(baseX, candidateY, rangePx, yRangePx, bounds) {
    const player = this._getPlayerSnapshot();
    const threat = this._getPlayerBulletThreatSnapshot();
    const baseAnchor = {
      mode: 'hold',
      x: baseX,
      y: candidateY,
    };
    const anchors = [
      baseAnchor,
      {
        mode: 'press',
        x: player.x ?? baseX,
        y: clamp(
          Math.min((player.y ?? candidateY) - 90, candidateY + yRangePx),
          bounds.topMarginPx,
          bounds.bottomMarginPx
        ),
      },
      {
        mode: 'retreat',
        x: baseX,
        y: clamp(candidateY - yRangePx, bounds.topMarginPx, bounds.bottomMarginPx),
      },
      {
        mode: 'evade',
        x: clamp(threat.suggestedSafeX ?? baseX, bounds.marginPx, GAME_CONFIG.WIDTH - bounds.marginPx),
        y: clamp(threat.suggestedSafeY ?? candidateY, bounds.topMarginPx, bounds.bottomMarginPx),
      },
    ];

    const playerX = player.x ?? baseX;
    const flankOffset = Math.max(rangePx, 40);
    anchors.push({
      mode: 'flank',
      x: clamp(playerX + (baseX <= playerX ? -flankOffset : flankOffset), bounds.marginPx, GAME_CONFIG.WIDTH - bounds.marginPx),
      y: clamp(candidateY + yRangePx * 0.25, bounds.topMarginPx, bounds.bottomMarginPx),
    });

    return anchors;
  }

  /**
   * Resolve a learned movement target and speed scalar from candidate actions.
   * @param {number} baseX
   * @param {{
   *   candidateY?: number,
   *   rangePx?: number,
   *   yRangePx?: number,
   *   marginPx?: number,
   *   topMarginPx?: number,
   *   bottomMarginPx?: number,
   *   commit?: boolean,
   *   speedScalars?: number[],
   * }} [options={}]
   * @returns {{x: number, y: number, speedScalar: number, predictedEnemyWinRate: number, predictedSurvival: number, predictedPressure: number, predictedCollisionRisk: number, predictedBulletRisk: number, score: number, actionMode?: string}}
   */
  resolveAdaptiveMovePlan(baseX, options = {}) {
    const rangePx = Math.max(0, options.rangePx ?? 0);
    const yRangePx = Math.max(0, options.yRangePx ?? Math.round(rangePx * 0.7));
    const marginPx = Math.max(0, options.marginPx ?? 24);
    const topMarginPx = Math.max(0, options.topMarginPx ?? 24);
    const bottomMarginPx = Math.max(topMarginPx, options.bottomMarginPx ?? (GAME_CONFIG.HEIGHT - 24));
    const candidateY = options.candidateY ?? this.y;
    const commit = options.commit !== false;
    const policy = this.scene?._enemyAdaptivePolicy;

    const clampedBaseX = clamp(baseX, marginPx, GAME_CONFIG.WIDTH - marginPx);
    const clampedBaseY = clamp(candidateY, topMarginPx, bottomMarginPx);
    if (!this.canUseAdaptiveBehavior() || !policy?.resolveBehavior) {
      const speedScalar = this.canUseAdaptiveBehavior()
        ? clamp(
            this.adaptiveProfile?.currentSpeedScalar ?? 1,
            this.adaptiveProfile?.minSpeedScalar ?? 1,
            this.adaptiveProfile?.maxSpeedScalar ?? 1
          )
        : 1;
      if (commit) this._applyAdaptiveSpeedScalar(speedScalar);
      return {
        x: clampedBaseX,
        y: clampedBaseY,
        speedScalar,
        predictedEnemyWinRate: this.adaptiveProfile?.predictedEnemyWinRate ?? 0.5,
        predictedSurvival: this.adaptiveProfile?.predictedSurvival ?? 0.5,
        predictedPressure: this.adaptiveProfile?.predictedPressure ?? 0.5,
        predictedCollisionRisk: this.adaptiveProfile?.predictedCollisionRisk ?? 0.5,
        predictedBulletRisk: this.adaptiveProfile?.predictedBulletRisk ?? 0.5,
        score: 0,
        actionMode: this._adaptiveActionMode ?? 'hold',
      };
    }

    const xOffsets = rangePx > 0
      ? (policy.getPositionOffsets?.() ?? [-1, -0.5, 0, 0.5, 1])
      : [0];
    const yOffsets = yRangePx > 0
      ? (policy.getVerticalOffsets?.() ?? [-1, -0.5, 0, 0.5, 1])
      : [0];
    const speedScalars = options.speedScalars ?? policy.getSpeedCandidates?.(this.enemyType) ?? [1];
    const candidates = [];
    const anchors = this._buildAdaptiveAnchors(clampedBaseX, clampedBaseY, rangePx, yRangePx, {
      marginPx,
      topMarginPx,
      bottomMarginPx,
    });

    for (const anchor of anchors) {
      for (const xOffset of xOffsets) {
        const candidateX = clamp(anchor.x + xOffset * rangePx * 0.45, marginPx, GAME_CONFIG.WIDTH - marginPx);
        for (const yOffset of yOffsets) {
          const candidateYValue = clamp(anchor.y + yOffset * yRangePx * 0.45, topMarginPx, bottomMarginPx);
          for (const speedScalar of speedScalars) {
            candidates.push({
              x: candidateX,
              y: candidateYValue,
              speedScalar,
              actionMode: anchor.mode,
            });
          }
        }
      }
    }

    const resolved = policy.resolveBehavior({
      enemy: this,
      enemyType: this.enemyType,
      candidates,
    }) ?? {
      x: clampedBaseX,
      y: clampedBaseY,
      speedScalar: 1,
      predictedEnemyWinRate: 0.5,
      predictedSurvival: 0.5,
      predictedPressure: 0.5,
      predictedCollisionRisk: 0.5,
      predictedBulletRisk: 0.5,
      score: 0,
      actionMode: 'hold',
    };

    const speedScalar = commit
      ? this._applyAdaptiveSpeedScalar(resolved.speedScalar ?? 1)
      : clamp(
          resolved.speedScalar ?? 1,
          this.adaptiveProfile?.minSpeedScalar ?? 1,
          this.adaptiveProfile?.maxSpeedScalar ?? 1
        );

    this.adaptiveProfile.predictedEnemyWinRate = resolved.predictedEnemyWinRate ?? this.adaptiveProfile.predictedEnemyWinRate;
    this.adaptiveProfile.predictedSurvival = resolved.predictedSurvival ?? this.adaptiveProfile.predictedSurvival;
    this.adaptiveProfile.predictedPressure = resolved.predictedPressure ?? this.adaptiveProfile.predictedPressure;
    this.adaptiveProfile.predictedCollisionRisk = resolved.predictedCollisionRisk ?? this.adaptiveProfile.predictedCollisionRisk;
    this.adaptiveProfile.predictedBulletRisk = resolved.predictedBulletRisk ?? this.adaptiveProfile.predictedBulletRisk;
    this._adaptiveActionMode = resolved.actionMode ?? this._adaptiveActionMode ?? 'hold';

    return {
      x: resolved.x ?? clampedBaseX,
      y: resolved.y ?? clampedBaseY,
      speedScalar,
      predictedEnemyWinRate: resolved.predictedEnemyWinRate ?? 0.5,
      predictedSurvival: resolved.predictedSurvival ?? 0.5,
      predictedPressure: resolved.predictedPressure ?? 0.5,
      predictedCollisionRisk: resolved.predictedCollisionRisk ?? 0.5,
      predictedBulletRisk: resolved.predictedBulletRisk ?? 0.5,
      score: resolved.score ?? 0,
      actionMode: resolved.actionMode ?? 'hold',
    };
  }

  shouldUseAdaptiveFireWindow() {
    return Boolean(this.canUseAdaptiveBehavior() && this.scene?._enemyAdaptivePolicy?.scoreCurrentPosition);
  }

  shouldFireNow() {
    if (!this.shouldUseAdaptiveFireWindow()) return true;

    const evaluation = this.scene?._enemyAdaptivePolicy?.scoreCurrentPosition?.({
      enemy: this,
      enemyType: this.enemyType,
    });
    if (!evaluation) return true;

    const policy = ENEMY_LEARNING_CONFIG.runtimePolicy ?? {};
    return evaluation.score >= (policy.adaptiveFireScoreFloor ?? 0.22)
      || evaluation.predictedPressure >= (policy.adaptivePressureFloor ?? 0.42)
      || evaluation.predictedEnemyWinRate >= (policy.adaptiveWinFloor ?? 0.48)
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

  /**
   * Called during destroy() for shared subclass cleanup.
   * Override when an enemy owns extra teardown beyond the base shield cleanup.
   * @param {boolean} [fromScene]
   */
  onDestroy(fromScene) {}
}
