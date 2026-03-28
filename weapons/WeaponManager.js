/** @module WeaponManager
 * Manages the player's 2 weapon slots.
 * Slot 0 starts loaded with the laser; slot 1 starts empty.
 * Owns the bullet pool for each equipped weapon. */

import { GAME_CONFIG } from '../config/game.config.js';
import { WEAPONS }     from '../config/weapons.config.js';

const PLAYER_LASER_SPAWN_Y_OFFSET = 18;
const DEFAULT_PRIMARY_WEAPON = 'laser';
const LASER_COOLING_SFX_KEY = 'laserCooling';
const MAX_PLAYER_BULLET_POOL_SIZE = Math.max(
  ...Object.values(WEAPONS).map(config => config.poolSize ?? 0)
);

export class WeaponManager {
  /**
   * @param {Phaser.Scene} scene
   */
  constructor(scene) {
    this._scene = scene;

    /** @type {Array<string|null>} weapon key per slot, null = empty */
    this._slots = Array(GAME_CONFIG.WEAPON_SLOTS).fill(null);
    this._slots[0] = DEFAULT_PRIMARY_WEAPON;

    this._cooldown = 0;
    this._cfg      = WEAPONS[this._slots[0]];
    this._heatShots = 0;
    this._isOverheated = false;
    this._maxHeatShots = GAME_CONFIG.PLAYER_HEAT_MAX;
    this._baseHeatRecoveryStepMs = GAME_CONFIG.PLAYER_HEAT_RECOVERY_MS;
    this._heatRecoveryStepMs = this._baseHeatRecoveryStepMs;
    this._overheatRecoveryShots = GAME_CONFIG.PLAYER_OVERHEAT_RECOVERY_SHOTS;
    this._heatWarningRatio = GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO;
    this._heatWarningBonusPerShot = GAME_CONFIG.PLAYER_HEAT_WARNING_BONUS_PER_SHOT;
    this._heatWarningShotShakeMs = GAME_CONFIG.PLAYER_HEAT_WARNING_SHOT_SHAKE_MS;
    this._heatWarningShotShakeMsStep = GAME_CONFIG.PLAYER_HEAT_WARNING_SHOT_SHAKE_MS_STEP;
    this._heatWarningShotShakeIntensity = GAME_CONFIG.PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY;
    this._heatWarningShotShakeIntensityStep = GAME_CONFIG.PLAYER_HEAT_WARNING_SHOT_SHAKE_INTENSITY_STEP;
    this._primaryDamageMultiplier = 1;
    this._laserTextureKey = 'bullet_laser';
    this._lastShotInfo = null;
    this._coolingSoundActive = false;
    this._coolingSound = null;

    this._pool = scene.physics.add.group({
      classType:      Phaser.Physics.Arcade.Image,
      defaultKey:     'bullet_laser',
      maxSize:        MAX_PLAYER_BULLET_POOL_SIZE,
      runChildUpdate: false,
      allowGravity:   false,
    });
  }

  /** The bullet group — used by CollisionSystem to register overlaps. */
  get pool() { return this._pool; }

  /** Damage dealt per bullet by the currently active weapon. */
  get damage() { return Math.round(this._cfg.damage * this._primaryDamageMultiplier); }

  /** Snapshot of the most recent shot fired this frame. */
  get lastShotInfo() { return this._lastShotInfo; }

  /** Current heat measured in shots. Can be fractional while cooling. */
  get heatShots() { return this._heatShots; }

  /** Heat capacity measured in shots. */
  get maxHeatShots() { return this._maxHeatShots; }

  /** True while the weapon is hard-locked by overheat. */
  get isOverheated() { return this._isOverheated; }

  /** Current player bonus multiplier applied to slot 1 damage. */
  get primaryDamageMultiplier() { return this._primaryDamageMultiplier; }

  /** Current heat recovery step in milliseconds per recovered heat shot. */
  get heatRecoveryStepMs() { return this._heatRecoveryStepMs; }

  /** Current slot 1 weapon key. */
  get primaryWeaponKey() { return this._slots[0]; }

