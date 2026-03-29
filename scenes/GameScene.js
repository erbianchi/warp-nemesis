/** @module GameScene
 * Core game loop — orchestrator only.
 * Delegates enemy spawning to WaveSpawner, movement to entity classes,
 * and collision to physics.add.overlap + manual AABB for enemy bullets. */

import { GAME_CONFIG }           from '../config/game.config.js';
import { readDebugOptions }      from '../config/debug.config.js';
import { EVENTS }                from '../config/events.config.js';
import { ScrollingBackground }   from '../systems/ScrollingBackground.js';
import { EffectsSystem }         from '../systems/EffectsSystem.js';
import { WaveSpawner, resolveStats } from '../systems/WaveSpawner.js';
import { FormationController }   from '../systems/FormationController.js';
import { BonusSystem }           from '../systems/BonusSystem.js';
import { ShieldController }      from '../systems/ShieldController.js';
import { AdaptiveStatsResolver } from '../systems/ml/AdaptiveStatsResolver.js';
import { EnemyAdaptivePolicy }   from '../systems/ml/EnemyAdaptivePolicy.js';
import { DanceGenerator }        from '../systems/ml/DanceGenerator.js';
import { LEVELS }                from '../config/levels.config.js';
import { WeaponManager }         from '../weapons/WeaponManager.js';
import { RunState }              from '../systems/RunState.js';
import { MetaProgression }       from '../systems/MetaProgression.js';
import { Skirm }                 from '../entities/enemies/Skirm.js';
import { Raptor }                from '../entities/enemies/Raptor.js';
import { Mine }                  from '../entities/enemies/Mine.js';

const {
  WIDTH, HEIGHT,
  PLAYER_SPEED, PLAYER_SPEED_DEFAULT, PLAYER_LIVES_DEFAULT,
  PLAYER_HP_MAX, PLAYER_HP_DEFAULT,
  PLAYER_SHIELD_MAX, PLAYER_SHIELD_DEFAULT,
  PLAYER_HEAT_WARNING_RATIO, PLAYER_HEAT_WARNING_BLINK_MS,
  PLAYER_HEAT_WARNING_SHAKE_MS, PLAYER_HEAT_WARNING_SHAKE_INTENSITY,
} = GAME_CONFIG;

const HEAT_BAR_COLOR = 0xff3300;
const HEAT_WARNING_COLOR = 0xffdd33;
const HEAT_WARNING_DIM_ALPHA = 0.3;
const PLAYER_BULLET_WIDTH = 3;
const PLAYER_WARNING_BULLET_WIDTH = 11;
const PLAYER_BULLET_HEIGHT = 16;
const ENEMY_BULLET_WIDTH = 3;
const ENEMY_BULLET_HEIGHT = 10;
const PLAYER_VISUAL_DEPTH = 10;
const PLAYER_PARALLAX_LERP = 10;
const PLAYER_TEXTURE_WIDTH = 137;
const PLAYER_TEXTURE_HEIGHT = 117;
const PLAYER_FRONT_CROP_Y = 0;
const PLAYER_FRONT_CROP_HEIGHT = 44;
const PLAYER_CORE_CROP_Y = 37;
const PLAYER_CORE_CROP_HEIGHT = 47;
const PLAYER_REAR_CROP_Y = 72;
const PLAYER_REAR_CROP_HEIGHT = 45;
const PLAYER_PARALLAX_REAR_SHIFT_X = 3.8;
const PLAYER_PARALLAX_FRONT_SHIFT_X = 0.55;
const PLAYER_PARALLAX_REAR_SHIFT_Y = 0.6;
const PLAYER_PARALLAX_FRONT_SHIFT_Y = 1.5;
const DEBUG_END_DELAY_MS = 250;
const LEVEL_CLEAR_EXIT_MS = 1200;
const LEVEL_CLEAR_FADE_MS = 600;
const LEVEL_CLEAR_CARD_DELAY_MS = 4000;
const HEAT_COOLING_COLORS = [
  0x040d61,
  0xfacc22,
  0xf89800,
  0xf83600,
  0x9f0404,
  0x4b4a4f,
  0x353438,
  0x040404,
];

/**
 * True while the weapon heat sits in the warning zone.
 * @param {number} heatShots
 * @param {number} maxHeatShots
 * @returns {boolean}
 */
export function isHeatWarningActive(heatShots, maxHeatShots) {
  return maxHeatShots > 0 && (heatShots / maxHeatShots) >= PLAYER_HEAT_WARNING_RATIO;
}

/**
 * Resolve the current heat bar color/alpha.
 * @param {number} heatShots
 * @param {number} maxHeatShots
 * @param {number} [timeMs=0]
 * @returns {{color: number, alpha: number}}
 */
export function resolveHeatBarStyle(heatShots, maxHeatShots, timeMs = 0) {
  if (!isHeatWarningActive(heatShots, maxHeatShots)) {
    return { color: HEAT_BAR_COLOR, alpha: 1 };
  }

  const blinkPhase = Math.floor(timeMs / PLAYER_HEAT_WARNING_BLINK_MS) % 2;
  return {
    color: HEAT_WARNING_COLOR,
    alpha: blinkPhase === 0 ? 1 : HEAT_WARNING_DIM_ALPHA,
  };
}

