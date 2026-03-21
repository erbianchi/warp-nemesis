/** @module EffectsSystem
 * Handles explosion VFX and nearby shockwave impulses. */

const FRAGMENT_POOL_SIZE = 192;
const FRAGMENT_TEXTURE   = 'particle';
const FRAGMENT_BASE_SIZE = 4;
const FRAGMENT_GRAVITY_Y = 160;
const FRAGMENT_DRAG      = 40;
const FRAGMENT_DEPTH     = 15;
const PUSH_RADIUS        = 120;
const MAX_PUSH           = 280;
const DIRECTIONAL_SPEED_MIN = 40;
const DIRECTIONAL_SPEED_MAX = 320;
const TINTS = [0xff5500, 0xff6600, 0xff8800, 0xff9900, 0xffbb00, 0xffcc00, 0xffffff, 0xffee88];
const EXPLOSION_SOUND_KEYS = Object.freeze({
  skirm: 'explosionSkirm_000',
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp  = (a, b, t) => a + (b - a) * t;

/**
 * Resolve a movement profile for a dying ship so explosions can inherit momentum.
 * @param {number} vx
 * @param {number} vy
 * @returns {{speed: number, hasDir: boolean, motionFactor: number, dirX: number, dirY: number, dirRad: number}}
 */
export function resolveMotionProfile(vx = 0, vy = 0) {
  const speed = Math.sqrt(vx * vx + vy * vy);
  const hasDir = speed > DIRECTIONAL_SPEED_MIN;
  const motionFactor = clamp(
    (speed - DIRECTIONAL_SPEED_MIN) / (DIRECTIONAL_SPEED_MAX - DIRECTIONAL_SPEED_MIN),
    0,
    1
  );
  const dirX = hasDir && speed !== 0 ? vx / speed : 0;
  const dirY = hasDir && speed !== 0 ? vy / speed : 0;

  return {
    speed,
    hasDir,
    motionFactor,
    dirX,
    dirY,
    dirRad: hasDir ? Math.atan2(dirY, dirX) : 0,
  };
}

/**
 * Compose a fragment's world-space velocity from the ship's carried momentum
 * and the local blast vector.
 * @param {number} carrierVx
 * @param {number} carrierVy
 * @param {number} blastAngle
 * @param {number} blastSpeed
 * @returns {{vx: number, vy: number, inheritRatio: number}}
 */
export function composeFragmentVelocity(carrierVx, carrierVy, blastAngle, blastSpeed) {
  const { hasDir, motionFactor } = resolveMotionProfile(carrierVx, carrierVy);
  const inheritRatio = hasDir ? lerp(0.35, 0.85, motionFactor) : 0;

  return {
    vx: carrierVx * inheritRatio + Math.cos(blastAngle) * blastSpeed,
    vy: carrierVy * inheritRatio + Math.sin(blastAngle) * blastSpeed,
    inheritRatio,
  };
}

/**
 * Compute a shockwave push that grows forward and softens behind a fast-moving craft.
 * @param {number} originX
 * @param {number} originY
 * @param {number} targetX
 * @param {number} targetY
 * @param {number} carrierVx
 * @param {number} carrierVy
 * @returns {{vx: number, vy: number, alignment: number, effectiveRadius: number}|null}
 */
export function calcShockwavePush(originX, originY, targetX, targetY, carrierVx = 0, carrierVy = 0) {
  const dx   = targetX - originX;
  const dy   = targetY - originY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return null;

  const nx = dx / dist;
  const ny = dy / dist;
  const { speed, hasDir, motionFactor, dirX, dirY } = resolveMotionProfile(carrierVx, carrierVy);
  const alignment = hasDir ? nx * dirX + ny * dirY : 0;
  const radiusScale = hasDir
    ? clamp(1 + alignment * 0.4 * motionFactor, 0.7, 1.4)
    : 1;
  const effectiveRadius = PUSH_RADIUS * radiusScale;

  if (dist >= effectiveRadius) return null;

  const forceScale = hasDir
    ? clamp(1 + alignment * 0.3 * motionFactor, 0.75, 1.35)
    : 1;
  const falloff = 1 - dist / effectiveRadius;
  const carry = hasDir ? speed * 0.18 * motionFactor * falloff : 0;
  const force = MAX_PUSH * falloff * forceScale;

  return {
    vx: nx * force + dirX * carry,
    vy: ny * force + dirY * carry,
    alignment,
    effectiveRadius,
  };
}

/**
 * Resolve the non-random explosion envelope for a ship.
 * Small per-fragment jitter is applied around this profile at spawn time.
 * @param {number} vx
 * @param {number} vy
 * @returns {{motion: ReturnType<typeof resolveMotionProfile>, spreadRad: number, launchSpeed: number, count: number, fragmentSize: number, fragmentLife: number}}
 */
export function resolveExplosionProfile(vx = 0, vy = 0) {
  const motion = resolveMotionProfile(vx, vy);

  return {
    motion,
    spreadRad: motion.hasDir ? lerp(1.9, 0.55, motion.motionFactor) : Math.PI,
    launchSpeed: clamp(140 + motion.speed * 0.25, 140, 300),
    count: Math.round(clamp(18 + motion.speed / 10, 18, 42)),
    fragmentSize: 3 + motion.motionFactor * 1.4,
    fragmentLife: Math.round(470 + motion.motionFactor * 110),
  };
}

export class EffectsSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} [opts]
   * @param {number} [opts.fragmentPoolSize]
   */
  constructor(scene, opts = {}) {
    this._scene = scene;
    this._fragmentPoolSize = opts.fragmentPoolSize ?? FRAGMENT_POOL_SIZE;
    this._fragmentPool = scene.physics.add.group({
      classType:      Phaser.Physics.Arcade.Image,
      defaultKey:     FRAGMENT_TEXTURE,
      maxSize:        this._fragmentPoolSize,
      runChildUpdate: false,
    });

    if (typeof this._fragmentPool.createMultiple === 'function') {
      this._fragmentPool.createMultiple({
        key:      FRAGMENT_TEXTURE,
        quantity: this._fragmentPoolSize,
        active:   false,
        visible:  false,
      });
    }

    for (const frag of this._fragmentPool.getChildren()) {
      this._resetFragment(frag);
    }
  }

  /**
   * Spawn an explosion for the given enemy type and push nearby objects.
   * @param {number} x
   * @param {number} y
   * @param {string} type
   * @param {number} vx
   * @param {number} vy
   * @param {Array<object>} enemies
   * @param {Array<object>} enemyBullets
   * @param {{playSound?: boolean}} [opts]
   */
  explodeForType(x, y, type, vx = 0, vy = 0, enemies = [], enemyBullets = [], opts = {}) {
    if (opts.playSound !== false) this._playExplosionSound(type);

    switch (type) {
      case 'skirm':
      default:
        this._explodeSkirm(x, y, vx, vy, enemies, enemyBullets);
        break;
    }
  }

  /**
   * Play the configured explosion sound for an enemy category.
   * @param {string} type
   */
  _playExplosionSound(type) {
    const soundKey = EXPLOSION_SOUND_KEYS[type];
    if (!soundKey) return;
    this._scene.sound?.play(soundKey);
  }

  /**
   * Skirm explosion — pooled particle fragments with a radial shockwave.
   * The blast direction follows the dead ship's travel vector.
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   * @param {Array<object>} enemies
   * @param {Array<object>} enemyBullets
   */
  _explodeSkirm(x, y, vx, vy, enemies, enemyBullets) {
    const profile = resolveExplosionProfile(vx, vy);

    for (let i = 0; i < profile.count; i++) {
      const angle = profile.motion.hasDir
        ? profile.motion.dirRad + Phaser.Math.FloatBetween(-profile.spreadRad, profile.spreadRad)
        : Phaser.Math.FloatBetween(-Math.PI, Math.PI);
      const mag   = Phaser.Math.FloatBetween(profile.launchSpeed * 0.82, profile.launchSpeed);
      const fragVel = composeFragmentVelocity(vx, vy, angle, mag);
      const size  = profile.fragmentSize * Phaser.Math.FloatBetween(0.85, 1.15);
      const life  = Math.round(profile.fragmentLife * Phaser.Math.FloatBetween(0.92, 1.06));
      const tint  = TINTS[Phaser.Math.Between(0, TINTS.length - 1)];

      this._spawnFragment(
        x,
        y,
        fragVel.vx,
        fragVel.vy,
        size,
        tint,
        life
      );
    }

    this._applyShockwave(x, y, vx, vy, enemies, enemyBullets);
  }

  /**
   * Spawn or reuse one pooled fragment.
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   * @param {number} size
   * @param {number} tint
   * @param {number} life
   */
  _spawnFragment(x, y, vx, vy, size, tint, life) {
    const frag = this._fragmentPool.get(x, y, FRAGMENT_TEXTURE);
    if (!frag) return;

    if (typeof this._scene.tweens.killTweensOf === 'function') {
      this._scene.tweens.killTweensOf(frag);
    }

    frag.setActive(true).setVisible(true).setDepth(FRAGMENT_DEPTH).setAlpha(1);
    if (typeof frag.setTint === 'function') frag.setTint(tint);
    if (typeof frag.setScale === 'function') frag.setScale(size / FRAGMENT_BASE_SIZE);

    if (frag.body && typeof frag.body.reset === 'function') frag.body.reset(x, y);
    frag.body.enable = true;
    frag.body.allowGravity = true;
    if (typeof frag.body.setVelocity === 'function') frag.body.setVelocity(vx, vy);
    if (typeof frag.body.setGravityY === 'function') frag.body.setGravityY(FRAGMENT_GRAVITY_Y);
    if (typeof frag.body.setDrag === 'function') frag.body.setDrag(FRAGMENT_DRAG);
    if (typeof frag.body.setCollideWorldBounds === 'function') frag.body.setCollideWorldBounds(false);

    this._scene.tweens.add({
      targets:    frag,
      alpha:      0,
      duration:   life,
      ease:       'Power2',
      onComplete: () => this._resetFragment(frag),
    });
  }

  /**
   * Recycle a pooled fragment to its dormant state.
   * @param {object} frag
   */
  _resetFragment(frag) {
    if (typeof this._fragmentPool.killAndHide === 'function') {
      this._fragmentPool.killAndHide(frag);
    } else {
      frag.setActive(false).setVisible(false);
    }

    frag.setAlpha(1);
    if (typeof frag.clearTint === 'function') frag.clearTint();
    if (typeof frag.setScale === 'function') frag.setScale(1);

    if (frag.body) {
      if (typeof frag.body.stop === 'function') frag.body.stop();
      frag.body.enable = false;
      frag.body.allowGravity = false;
      if (typeof frag.body.setGravityY === 'function') frag.body.setGravityY(0);
      if (typeof frag.body.setDrag === 'function') frag.body.setDrag(0);
    }
  }

  /**
   * Apply an outward push to nearby enemies and enemy bullets.
   * Enemy bullets only get lateral motion because their vertical travel is tween-driven.
   * @param {number} x
   * @param {number} y
   * @param {Array<object>} enemies
   * @param {Array<object>} enemyBullets
   */
  _applyShockwave(x, y, vx, vy, enemies, enemyBullets) {
    for (const enemy of enemies) {
      if (!enemy?.alive || typeof enemy.applyPush !== 'function') continue;
      const push = calcShockwavePush(x, y, enemy.x, enemy.y, vx, vy);
      if (push) enemy.applyPush(push.vx, push.vy);
    }

    for (const bullet of enemyBullets) {
      if (!bullet?.active) continue;
      const push = calcShockwavePush(x, y, bullet.x, bullet.y, vx, vy);
      if (push) bullet._pushVx = (bullet._pushVx ?? 0) + push.vx;
    }
  }
}