  /** True while slot 1 is locked by overheat and still cooling back down. */
  get isCoolingDown() {
    return Boolean(this._slots[0]) && this._isOverheated;
  }

  /** Heat level below which firing is allowed again after overheat. */
  get unlockHeatShots() {
    return Math.max(0, this._maxHeatShots - this._overheatRecoveryShots);
  }

  /**
   * Clear the current heat state without changing the equipped weapons.
   * Used when the player loses a life.
   */
  resetHeat() {
    this._heatShots = 0;
    this._isOverheated = false;
    this._lastShotInfo = null;
    this._stopCoolingSound();
  }

  /**
   * Temporarily override the heat recovery timing.
   * @param {number} recoveryMs
   * @returns {number}
   */
  setHeatRecoveryStepMs(recoveryMs) {
    this._heatRecoveryStepMs = Math.max(1, recoveryMs ?? this._baseHeatRecoveryStepMs);
    return this._heatRecoveryStepMs;
  }

  /**
   * Restore the default heat recovery timing from config.
   * @returns {number}
   */
  resetHeatRecoveryStepMs() {
    this._heatRecoveryStepMs = this._baseHeatRecoveryStepMs;
    return this._heatRecoveryStepMs;
  }

  /**
   * Multiply the current slot 1 damage bonus.
   * @param {number} factor
   * @returns {number}
   */
  multiplyPrimaryDamage(factor = 1) {
    this._primaryDamageMultiplier = Math.max(1, this._primaryDamageMultiplier * Math.max(1, factor));
    return this._primaryDamageMultiplier;
  }

  /**
   * Clear all stackable slot 1 power bonuses.
   * @returns {number}
   */
  resetPrimaryDamageMultiplier() {
    this._primaryDamageMultiplier = 1;
    return this._primaryDamageMultiplier;
  }

  /**
   * Reset slot 1 back to the default laser and clear live player shots.
   * @returns {string}
   */
  resetPrimaryWeapon() {
    this._slots[0] = DEFAULT_PRIMARY_WEAPON;
    this._cfg = WEAPONS[this._slots[0]];
    this._stopCoolingSound();

    for (const bullet of this._pool.getChildren()) {
      if (bullet?.active) this._releaseBullet(bullet);
    }

    return this._slots[0];
  }

  /**
   * Equip a new weapon into slot 1.
   * @param {string} weaponKey
   * @returns {string}
   */
  equipPrimaryWeapon(weaponKey) {
    const config = WEAPONS[weaponKey];
    if (!config) throw new Error(`WeaponManager: unknown primary weapon "${weaponKey}"`);
    this._slots[0] = weaponKey;
    this._cfg = config;
    return weaponKey;
  }

  /**
   * Returns a snapshot of all slots for UI rendering.
   * Populated slots return `{ key, name, color }`; empty slots return `null`.
   * @returns {Array<{key: string, name: string, color: number}|null>}
   */
  getSlots() {
    return this._slots.map((key, index) => {
      if (!key) return null;
      return {
        key,
        name: WEAPONS[key].name ?? key.toUpperCase(),
        color: WEAPONS[key].color,
        multiplierLabel: index === 0 && this._primaryDamageMultiplier > 1
          ? `x${this._primaryDamageMultiplier}`
          : '',
      };
    });
  }

  /**
   * Lightweight state snapshot used by the enemy learning system.
   * @returns {{primaryWeaponKey: string|null, heatRatio: number, isOverheated: boolean, primaryDamageMultiplier: number}}
   */
  getLearningSnapshot() {
    return {
      primaryWeaponKey: this.primaryWeaponKey ?? null,
      heatRatio: this._maxHeatShots > 0 ? this._heatShots / this._maxHeatShots : 0,
      isOverheated: this._isOverheated,
      primaryDamageMultiplier: this._primaryDamageMultiplier,
    };
  }