export class GameScene extends Phaser.Scene {
  constructor(deps = {}) {
    super({ key: 'GameScene' });
    this._deps = deps;
    this._levelCompletionRecorded = false;
    this._runLearningRecorded = false;
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  create() {
    this._debugOptions = readDebugOptions(globalThis.location ?? '');
    this._bg      = new ScrollingBackground(this);
    this._effects = new EffectsSystem(this);
    this._player  = this._createPlayer();
    this._weapons = new WeaponManager(this);
    this._cursors = this.input.keyboard.createCursorKeys();
    this._wasd    = this._createWASD();
    this._space   = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.input.keyboard.once('keydown', () => this._unlockAudio());

    this._playerSpeed    = PLAYER_SPEED_DEFAULT;
    this._levelCompletionRecorded = false;
    this._resolveStartingPlayerStats();
    const savedPlayerState = this._prepareRunState();
    this._playerHp       = Math.min(
      PLAYER_HP_MAX,
      Math.max(0, Math.round(savedPlayerState?.hp ?? this._startingPlayerHp))
    );
    this._playerShield   = Math.min(
      PLAYER_SHIELD_MAX,
      Math.max(0, Math.round(savedPlayerState?.shield ?? this._startingPlayerShield))
    );
    this._gameOver       = false;
    this._respawning     = false;
    this._levelClearing  = false;
    this._displayedScore = 0;
    this._scoreTween     = null;
    this._hudTimeMs      = 0;
    this._nextLearningEnemyId = 0;
    this._runLearningRecorded = false;
    this._coolingBoostEndsAt = Math.max(0, Math.round(savedPlayerState?.coolingBoostRemainingMs ?? 0));
    this._heatWarningActive = false;
    this._nextHeatWarningShakeAt = 0;
    this._rbOffset = 0;   // rubber-band spring displacement (0 = neutral)
    this._rbVel    = 0;   // spring velocity

    RunState.lives = this._playerLives;

    this._buildWeaponDisplay();
    this._buildStatusBars();
    this._buildHUD();
    this._updateTimedBonuses(0);

    // ── Enemy management ────────────────────────────────────────────────────
    this._enemies    = [];   // live enemy instances
    this._eBullets   = [];   // velocity-driven enemy bullet rectangles
    this._enemyGroup = this.physics.add.group();
    this._formations = [];   // active FormationControllers
    this._enemyAdaptivePolicy = this._deps.enemyAdaptivePolicy ?? new EnemyAdaptivePolicy();
    this._enemyAdaptivePolicy.load?.();
    this._danceGenerator = new DanceGenerator({
      network: this._enemyAdaptivePolicy.getDanceNetwork(),
      encoder: this._enemyAdaptivePolicy._encoder,
      playerStyleProfile: RunState.playerStyleProfile ?? null,
    });
    this._ensureRuntimeWavesReady();
    this._adaptiveStatsResolver = this._deps.adaptiveStatsResolver ?? new AdaptiveStatsResolver({
      policy: this._enemyAdaptivePolicy,
      baseResolveStats: resolveStats,
    });
    this._enemyLearningSession = this._enemyAdaptivePolicy.createRunSession?.({
      scene: this,
      levelNumber: (this._levelIndex ?? 0) + 1,
      getPlayerSnapshot: () => this._getEnemyLearningPlayerSnapshot(),
      getWeaponSnapshot: () => this._weapons?.getLearningSnapshot?.() ?? {
        primaryWeaponKey: null,
        heatRatio: 0,
        isOverheated: false,
        primaryDamageMultiplier: 1,
      },
      getEnemies: () => this._enemies,
      getPlayerBullets: () => this._weapons?.pool?.getChildren?.()?.filter?.(bullet => bullet?.active) ?? [],
    }) ?? null;

    // Player bullets hit enemies
    this.physics.add.overlap(
      this._weapons.pool,
      this._enemyGroup,
      this._onBulletHitEnemy,
      null,
      this
    );

    // Enemy body touches player
    this.physics.add.overlap(
      this._player,
      this._enemyGroup,
      this._onEnemyTouchPlayer,
      null,
      this
    );

    this.events.on(EVENTS.ENEMY_FIRE,       this._onEnemyFire,  this);
    this.events.on(EVENTS.ENEMY_DIED,       this._onEnemyDied,  this);
    this.events.on(EVENTS.ALL_WAVES_COMPLETE, this._onLevelClear, this);
    this.events.on(EVENTS.SQUADRON_SPAWNED, this._onSquadronSpawned, this);

    // ── WaveSpawner ─────────────────────────────────────────────────────────
    this._spawner = new WaveSpawner(
      this,
      this._levelIndex,
      (type, x, y, stats, dance, meta) => this._spawnEnemy(type, x, y, stats, dance, meta),
      Math.random,
      {
        statsResolver: (args) => this._adaptiveStatsResolver.resolve(args),
      }
    );
    this._bonuses = new BonusSystem(this, {
      effects: this._effects,
      rng:     this._spawner._rng ?? Math.random,
    });
    this._playerShieldFx = new ShieldController(this, this._player, {
      effects:    this._effects,
      points:     this._playerShield,
      maxPoints:  PLAYER_SHIELD_MAX,
      radius:     24,
      depthOffset: 2,
      barPlacement: 'bottom',
      onChange:   ({ points }) => {
        this._playerShield = points;
        this.events.emit(EVENTS.SHIELD_CHANGED, {
          current: points,
          max: PLAYER_SHIELD_MAX,
        });
        this._drawStatusBars();
      },
    });

    this.physics.add.overlap(
      this._weapons.pool,
      this._bonuses.group,
      this._onBulletHitBonus,
      null,
      this
    );
    this.physics.add.overlap(
      this._player,
      this._bonuses.group,
      this._onPlayerCollectBonus,
      null,
      this
    );

    this._squadronScoreCheckpoint = 0;   // score at the start of the current squadron attempt

    this._showLevelBanner(this._levelIndex + 1);
    if (this._debugOptions.debugEnd) {
      this.time.delayedCall(DEBUG_END_DELAY_MS, () => this._onLevelClear());
    } else {
      this.time.delayedCall(2000, () => this._spawner.start());
    }

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('MenuScene'));
  }