  /**
   * Tick cooldown and recycle bullets that have left the canvas.
   * Call once per frame before tryFire.
   * @param {number} delta - ms since last frame
   * @param {boolean} [wantsToFire=false] - whether the trigger is being held
   */
  update(delta, wantsToFire = false) {
    this._cooldown = Math.max(0, this._cooldown - delta);

    const canRecoverHeat = !wantsToFire || this._isOverheated || !this._slots[0];
    if (canRecoverHeat && this._heatShots > 0) {
      this._heatShots = Math.max(0, this._heatShots - (delta / this._heatRecoveryStepMs));
      if (this._heatShots < 1e-6) this._heatShots = 0;
    }

    if (this._isOverheated && this._heatShots <= this.unlockHeatShots + 1e-6) {
      this._isOverheated = false;
    }
    this._syncCoolingSound(this.isCoolingDown);

    for (const b of this._pool.getChildren()) {
      if (b.active && (
        b.y < -20
        || b.y > GAME_CONFIG.HEIGHT + 20
        || b.x < -20
        || b.x > GAME_CONFIG.WIDTH + 20
      )) {
        this._pool.killAndHide(b);
        b.body.stop?.();
        b.body.enable = false;
      }
    }
  }

  /**
   * Fire slot 0's weapon from (x, y) if the cooldown has elapsed.
   * Safe to call every frame while the fire key is held.
   * @param {number} x
   * @param {number} y
   * @returns {boolean} true when a shot is fired
   */
  tryFire(x, y) {
    this._lastShotInfo = null;
    if (this._cooldown > 0 || !this._slots[0] || this._isOverheated) return false;

    const nextHeatShots = Math.min(this._maxHeatShots, this._heatShots + 1);
    const warningShot = this._isHeatWarningActive(nextHeatShots);
    const warningStep = warningShot ? this._getHeatBonusStepCount(nextHeatShots) : 0;
    const scoreMultiplier = warningShot ? this._getHeatBonusMultiplier(nextHeatShots) : 1;
    const totalDamage = Math.round(this.damage * scoreMultiplier);
    const shotPayload = this._createShotPayload(totalDamage, scoreMultiplier, warningStep);

    const textureKey = (warningShot && this._cfg.warningTextureKey)
      ? this._cfg.warningTextureKey
      : this._laserTextureKey;
    if (!this._fireShotPattern(x, y, shotPayload, textureKey)) return false;

    this._cooldown = this._cfg.fireRate;
    this._heatShots = nextHeatShots;
    if (this._heatShots >= this._maxHeatShots) {
      this._heatShots = this._maxHeatShots;
      this._isOverheated = true;
    }

    if (this._cfg.sfxDefault) {
      this._scene.sound?.play(warningShot ? (this._cfg.sfxWarning ?? this._cfg.sfxDefault) : this._cfg.sfxDefault);
    }

    this._lastShotInfo = shotPayload;
    return true;
  }

  _fireShotPattern(x, y, shotPayload, textureKey) {
    const firedBullets = [];
    const shots = this._cfg.shots ?? [{ angle: 0, x: 0 }];

    for (const shot of shots) {
      const bullet = this._fireSingleBullet(
        x + (shot.x ?? 0),
        y + (shot.y ?? 0),
        shotPayload,
        textureKey,
        shot.angle ?? 0
      );
      if (!bullet) {
        for (const firedBullet of firedBullets) this._releaseBullet(firedBullet);
        return false;
      }
      firedBullets.push(bullet);
    }

    return true;
  }

  _createShotPayload(damage, scoreMultiplier = 1, warningStep = 0) {
    const warningShot = warningStep > 0;
    const extraSteps = Math.max(0, warningStep - 1);
    return {
      damage,
      hitEnemies: new Set(),
      scoreMultiplier,
      warningShot,
      shotShakeMs: warningShot
        ? this._heatWarningShotShakeMs + extraSteps * this._heatWarningShotShakeMsStep
        : 0,
      shotShakeIntensity: warningShot
        ? this._heatWarningShotShakeIntensity + extraSteps * this._heatWarningShotShakeIntensityStep
        : 0,
    };
  }

  _fireSingleBullet(x, y, shotPayload, textureKey = this._laserTextureKey, angleDeg = 0) {
    const bullet = this._pool.get(x, y - PLAYER_LASER_SPAWN_Y_OFFSET);
    if (!bullet) return null;
    this._armBullet(bullet, x, y, shotPayload, textureKey, angleDeg);
    return bullet;
  }

  _armBullet(bullet, x, y, shotPayload, textureKey = this._laserTextureKey, angleDeg = 0) {
    bullet.setActive(true).setVisible(true);
    if (bullet.setTexture) bullet.setTexture(textureKey);
    bullet.setScale(1, 1);
    this._setBulletRotation(bullet, angleDeg);
    bullet.body.reset(x, y - PLAYER_LASER_SPAWN_Y_OFFSET);
    bullet.body.enable = true;
    this._setBulletVelocity(bullet, angleDeg);
    bullet.body.allowGravity = false;
    bullet._damage = shotPayload.damage;
    bullet._scoreMultiplier = shotPayload.scoreMultiplier;
    bullet._shotPayload = shotPayload;
    bullet.body.updateFromGameObject?.();
  }

  _setBulletVelocity(bullet, angleDeg = 0) {
    const radians = angleDeg * (Math.PI / 180);
    const vx = Math.sin(radians) * this._cfg.speed;
    const vy = -Math.cos(radians) * this._cfg.speed;

    if (bullet.body.setVelocity) {
      bullet.body.setVelocity(vx, vy);
    } else {
      bullet.body.setVelocityX?.(vx);
      bullet.body.setVelocityY?.(vy);
    }
    if ('_vx' in bullet.body) bullet.body._vx = vx;
    if ('_vy' in bullet.body) bullet.body._vy = vy;
  }

  _setBulletRotation(bullet, angleDeg = 0) {
    const radians = angleDeg * (Math.PI / 180);
    if (bullet.setRotation) {
      bullet.setRotation(radians);
      return;
    }
    bullet.rotation = radians;
  }

  _releaseBullet(bullet) {
    if (!bullet) return;

    if (bullet.setTexture) bullet.setTexture(this._laserTextureKey);
    bullet.setScale?.(1, 1);
    this._setBulletRotation(bullet, 0);
    bullet._damage = this.damage;
    bullet._scoreMultiplier = 1;
    bullet._shotPayload = null;
    this._pool.killAndHide(bullet);
    if (bullet.body) {
      bullet.body.stop();
      bullet.body.enable = false;
    }
  }

  _isHeatWarningActive(heatShots = this._heatShots) {
    return this._maxHeatShots > 0 && (heatShots / this._maxHeatShots) >= this._heatWarningRatio;
  }

  _getHeatBonusStepCount(heatShots = this._heatShots) {
    if (!this._isHeatWarningActive(heatShots)) return 0;

    const warningStartHeat = Math.ceil(this._maxHeatShots * this._heatWarningRatio);
    return Math.max(1, Math.floor(heatShots) - warningStartHeat + 1);
  }

  _getHeatBonusMultiplier(heatShots = this._heatShots) {
    return 1 + this._getHeatBonusStepCount(heatShots) * this._heatWarningBonusPerShot;
  }

  _syncCoolingSound(shouldPlay) {
    if (shouldPlay) this._startCoolingSound();
    else this._stopCoolingSound();
  }

  _startCoolingSound() {
    if (this._coolingSoundActive) return;
    if (!this._scene.sound?.play) return;
    this._coolingSound = this._scene.sound.play(LASER_COOLING_SFX_KEY, { loop: true }) || null;
    if (this._coolingSound) this._coolingSoundActive = true;
  }

  _stopCoolingSound() {
    if (!this._coolingSoundActive) return;
    this._coolingSoundActive = false;
    if (this._coolingSound?.stop) {
      this._coolingSound.stop();
    } else {
      this._scene.sound?.stopByKey?.(LASER_COOLING_SFX_KEY);
    }
    this._coolingSound = null;
  }
}