  _unlockAudio() {
    this.sound?.unlock?.();
    this.sound?.context?.resume?.();
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  update(time, delta) {
    if (this._gameOver || this._respawning) return;

    this._lastUpdateDeltaMs = delta;
    this._hudTimeMs = time;
    this._bg.update(delta);
    if (this._levelClearing) return;
    this._movePlayer();
    this._updatePlayerParallax(delta);
    this._updateRubberBand(delta);
    this._updateTimedBonuses(time);
    const wantsToFire = this._space.isDown;
    this._weapons.update(delta, wantsToFire);

    if (wantsToFire) {
      const didFire = this._weapons.tryFire(this._player.x, this._player.y);
      if (didFire) this._playPlayerShotFeedback(this._weapons.lastShotInfo);
    }
    this._updateHeatWarningShake(time);
    this._drawStatusBars(time);

    this._spawner.update(delta);
    this._bonuses.update(delta);

    // Update enemies; cull anything that has gone off-screen
    for (let i = this._enemies.length - 1; i >= 0; i--) {
      const e = this._enemies[i];
      if (!e.active) { this._enemyGroup.remove(e); this._enemies.splice(i, 1); continue; }
      if (
        !e._persistUntilDestroyed
        && (e.y > HEIGHT + 80 || e.x < -100 || e.x > WIDTH + 100)
      ) {
        this._removeEnemy(e, i);
        continue;
      }
      e.update(delta);
    }

    this._enemyLearningSession?.update?.(delta);

    // Move enemy bullets; check player AABB collision
    const px = this._player.x;
    const py = this._player.y;
    const dt = delta / 1000;
    for (let i = this._eBullets.length - 1; i >= 0; i--) {
      const b = this._eBullets[i];
      if (!b.active) { this._eBullets.splice(i, 1); continue; }

      b.x += (b._vx ?? 0) * dt;
      b.y += (b._vy ?? 0) * dt;

      if (
        b.y < -20 || b.y > HEIGHT + 20
        || b.x < -20 || b.x > WIDTH + 20
      ) {
        b.destroy();
        this._eBullets.splice(i, 1);
        continue;
      }

      // Apply and decay temporary shockwave push on top of the authored bullet velocity.
      if (b._pushVx || b._pushVy) {
        b.x += (b._pushVx ?? 0) * dt;
        b.y += (b._pushVy ?? 0) * dt;
        b._pushVx *= Math.max(0, 1 - 2.5 * dt);
        b._pushVy *= Math.max(0, 1 - 2.5 * dt);
        if (Math.abs(b._pushVx) < 0.5) b._pushVx = 0;
        if (Math.abs(b._pushVy) < 0.5) b._pushVy = 0;
      }

      const playerBullet = this._findCollidingPlayerBullet(b);
      if (playerBullet) {
        this._onBulletHitEnemyBullet(playerBullet, b, i);
        continue;
      }

      if (Math.abs(b.x - px) < 15.5 && Math.abs(b.y - py) < 23) {
        const dmg = b._damage ?? 10;
        this._destroyEnemyBullet(b, i);
        this._onPlayerHit(dmg, {
          sourceType: b._sourceType ?? null,
          sourceEnemyId: b._sourceEnemyId ?? null,
          squadId: b._squadId ?? null,
          sourceKind: 'projectile',
        });
      }
    }

    // Signal wave clear once all squadrons have spawned and no enemies remain
    const pendingMainSquadrons = this._spawner.pendingMainSquadrons ?? this._spawner.pendingSquadrons ?? 0;
    if (this._spawner.isWaveActive
        && pendingMainSquadrons === 0
        && this._countMainWaveEnemies() === 0) {
      this._spawner.onWaveCleared();
    }
  }

  // ── Player ────────────────────────────────────────────────────────────────

  _createPlayer() {
    this._playerShadow = this.add.image(WIDTH / 2, HEIGHT - 80, 'spacecraft1');
    this._playerShadow.setOrigin?.(0.5, 0.5);
    this._playerShadow.setDepth?.(PLAYER_VISUAL_DEPTH - 1);
    this._playerShadow.setTint?.(0x6b7ea6);
    this._playerShadow.setAlpha?.(0.92);
    this._playerShadow.setCrop?.(0, PLAYER_REAR_CROP_Y, PLAYER_TEXTURE_WIDTH, PLAYER_REAR_CROP_HEIGHT);

    const p = this.add.image(WIDTH / 2, HEIGHT - 80, 'spacecraft1');
    p.setOrigin?.(0.5, 0.5);
    p.setDepth?.(PLAYER_VISUAL_DEPTH);
    p._baseDisplayWidth = 34;
    p._baseDisplayHeight = 42;
    p.setDisplaySize?.(p._baseDisplayWidth, p._baseDisplayHeight);
    p.setCrop?.(0, PLAYER_CORE_CROP_Y, PLAYER_TEXTURE_WIDTH, PLAYER_CORE_CROP_HEIGHT);
    this.physics.add.existing(p);
    p.body.setCollideWorldBounds?.(true);
    p.body.setSize?.(p._baseDisplayWidth, p._baseDisplayHeight, true);

    this._playerHighlight = this.add.image(WIDTH / 2, HEIGHT - 80, 'spacecraft1');
    this._playerHighlight.setOrigin?.(0.5, 0.5);
    this._playerHighlight.setDepth?.(PLAYER_VISUAL_DEPTH + 1);
    this._playerHighlight.setTint?.(0xe7f7ff);
    this._playerHighlight.setAlpha?.(1);
    this._playerHighlight.setCrop?.(0, PLAYER_FRONT_CROP_Y, PLAYER_TEXTURE_WIDTH, PLAYER_FRONT_CROP_HEIGHT);

    this._playerParallaxOffsetX = 0;
    this._playerParallaxOffsetY = 0;
    this._setPlayerVisualSize(
      p._baseDisplayWidth,
      p._baseDisplayHeight
    );
    this._syncPlayerParallaxVisuals();
    return p;
  }

  _resolveStartingPlayerStats() {
    const startingBonuses = MetaProgression.getStartingBonuses();
    this._startingPlayerHp = Math.min(
      PLAYER_HP_MAX,
      PLAYER_HP_DEFAULT + (startingBonuses.hp ?? 0)
    );
    this._startingPlayerShield = Math.min(
      PLAYER_SHIELD_MAX,
      PLAYER_SHIELD_DEFAULT + (startingBonuses.shield ?? 0)
    );
  }

  _prepareRunState() {
    const savedPlayerState = RunState.consumePlayerState?.() ?? null;

    if (!savedPlayerState) {
      this._resetRuntimeGeneratedLevels();
      const requestedLevel = this._debugOptions?.level2
        ? 2
        : Math.max(1, Math.round(RunState.level ?? 1));
      RunState.beginNewRun?.({
        level: requestedLevel,
        lives: PLAYER_LIVES_DEFAULT,
      });
    }

    this._playerLives = Math.max(1, Math.round(RunState.lives ?? PLAYER_LIVES_DEFAULT));
    this._levelIndex = Math.max(0, Math.round((RunState.level ?? 1) - 1));
    this._weapons?.applyPersistentState?.(savedPlayerState?.weaponState ?? null);

    return savedPlayerState;
  }

  _resetRuntimeGeneratedLevels() {
    for (const level of LEVELS) {
      if (level?.runtimeWaveSource !== 'dance_generator') continue;
      level.waves = [];
    }
  }

  _buildPersistentPlayerState() {
    return {
      hp: Math.min(PLAYER_HP_MAX, Math.max(0, Math.round(this._playerHp ?? this._startingPlayerHp))),
      shield: Math.min(PLAYER_SHIELD_MAX, Math.max(0, Math.round(this._playerShield ?? this._startingPlayerShield))),
      coolingBoostRemainingMs: Math.max(0, Math.round((this._coolingBoostEndsAt ?? 0) - (this._hudTimeMs ?? 0))),
      weaponState: this._weapons?.getPersistentState?.() ?? null,
    };
  }

  /**
   * Spring-damper rubber-band for the player sprite.
   * Visual only — physics body is unaffected.
   * @param {number} delta - ms since last frame
   */
  _updateRubberBand(delta) {
    const dt = delta / 1000;
    const movingBack = this._cursors.down.isDown || this._wasd.down.isDown;
    const movingUp   = this._cursors.up.isDown   || this._wasd.up.isDown;

    const target  = movingBack ? 0.35 : movingUp ? -0.35 : 0;
    const SPRING  = 40;
    const DAMPING = 10;

    this._rbVel    += ((target - this._rbOffset) * SPRING - this._rbVel * DAMPING) * dt;
    this._rbOffset += this._rbVel * dt;

    const backwardStretch = Math.max(0, this._rbOffset);
    const forwardStretch = Math.max(0, -this._rbOffset);
    const widthFactor = 1 + backwardStretch * 0.55 - forwardStretch * 0.08;
    const heightFactor = 1 - backwardStretch * 0.26 + forwardStretch * 0.18;
    const baseWidth = this._player._baseDisplayWidth ?? this._player.displayWidth ?? 34;
    const baseHeight = this._player._baseDisplayHeight ?? this._player.displayHeight ?? 42;
    this._setPlayerVisualSize(
      baseWidth * widthFactor,
      baseHeight * heightFactor
    );
  }

  _updatePlayerParallax(delta) {
    const dt = Math.max(0, delta) / 1000;
    const body = this._player?.body;
    const maxSpeed = Math.max(1, PLAYER_SPEED * this._playerSpeed);
    const targetX = Phaser.Math.Clamp((body?.velocity?.x ?? 0) / maxSpeed, -1, 1);
    const targetY = Phaser.Math.Clamp((body?.velocity?.y ?? 0) / maxSpeed, -1, 1);
    const smoothing = Math.min(1, PLAYER_PARALLAX_LERP * dt);

    this._playerParallaxOffsetX = Phaser.Math.Linear(
      this._playerParallaxOffsetX ?? 0,
      targetX,
      smoothing
    );
    this._playerParallaxOffsetY = Phaser.Math.Linear(
      this._playerParallaxOffsetY ?? 0,
      targetY,
      smoothing
    );

    this._syncPlayerParallaxVisuals();
  }

  _createWASD() {
    return this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
  }

  _movePlayer() {
    const body  = this._player.body;
    const c     = this._cursors;
    const w     = this._wasd;

    const left  = c.left.isDown  || w.left.isDown;
    const right = c.right.isDown || w.right.isDown;
    const up    = c.up.isDown    || w.up.isDown;
    const down  = c.down.isDown  || w.down.isDown;

    const spd = PLAYER_SPEED * this._playerSpeed;
    body.setVelocity(0);
    if (left)  body.setVelocityX(-spd);
    if (right) body.setVelocityX(spd);
    if (up)    body.setVelocityY(-spd);
    if (down)  body.setVelocityY(spd);

    if ((left || right) && (up || down)) {
      body.velocity.normalize().scale(PLAYER_SPEED);
    }
  }

  _setPlayerVisualSize(width, height) {
    this._player?.setDisplaySize?.(width, height);
    this._playerShadow?.setDisplaySize?.(width, height);
    this._playerHighlight?.setDisplaySize?.(width, height);
  }

  _syncPlayerParallaxVisuals() {
    if (!this._player) return;

    const x = this._player.x;
    const y = this._player.y;
    const offsetX = this._playerParallaxOffsetX ?? 0;
    const offsetY = this._playerParallaxOffsetY ?? 0;
    const speedAlpha = Math.min(1, Math.hypot(offsetX, offsetY));

    this._player.setRotation?.(0);

    if (this._playerShadow) {
      this._playerShadow.x = x + offsetX * PLAYER_PARALLAX_REAR_SHIFT_X;
      this._playerShadow.y = y + offsetY * PLAYER_PARALLAX_REAR_SHIFT_Y;
      this._playerShadow.setRotation?.(0);
      this._playerShadow.setVisible?.(this._player.visible);
    }

    if (this._playerHighlight) {
      this._playerHighlight.x = x + offsetX * PLAYER_PARALLAX_FRONT_SHIFT_X;
      this._playerHighlight.y = y + offsetY * PLAYER_PARALLAX_FRONT_SHIFT_Y;
      this._playerHighlight.setRotation?.(0);
      this._playerHighlight.setAlpha?.(0.94 + speedAlpha * 0.06);
      this._playerHighlight.setVisible?.(this._player.visible);
    }

  }

  _onPlayerHit(damage = 10, source = {}) {
    if (this._gameOver || this._respawning) return;

    const shieldResult = this._playerShieldFx
      ? this._playerShieldFx.takeDamage(damage)
      : {
          absorbed: Math.min(this._playerShield, damage),
          overflow: Math.max(0, damage - this._playerShield),
        };

    if (!this._playerShieldFx && shieldResult.absorbed > 0) {
      this._playerShield = Math.max(0, this._playerShield - shieldResult.absorbed);
      this._drawStatusBars();
    }

    this.events.emit(EVENTS.PLAYER_HIT, {
      damage,
      absorbed: shieldResult.absorbed ?? 0,
      hpDamage: shieldResult.overflow ?? 0,
      sourceType: source.sourceType ?? null,
      sourceEnemyId: source.sourceEnemyId ?? null,
      squadId: source.squadId ?? null,
      sourceKind: source.sourceKind ?? null,
      playerX: this._player?.x ?? WIDTH / 2,
      playerY: this._player?.y ?? HEIGHT - 80,
    });

    if (shieldResult.overflow <= 0) {
      return;
    }

    this._playerHp = Math.max(0, this._playerHp - shieldResult.overflow);
    this.events.emit(EVENTS.HEALTH_CHANGED, {
      current: this._playerHp,
      max: PLAYER_HP_MAX,
    });
    this._drawStatusBars();

    if (this._playerHp <= 0) {
      this._playerLives--;
      RunState.lives = this._playerLives;
      this._livesText?.setText?.(`× ${Math.max(0, this._playerLives)}`);
      if (this._playerLives <= 0) {
        this._killPlayer();
      } else {
        this._respawnAfterDeath();
      }
    }
  }

  _resetPlayerHeat() {
    this._weapons?.resetHeat?.();
    this._stopHeatWarningShake();
    this._drawStatusBars?.();
  }

  _updateTimedBonuses(timeMs = this._hudTimeMs) {
    const remainingMs = Math.max(0, (this._coolingBoostEndsAt ?? 0) - timeMs);

    if (this._coolingBoostEndsAt > 0 && remainingMs <= 0) {
      this._coolingBoostEndsAt = 0;
      this._weapons?.resetHeatRecoveryStepMs?.();
    }

    if (!this._heatCountdownText) return;

    const active = remainingMs > 0;
    this._heatCountdownText.setVisible?.(active);
    if (active) {
      this._heatCountdownText.setText?.(`${Math.ceil(remainingMs / 1000)}s`);
    }
  }

  _resetPlayerBonuses() {
    const startingShield = this._startingPlayerShield ?? PLAYER_SHIELD_DEFAULT;
    if (this._playerShieldFx?.setPoints) {
      this._playerShieldFx.setPoints(startingShield);
    } else {
      this._playerShield = startingShield;
      this.events.emit(EVENTS.SHIELD_CHANGED, {
        current: this._playerShield,
        max: PLAYER_SHIELD_MAX,
      });
    }

    this._coolingBoostEndsAt = 0;
    this._weapons?.resetHeatRecoveryStepMs?.();
    this._weapons?.resetPrimaryDamageMultiplier?.();
    this._weapons?.resetPrimaryWeapon?.();
    this._updateTimedBonuses?.(this._hudTimeMs);
    this._drawWeaponDisplay?.();
  }

  _respawnAfterDeath() {
    this._resetPlayerHeat();
    this._resetPlayerBonuses();
    this._respawning = true;

    this._explode(this._player.x, this._player.y);
    this._player.setVisible(false);
    this._playerShadow?.setVisible?.(false);
    this._playerHighlight?.setVisible?.(false);
    if (this._player.body) this._player.body.enable = false;

    for (const fc of this._formations) fc.stop();
    this._formations = [];

    // Defer physics pause so fragments have time to travel before freezing.
    this.time.delayedCall(400, () => this.physics.pause());

    this.time.delayedCall(1500, () => {
      // Clear all enemies
      for (let i = this._enemies.length - 1; i >= 0; i--) {
        const e = this._enemies[i];
        e.alive = false;
        this._enemyGroup.remove(e);
        e.destroy();
      }
      this._enemies = [];

      // Clear enemy bullets
      for (const b of this._eBullets) { if (b.active) b.destroy(); }
      this._eBullets = [];
      this._bonuses?.clear?.();

      // Reset player to starting position
      this._player.x = WIDTH / 2;
      this._player.y = HEIGHT - 80;
      this._player.setVisible(true);
      this._playerParallaxOffsetX = 0;
      this._playerParallaxOffsetY = 0;
      this._syncPlayerParallaxVisuals();
      if (this._player.body) {
        this._player.body.reset(WIDTH / 2, HEIGHT - 80);
        this._player.body.enable = true;
      }

      this._playerHp = this._startingPlayerHp ?? PLAYER_HP_DEFAULT;
      this.events.emit(EVENTS.HEALTH_CHANGED, {
        current: this._playerHp,
        max: PLAYER_HP_MAX,
      });
      this._rbOffset = 0;
      this._rbVel    = 0;
      this._setPlayerVisualSize(
        this._player._baseDisplayWidth ?? 34,
        this._player._baseDisplayHeight ?? 42
      );
      this._drawStatusBars();

      // Roll back score to the start of this squadron — replayed enemies
      // would otherwise award points twice for the same kill attempt.
      RunState.score = this._squadronScoreCheckpoint;
      if (this._scoreTween) { this._scoreTween.stop(); this._scoreTween = null; }
      this._displayedScore = this._squadronScoreCheckpoint;
      this._scoreText.setText(`SCORE  ${this._squadronScoreCheckpoint}`);

      this.physics.resume();
      this._respawning = false;

      // Re-launch the squadron that was active when the player died
      this._spawner.replayLastSquadron();
    });
  }

  _killPlayer() {
    if (this._gameOver) return;
    this._resetPlayerHeat();
    this._resetPlayerBonuses();
    this._gameOver = true;
    RunState.clearPlayerState?.();
    RunState.clearPlayerStyleProfile?.();
    this._finalizeEnemyLearning('enemy_win');

    this._explode(this._player.x, this._player.y);
    this._player.setVisible(false);
    this._playerShadow?.setVisible?.(false);
    this._playerHighlight?.setVisible?.(false);
    if (this._player.body) this._player.body.enable = false;

    for (const fc of this._formations) fc.stop();

    this.add.text(WIDTH / 2, HEIGHT / 2 - 30, 'GAME OVER', {
      fontSize: '42px', fill: '#ff2222', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);

    this.add.text(WIDTH / 2, HEIGHT / 2 + 30, `SCORE  ${RunState.score}`, {
      fontSize: '20px', fill: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(20);

    this.time.delayedCall(4000, () => this.scene.start('MenuScene'));
    this.input.keyboard.once('keydown-ENTER', () => {
      RunState.beginNewRun?.({ level: 1, lives: PLAYER_LIVES_DEFAULT });
      this.scene.start('GameScene');
    });
  }

  _onSquadronSpawned({ count, squadron, overlay = false }) {
    if (overlay) return;
    this._squadronScoreCheckpoint = RunState.score;
    const ships = this._enemies
      .slice(-count)
      .filter(enemy => enemy.dance === 'straight');
    if (ships.length === 0) return;
    const fc = new FormationController(
      this,
      ships,
      squadron?.controller ?? {},
      this._spawner?._rng ?? Math.random
    );
    this._formations.push(fc);
  }

  // ── Enemy spawning ────────────────────────────────────────────────────────

  _spawnEnemy(type, x, y, stats, dance, meta = {}) {
    let enemy;
    switch (type) {
      case 'mine':
        enemy = new Mine(this, x, y, stats, dance);
        break;
      case 'raptor':
        enemy = new Raptor(this, x, y, stats, dance);
        break;
      case 'skirm':
      default:
        enemy = new Skirm(this, x, y, stats, dance);
        break;
    }
    enemy._learningId = `enemy-${++this._nextLearningEnemyId}`;
    enemy._overlayRaid = Boolean(meta.overlay);
    enemy._spawnWaveId = meta.waveId ?? null;
    enemy._sourceEventId = meta.sourceEventId ?? null;
    enemy._squadId = meta.squadId ?? null;
    enemy._squadTemplateId = meta.squadTemplateId ?? null;
    enemy._squadSpawnCount = meta.squadSize ?? 1;
    enemy._squadSpawnIndex = meta.squadIndex ?? 0;
    enemy._formationType = meta.formation ?? null;
    enemy._spawnDance = dance;
    enemy.primeSquadFireCooldown?.(enemy._squadSpawnIndex, enemy._squadSpawnCount);
    this._enemies.push(enemy);
    this._enemyGroup.add(enemy);
    this.events.emit(EVENTS.ENEMY_SPAWNED, {
      enemy,
      type,
      squadId: enemy._squadId,
      squadTemplateId: enemy._squadTemplateId,
      squadSize: enemy._squadSpawnCount,
      squadIndex: enemy._squadSpawnIndex,
      formation: enemy._formationType,
      dance,
      overlay: enemy._overlayRaid,
      waveId: enemy._spawnWaveId,
    });
  }

  _countMainWaveEnemies() {
    return this._enemies.reduce((count, enemy) => (
      enemy?.active !== false && !enemy?._overlayRaid ? count + 1 : count
    ), 0);
  }

  /** Remove an off-screen enemy silently (no score awarded). */
  _removeEnemy(enemy, idx) {
    enemy.alive = false;
    enemy.markEscaped?.();
    enemy.setActive(false).setVisible(false);
    if (enemy.body) enemy.body.stop();
    this._enemyGroup.remove(enemy);
    enemy.destroy();
    this._enemies.splice(idx, 1);
  }

  // ── Collision handlers ────────────────────────────────────────────────────

  _onBulletHitEnemy(bullet, enemy) {
    const shotPayload = bullet._shotPayload;
    const alreadyHit = shotPayload?.hitEnemies?.has(enemy);
    const damage = alreadyHit
      ? 0
      : (shotPayload ? shotPayload.damage : (bullet._damage ?? this._weapons.damage));
    const scoreMultiplier = shotPayload?.scoreMultiplier ?? bullet._scoreMultiplier ?? 1;
    this._consumePlayerBullet(bullet);
    if (!enemy.alive || damage <= 0) return;
    if (shotPayload) shotPayload.hitEnemies.add(enemy);
    enemy.takeDamage(damage, {
      scoreMultiplier,
      cause: 'player_bullet',
    });
  }

  _onBulletHitBonus(bullet, bonus) {
    if (!bullet?.active || !bonus?.active) return;

    const damage = bullet._shotPayload?.damage ?? bullet._damage ?? this._weapons.damage;
    this._consumePlayerBullet(bullet);

    bonus.takeDamage(damage);
  }

  _onBulletHitEnemyBullet(playerBullet, enemyBullet, enemyBulletIdx = this._eBullets.indexOf(enemyBullet)) {
    if (!playerBullet?.active || !enemyBullet?.active) return;
    this._consumePlayerBullet(playerBullet);
    this._destroyEnemyBullet(enemyBullet, enemyBulletIdx);
  }

  _onEnemyTouchPlayer(player, enemy) {
    if (!enemy.alive) return;
    const dmg = enemy.contactDamage ?? enemy.damage ?? 10;
    enemy.die({ cause: 'player_collision' });
    this._onPlayerHit(dmg, {
      sourceType: enemy.enemyType,
      sourceEnemyId: enemy._learningId ?? null,
      squadId: enemy._squadId ?? null,
      sourceKind: 'contact',
    });
  }

  _onEnemyFire({
    x,
    y,
    vx = 0,
    vy = 0,
    damage,
    width = 3,
    height = 10,
    color = 0xff4400,
    sourceType = null,
    sourceEnemy = null,
    sourceEnemyId = null,
    squadId = null,
    squadTemplateId = null,
  }) {
    const bullet = this.add.rectangle(x, y, width, height, color).setDepth(9);
    const rotation = (vx === 0 && vy === 0)
      ? 0
      : Math.atan2(vy, vx) - Math.PI / 2;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    bullet._vx = vx;
    bullet._vy = vy;
    bullet._damage = damage;
    bullet._sourceType = sourceType;
    bullet._sourceEnemy = sourceEnemy;
    bullet._sourceEnemyId = sourceEnemyId ?? sourceEnemy?._learningId ?? null;
    bullet._squadId = squadId;
    bullet._squadTemplateId = squadTemplateId;
    bullet._hitboxWidth = Math.abs(width * cos) + Math.abs(height * sin);
    bullet._hitboxHeight = Math.abs(width * sin) + Math.abs(height * cos);
    bullet.setRotation?.(rotation);
    this._eBullets.push(bullet);
  }

  _consumePlayerBullet(bullet) {
    this._weapons.pool.killAndHide(bullet);
    if (bullet.body) {
      bullet.body.stop?.();
      bullet.body.enable = false;
    }
  }

  _destroyEnemyBullet(bullet, idx = this._eBullets.indexOf(bullet)) {
    if (idx !== -1) this._eBullets.splice(idx, 1);
    bullet.destroy?.();
  }

  _findCollidingPlayerBullet(enemyBullet) {
    const bullets = this._weapons?.pool?.getChildren?.() ?? [];
    for (const playerBullet of bullets) {
      if (!playerBullet?.active) continue;
      if (this._doBulletsOverlap(playerBullet, enemyBullet)) return playerBullet;
    }
    return null;
  }

  _doBulletsOverlap(playerBullet, enemyBullet) {
    const playerHitbox = this._resolvePlayerBulletHitbox(playerBullet);
    const enemyHitbox = this._resolveEnemyBulletHitbox(enemyBullet);
    const deltaMs = this._lastUpdateDeltaMs ?? 16;
    const playerSweep = this._resolveSweptBulletBounds(playerBullet, playerHitbox, this._resolvePlayerBulletVelocity(playerBullet), deltaMs);
    const enemySweep = this._resolveSweptBulletBounds(enemyBullet, enemyHitbox, this._resolveEnemyBulletVelocity(enemyBullet), deltaMs);
    return playerSweep.minX < enemySweep.maxX
      && playerSweep.maxX > enemySweep.minX
      && playerSweep.minY < enemySweep.maxY
      && playerSweep.maxY > enemySweep.minY;
  }

  _resolvePlayerBulletHitbox(bullet) {
    const textureKey = bullet?.texture?.key ?? bullet?.texture ?? '';
    const width = bullet?.displayWidth
      ?? bullet?.width
      ?? (textureKey === 'bullet_laser_warning' ? PLAYER_WARNING_BULLET_WIDTH : PLAYER_BULLET_WIDTH);
    const height = bullet?.displayHeight
      ?? bullet?.height
      ?? PLAYER_BULLET_HEIGHT;
    return {
      halfW: Math.max(1, width * 0.5),
      halfH: Math.max(1, height * 0.5),
    };
  }

  _resolveEnemyBulletHitbox(bullet) {
    const width = bullet?._hitboxWidth ?? bullet?.displayWidth ?? bullet?.width ?? ENEMY_BULLET_WIDTH;
    const height = bullet?._hitboxHeight ?? bullet?.displayHeight ?? bullet?.height ?? ENEMY_BULLET_HEIGHT;
    return {
      halfW: Math.max(1, width * 0.5),
      halfH: Math.max(1, height * 0.5),
    };
  }

  _resolvePlayerBulletVelocity(bullet) {
    return {
      x: bullet?.body?._vx ?? bullet?.body?.velocity?.x ?? 0,
      y: bullet?.body?._vy ?? bullet?.body?.velocity?.y ?? 0,
    };
  }

  _resolveEnemyBulletVelocity(bullet) {
    return {
      x: (bullet?._vx ?? 0) + (bullet?._pushVx ?? 0),
      y: (bullet?._vy ?? 0) + (bullet?._pushVy ?? 0),
    };
  }

  _resolveSweptBulletBounds(bullet, hitbox, velocity, deltaMs = 16) {
    const dt = Math.max(0, deltaMs) / 1000;
    const x = bullet?.x ?? 0;
    const y = bullet?.y ?? 0;
    const prevX = x - ((velocity?.x ?? 0) * dt);
    const prevY = y - ((velocity?.y ?? 0) * dt);

    return {
      minX: Math.min(x, prevX) - hitbox.halfW,
      maxX: Math.max(x, prevX) + hitbox.halfW,
      minY: Math.min(y, prevY) - hitbox.halfH,
      maxY: Math.max(y, prevY) + hitbox.halfH,
    };
  }

  _onEnemyDied({ x, y, type, vx, vy, score, scoreMultiplier = 1, dropChance = 0 }) {
    this._explodeForType(x, y, type, vx ?? 0, vy ?? 0);
    RunState.addScore(Math.round(score * scoreMultiplier));
    RunState.kills++;
    this._animateScore(RunState.score);
    this._bonuses?.spawnRandomDrop(x, y, dropChance);
  }

  _onPlayerCollectBonus(player, bonus) {
    const payload = this._bonuses.collectBonus(bonus);
    if (!payload) return;
    this._applyBonusEffect(payload);
    this._playBonusPickupSound(payload.pickupSound);
    this._effects?.showDamageNumber?.(
      this._player?.x ?? bonus?.x ?? 0,
      (this._player?.y ?? bonus?.y ?? 0) - 28,
      payload.label?.toUpperCase?.() ?? payload.label ?? payload.key,
      {
        color: '#ffffff',
        fontSize: '18px',
        strokeThickness: 3,
        glowColor: 0xffffff,
        glowStrength: 6,
        lift: 28,
        duration: 520,
        scaleTo: 1.08,
      }
    );
  }

  /**
   * Play the configured pickup sound if the bonus defines one.
   * @param {string} soundKey
   */
  _playBonusPickupSound(soundKey) {
    if (!soundKey) return;
    this.sound?.play?.(soundKey);
  }

  /**
   * Apply a collected bonus to the current player state.
   * @param {{key: string, kind: string, value: number, pending?: boolean}} bonus
   */
  _applyBonusEffect(bonus) {
    if (!bonus) return;

    switch (bonus.kind) {
      case 'life':
        this._playerLives += bonus.value;
        RunState.lives = this._playerLives;
        this._livesText?.setText?.(`× ${this._playerLives}`);
        break;
      case 'health':
        this._playerHp = Math.min(PLAYER_HP_MAX, this._playerHp + bonus.value);
        this.events.emit(EVENTS.HEALTH_CHANGED, {
          current: this._playerHp,
          max: PLAYER_HP_MAX,
        });
        break;
      case 'shield':
        if (this._playerShieldFx) {
          this._playerShieldFx.addPoints(bonus.value);
        } else {
          this._playerShield = Math.min(PLAYER_SHIELD_MAX, this._playerShield + bonus.value);
          this.events.emit(EVENTS.SHIELD_CHANGED, {
            current: this._playerShield,
            max: PLAYER_SHIELD_MAX,
          });
        }
        break;
      case 'coolingBoost':
        this._weapons?.setHeatRecoveryStepMs?.(bonus.recoveryMs ?? bonus.value);
        this._coolingBoostEndsAt = (this._hudTimeMs ?? 0) + (bonus.durationMs ?? 0);
        this._updateTimedBonuses?.(this._hudTimeMs);
        break;
      case 'laserPower': {
        const totalMultiplier = this._weapons?.multiplyPrimaryDamage?.(bonus.multiplier ?? bonus.value) ?? 1;
        this._drawWeaponDisplay?.();
        this.events.emit(EVENTS.WEAPON_CHANGED, {
          ...bonus,
          pending: false,
          slot: 0,
          totalMultiplier,
        });
        break;
      }
      case 'newWeapon':
        if (bonus.weaponKey) {
          this._weapons?.equipPrimaryWeapon?.(bonus.weaponKey);
          this._drawWeaponDisplay?.();
          this.events.emit(EVENTS.WEAPON_CHANGED, {
            ...bonus,
            pending: false,
            slot: 0,
          });
          break;
        }
        this.events.emit(EVENTS.WEAPON_CHANGED, {
          ...bonus,
          pending: true,
        });
        break;
      case 'weaponUpgrade':
        this.events.emit(EVENTS.WEAPON_CHANGED, {
          ...bonus,
          pending: true,
        });
        break;
      default:
        break;
    }

    this._drawStatusBars();
  }

  _animateScore(target) {
    if (this._scoreTween) this._scoreTween.stop();
    const obj = { val: this._displayedScore ?? 0 };
    this._scoreTween = this.tweens.add({
      targets:  obj,
      val:      target,
      duration: 600,
      ease:     'Linear',
      onUpdate: () => {
        this._displayedScore = obj.val;
        this._scoreText.setText(`SCORE  ${Math.floor(obj.val)}`);
      },
      onComplete: () => { this._displayedScore = target; },
    });
  }

  _onLevelClear() {
    if (this._levelClearing || this._gameOver) return;

    this._levelClearing = true;
    this._stopHeatWarningShake();
    this._clearLevelThreats();
    this._player.body?.stop?.();
    if (this._player.body) this._player.body.enable = false;
    this._bg?.startWarpExit?.(LEVEL_CLEAR_EXIT_MS);

    this.tweens.add?.({
      targets: [this._player, this._playerShadow, this._playerHighlight].filter(Boolean),
      y: -80,
      duration: LEVEL_CLEAR_EXIT_MS,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        this._player.setVisible?.(false);
        this._playerShadow?.setVisible?.(false);
        this._playerHighlight?.setVisible?.(false);
      },
    });

    this.time.delayedCall(LEVEL_CLEAR_EXIT_MS, () => {
      this._showLevelCompleteCard();
    });
  }

  _clearLevelThreats() {
    for (const fc of this._formations) fc.stop?.();
    this._formations = [];

    for (const bullet of this._eBullets) bullet.destroy?.();
    this._eBullets = [];

    for (let i = this._enemies.length - 1; i >= 0; i--) {
      const enemy = this._enemies[i];
      enemy.alive = false;
      enemy.setActive?.(false);
      enemy.setVisible?.(false);
      enemy.body?.stop?.();
      this._enemyGroup.remove?.(enemy);
      enemy.destroy?.();
    }
    this._enemies = [];
    this._bonuses?.clear?.();
  }

  _showLevelCompleteCard() {
    const nextLevelIndex = (this._levelIndex ?? 0) + 1;
    const hasNextLevel   = nextLevelIndex < LEVELS.length;
    const nextLevelConfig = LEVELS[nextLevelIndex];
    const immediateTransitionLearning = hasNextLevel && nextLevelConfig?.runtimeWaveSource === 'dance_generator';
    const learningState = this._finalizeEnemyLearning('player_win', {
      immediate: immediateTransitionLearning,
      nextLevelNumber: nextLevelIndex + 1,
    });

    this._recordLevelCompletion();
    this._bg?.fadeToBlack?.(LEVEL_CLEAR_FADE_MS);

    this.add.text(WIDTH / 2, HEIGHT / 2, 'LEVEL COMPLETE', {
      fontSize: '32px', fill: '#00ffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);

    this.add.text(WIDTH / 2, HEIGHT / 2 + 48, `SCORE  ${RunState.score}`, {
      fontSize: '18px', fill: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(20);

    if (hasNextLevel) {
      RunState.savePlayerStyleProfile?.(learningState?.playerStyleProfile ?? RunState.playerStyleProfile ?? null);
      this._danceGenerator?.setPlayerStyleProfile?.(RunState.playerStyleProfile ?? null);
    } else {
      RunState.clearPlayerStyleProfile?.();
    }

    if (hasNextLevel && nextLevelConfig?.runtimeWaveSource === 'dance_generator') {
      this._danceGenerator?.generateAndInjectWaves(
        LEVELS,
        nextLevelIndex,
        nextLevelConfig.runtimeWaveCount
      );
    }

    if (hasNextLevel) {
      RunState.savePlayerState?.(this._buildPersistentPlayerState());
      RunState.lives = this._playerLives;
      RunState.level = nextLevelIndex + 1;
    } else {
      RunState.clearPlayerState?.();
    }

    this.time.delayedCall(LEVEL_CLEAR_CARD_DELAY_MS, () => this.scene.start('LevelTransitionScene', {
      levelNumber: (this._levelIndex ?? 0) + 1,
      runScore: RunState.score,
      returnSceneKey: hasNextLevel ? 'GameScene' : 'MenuScene',
      continueLabel:  hasNextLevel ? `CONTINUE TO LEVEL ${nextLevelIndex + 1}` : 'BACK TO MENU',
    }));
  }

  _recordLevelCompletion() {
    if (this._levelCompletionRecorded) return;
    this._levelCompletionRecorded = true;
    MetaProgression.recordCompletedLevel(RunState.score);
  }

  _ensureRuntimeWavesReady() {
    const levelConfig = LEVELS[this._levelIndex];
    if (!levelConfig) return;
    if ((levelConfig.waves?.length ?? 0) > 0) return;
    if (levelConfig.runtimeWaveSource !== 'dance_generator') return;

    this._danceGenerator?.generateAndInjectWaves(
      LEVELS,
      this._levelIndex,
      levelConfig.runtimeWaveCount
    );
  }

  _getEnemyLearningPlayerSnapshot() {
    return {
      x: this._player?.x ?? WIDTH / 2,
      y: this._player?.y ?? HEIGHT - 80,
      hasShield: (this._playerShield ?? 0) > 0,
      shieldRatio: PLAYER_SHIELD_MAX > 0 ? (this._playerShield ?? 0) / PLAYER_SHIELD_MAX : 0,
      hpRatio: PLAYER_HP_MAX > 0 ? (this._playerHp ?? 0) / PLAYER_HP_MAX : 0,
    };
  }

  _finalizeEnemyLearning(outcome, options = {}) {
    if (this._runLearningRecorded) return;
    this._runLearningRecorded = true;
    let learningState = null;
    try {
      learningState = this._enemyAdaptivePolicy?.trainFromSession?.(this._enemyLearningSession, outcome, options) ?? null;
    } catch {
      learningState = this._enemyAdaptivePolicy?.getSnapshot?.() ?? null;
    }
    this.events.emit?.(EVENTS.RUN_ENDED, {
      outcome,
      runScore: RunState.score,
      learningState,
    });
    return learningState;
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  _buildStatusBars() {
    const BAR_H = 8, BAR_GAP = 5;
    const X0     = 8;   // left margin
    const Y_TOP  = this._weaponDisplayY + (38 - (2 * BAR_H + BAR_GAP)) / 2;
    const BOX_W  = 62, GAP = 6;
    const nSlots = this._weapons.getSlots().length;
    const BAR_W  = nSlots * BOX_W + (nSlots - 1) * GAP;

    const defs = [
      { key: 'hp',     max: PLAYER_HP_MAX,    color: 0x00cc44 },
      { key: 'heat',   max: this._weapons.maxHeatShots, color: HEAT_BAR_COLOR },
    ];

    this._barFills = {};
    this._heatCoolingFxActive = false;

    defs.forEach((def, i) => {
      const y = Y_TOP + i * (BAR_H + BAR_GAP);

      // background — origin (0,0) so x,y is top-left corner
      this.add.rectangle(X0, y, BAR_W, BAR_H, 0x111111)
        .setDepth(10).setOrigin(0, 0);

      // fill — origin (0,0), width scaled by displayWidth
      const fill = this.add.rectangle(X0, y, BAR_W, BAR_H, def.color)
        .setDepth(11).setOrigin(0, 0);
      this._barFills[def.key] = {
        rect: fill,
        max: def.max,
        fullW: BAR_W,
        color: def.color,
        x: X0,
        y,
        height: BAR_H,
      };

      // border
      const gfx = this.add.graphics().setDepth(12);
      gfx.lineStyle(1, 0x444444, 1);
      gfx.strokeRect(X0, y, BAR_W, BAR_H);
    });

    const heatY = Y_TOP + (BAR_H + BAR_GAP);
    this._heatCountdownText = this.add.text(X0 + BAR_W + 6, heatY + BAR_H / 2, '', {
      fontSize: '11px',
      fill: '#ffffff',
      fontFamily: 'monospace',
    }).setDepth(12).setOrigin(0, 0.5).setVisible(false);

    this._heatCoolingFx = this.add.particles?.(X0 + BAR_W, heatY + BAR_H / 2, 'flares', {
      frame: 'white',
      color: HEAT_COOLING_COLORS,
      lifespan: 900,
      angle: { min: -100, max: -80 },
      scale: { start: 0.18, end: 0 },
      speed: { min: 45, max: 75 },
      frequency: 70,
      quantity: 1,
      blendMode: 'ADD',
      advance: 1500,
      emitting: false,
    }) ?? null;
    this._heatCoolingFx?.setDepth?.(13);
    this._heatCoolingFx?.setVisible?.(false);

    this._drawStatusBars();
  }

  _drawStatusBars(timeMs = this._hudTimeMs) {
    const vals = {
      hp:     this._playerHp,
      heat:   this._weapons.heatShots,
    };
    for (const [key, { rect, max, fullW, color }] of Object.entries(this._barFills)) {
      rect.displayWidth = Math.max(0, Math.min(1, vals[key] / max)) * fullW;
      if (key === 'heat') {
        const style = resolveHeatBarStyle(vals[key], max, timeMs);
        if (rect.setFillStyle) rect.setFillStyle(style.color, style.alpha);
        rect.setAlpha(style.alpha);
        continue;
      }

      if (rect.setFillStyle) rect.setFillStyle(color, 1);
      rect.setAlpha(1);
    }

    this._syncHeatCoolingFx();
  }

  _syncHeatCoolingFx() {
    const heatBar = this._barFills?.heat;
    const fx = this._heatCoolingFx;
    const coolingActive = Boolean(this._weapons?.isCoolingDown);

    if (!heatBar || !fx || !coolingActive) {
      if (this._heatCoolingFxActive) fx.stop?.();
      this._heatCoolingFxActive = false;
      fx?.setVisible?.(false);
      return;
    }

    const edgeX = heatBar.x + Math.max(6, heatBar.rect.displayWidth - 2);
    const centerY = heatBar.y + heatBar.height / 2;
    fx.setPosition?.(edgeX, centerY);
    fx.setVisible?.(true);

    if (!this._heatCoolingFxActive) {
      fx.start?.();
      this._heatCoolingFxActive = true;
    }
  }

  _playPlayerShotFeedback(shotInfo = this._weapons?.lastShotInfo) {
    if (!shotInfo?.warningShot) return;

    const camera = this.cameras?.main;
    if (!camera?.shake) return;

    camera.shake(
      shotInfo.shotShakeMs,
      shotInfo.shotShakeIntensity,
      true
    );
  }

  _updateHeatWarningShake(timeMs = this._hudTimeMs) {
    const warningActive = isHeatWarningActive(
      this._weapons.heatShots,
      this._weapons.maxHeatShots
    );

    if (!warningActive) {
      this._stopHeatWarningShake();
      this._nextHeatWarningShakeAt = timeMs;
      return;
    }

    this._heatWarningActive = true;
    if (timeMs < this._nextHeatWarningShakeAt) return;

    const camera = this.cameras?.main;
    if (camera?.shake) {
      camera.shake(
        PLAYER_HEAT_WARNING_SHAKE_MS,
        PLAYER_HEAT_WARNING_SHAKE_INTENSITY,
        true
      );
    }

    this._nextHeatWarningShakeAt = timeMs + PLAYER_HEAT_WARNING_SHAKE_MS;
  }

  _stopHeatWarningShake() {
    if (!this._heatWarningActive) return;

    this._heatWarningActive = false;
    this._nextHeatWarningShakeAt = 0;
    const camera = this.cameras?.main;
    if (camera?.stopShake) camera.stopShake();
  }

  /**
   * Flash "LEVEL N" centered on screen for ~1 second, then fade out.
   * @param {number} levelNumber - 1-based level number
   */
  _showLevelBanner(levelNumber) {
    const text = this.add.text(WIDTH / 2, HEIGHT / 2, `LEVEL ${levelNumber}`, {
      fontSize: '36px', fill: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(30).setAlpha(0);

    this.tweens.add({
      targets:  text,
      alpha:    1,
      duration: 150,
      ease:     'Linear',
      onComplete: () => {
        this.time.delayedCall(1000, () => {
          this.tweens.add({
            targets:  text,
            alpha:    0,
            duration: 300,
            ease:     'Linear',
            onComplete: () => text.destroy(),
          });
        });
      },
    });
  }

  _buildWeaponDisplay() {
    const BOX_W = 62, BOX_H = 38, GAP = 6;
    const slots = this._weapons.getSlots();
    const X0    = WIDTH - 8 - slots.length * BOX_W - (slots.length - 1) * GAP;
    const Y0    = HEIGHT - BOX_H - 8;
    this._weaponDisplayX = X0;   // shared with _buildStatusBars
    this._weaponDisplayY = Y0;
    this._weaponDisplayGraphics = this.add.graphics();
    this._weaponSlotNumberTexts = [];
    this._weaponSlotNameTexts = [];
    this._weaponSlotMultiplierTexts = [];

    slots.forEach((slot, i) => {
      const x      = X0 + i * (BOX_W + GAP);
      const filled = slot !== null;
      const slotFill = filled ? '#aaaaaa' : '#333333';
      const nameFill = filled ? `#${slot.color.toString(16).padStart(6, '0')}` : '#2a2a2a';
      this._weaponSlotNumberTexts.push(this.add.text(x + 4, Y0 + 3, `${i + 1}`, {
        fontSize: '9px', fill: slotFill, fontFamily: 'monospace',
      }));
      this._weaponSlotNameTexts.push(this.add.text(x + BOX_W / 2, Y0 + BOX_H / 2 + 3, slot?.name ?? '----', {
        fontSize: '11px', fill: nameFill, fontFamily: 'monospace',
      }).setOrigin(0.5));
      this._weaponSlotMultiplierTexts.push(this.add.text(x + BOX_W - 4, Y0 + BOX_H - 3, slot?.multiplierLabel ?? '', {
        fontSize: '9px', fill: nameFill, fontFamily: 'monospace',
      }).setOrigin(1, 1));
    });

    this._drawWeaponDisplay();
  }

  _drawWeaponDisplay() {
    if (!this._weaponDisplayGraphics) return;

    const BOX_W = 62, BOX_H = 38, GAP = 6;
    const slots = this._weapons.getSlots();
    const X0 = this._weaponDisplayX;
    const Y0 = this._weaponDisplayY;
    this._weaponDisplayGraphics.clear();

    slots.forEach((slot, i) => {
      const x      = X0 + i * (BOX_W + GAP);
      const filled = slot !== null;
      const border = filled ? slot.color : 0x2a2a2a;
      const bg     = filled ? 0x001428  : 0x080808;
      const slotFill = filled ? '#aaaaaa' : '#333333';
      const nameFill = filled ? `#${slot.color.toString(16).padStart(6, '0')}` : '#2a2a2a';

      this._weaponDisplayGraphics.fillStyle(bg, 1);
      this._weaponDisplayGraphics.fillRect(x, Y0, BOX_W, BOX_H);
      this._weaponDisplayGraphics.lineStyle(1, border, 1);
      this._weaponDisplayGraphics.strokeRect(x, Y0, BOX_W, BOX_H);

      const slotText = this._weaponSlotNumberTexts?.[i];
      slotText?.setText?.(`${i + 1}`);
      slotText?.setStyle?.({ fill: slotFill, fontFamily: 'monospace', fontSize: '9px' });

      const nameText = this._weaponSlotNameTexts?.[i];
      nameText?.setText?.(filled ? slot.name : '----');
      nameText?.setStyle?.({ fill: nameFill, fontFamily: 'monospace', fontSize: '11px' });

      const multiplierText = this._weaponSlotMultiplierTexts?.[i];
      multiplierText?.setText?.(filled ? (slot.multiplierLabel ?? '') : '');
      multiplierText?.setStyle?.({ fill: nameFill, fontFamily: 'monospace', fontSize: '9px' });
    });
  }

  _buildHUD() {
    this._scoreText = this.add.text(WIDTH - 8, 8, 'SCORE  0', {
      fontSize: '12px', fill: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(1, 0).setDepth(10);

    this.add.image(14, 17, 'spacecraft1')
      .setDisplaySize?.(11, 10)
      .setDepth(10);
    this._livesText = this.add.text(24, 9, `× ${this._playerLives}`, {
      fontSize: '12px', fill: '#ffffff', fontFamily: 'monospace',
    }).setDepth(10);
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  _explodeForType(x, y, type, vx, vy) {
    this._effects.explodeForType(x, y, type, vx, vy, this._enemies, this._eBullets);
  }

  /** Player explosion — barrel blast with camera flash. */
  _explode(x, y) {
    this.cameras.main.flash(260, 255, 255, 255, true);
    this._effects.explodePlayer(x, y);
  }
}
