/** @module EffectsSystem
 * Handles explosion VFX and nearby shockwave impulses. */

const FRAGMENT_POOL_SIZE = 192;
const FRAGMENT_TEXTURE   = 'particle';
const FRAGMENT_BASE_SIZE = 4;
const FRAGMENT_GRAVITY_Y = 160;
const FRAGMENT_DRAG      = 40;
const FRAGMENT_DEPTH     = 15;
const DAMAGE_TEXT_DEPTH  = 18;
const GRAVITY_WELL_DEPTH = 14;
const PUSH_RADIUS        = 120;
const MAX_PUSH           = 280;
const DIRECTIONAL_SPEED_MIN = 40;
const DIRECTIONAL_SPEED_MAX = 320;
const SKIRM_TINTS = [0xff5500, 0xff6600, 0xff8800, 0xff9900, 0xffbb00, 0xffcc00, 0xffffff, 0xffee88];
const RAPTOR_TINTS = [0x4ab8ff, 0x7fd5ff, 0xa3ecff, 0xffffff, 0xffdd88];
const MINE_TINTS = [0xfff4c2, 0xffdd88, 0xffaa33, 0xff7a18, 0xff4400, 0xffffff];
const DEFAULT_EXPLOSION_SOUND_KEY = 'explosionSkirm_000';
const EXPLOSION_SOUND_KEYS = Object.freeze({
  default: DEFAULT_EXPLOSION_SOUND_KEY,
  skirm: DEFAULT_EXPLOSION_SOUND_KEY,
  raptor: DEFAULT_EXPLOSION_SOUND_KEY,
  mine: DEFAULT_EXPLOSION_SOUND_KEY,
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
 * @param {{radius?: number, maxPush?: number, carryRatio?: number}} [opts]
 * @returns {{vx: number, vy: number, alignment: number, effectiveRadius: number}|null}
 */
export function calcShockwavePush(originX, originY, targetX, targetY, carrierVx = 0, carrierVy = 0, opts = {}) {
  const dx   = targetX - originX;
  const dy   = targetY - originY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return null;

  const nx = dx / dist;
  const ny = dy / dist;
  const { speed, hasDir, motionFactor, dirX, dirY } = resolveMotionProfile(carrierVx, carrierVy);
  const baseRadius = opts.radius ?? PUSH_RADIUS;
  const maxPush = opts.maxPush ?? MAX_PUSH;
  const carryRatio = opts.carryRatio ?? 0.18;
  const alignment = hasDir ? nx * dirX + ny * dirY : 0;
  const radiusScale = hasDir
    ? clamp(1 + alignment * 0.4 * motionFactor, 0.7, 1.4)
    : 1;
  const effectiveRadius = baseRadius * radiusScale;

  if (dist >= effectiveRadius) return null;

  const forceScale = hasDir
    ? clamp(1 + alignment * 0.3 * motionFactor, 0.75, 1.35)
    : 1;
  const falloff = 1 - dist / effectiveRadius;
  const carry = hasDir ? speed * carryRatio * motionFactor * falloff : 0;
  const force = maxPush * falloff * forceScale;

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

/**
 * Resolve the generic explosion spec for an enemy type.
 * Each type can express a different debris pattern while still flowing through
 * the same explosion executor and nearby disruption-wave logic.
 * @param {string} type
 * @param {number} [vx=0]
 * @param {number} [vy=0]
 * @returns {{waves: Array<object>, disruption: {radius: number, maxPush: number, carryRatio?: number}}}
 */
export function resolveEnemyExplosionSpec(type, vx = 0, vy = 0) {
  switch (type) {
    case 'mine':
      return resolveMineExplosionSpec();
    case 'raptor':
      return resolveRaptorExplosionSpec(vx, vy);
    case 'skirm':
    default:
      return resolveSkirmExplosionSpec(vx, vy);
  }
}

function resolveSkirmExplosionSpec(vx = 0, vy = 0) {
  const profile = resolveExplosionProfile(vx, vy);
  return {
    waves: [
      {
        shape: 'directional',
        countMin: profile.count,
        countMax: profile.count,
        spreadRad: profile.spreadRad,
        speedMin: profile.launchSpeed * 0.82,
        speedMax: profile.launchSpeed,
        sizeMin: profile.fragmentSize * 0.85,
        sizeMax: profile.fragmentSize * 1.15,
        lifeMin: Math.round(profile.fragmentLife * 0.92),
        lifeMax: Math.round(profile.fragmentLife * 1.06),
        tints: SKIRM_TINTS,
        inheritCarrierScale: 1,
      },
    ],
    disruption: {
      radius: PUSH_RADIUS,
      maxPush: MAX_PUSH,
    },
  };
}

function resolveMineExplosionSpec() {
  return {
    waves: [
      {
        shape: 'radial',
        countMin: 18,
        countMax: 26,
        speedMin: 170,
        speedMax: 310,
        sizeMin: 4.8,
        sizeMax: 8.2,
        lifeMin: 420,
        lifeMax: 700,
        tints: MINE_TINTS,
        inheritCarrierScale: 0.3,
      },
      {
        shape: 'radial',
        countMin: 10,
        countMax: 16,
        speedMin: 40,
        speedMax: 130,
        sizeMin: 7.5,
        sizeMax: 12.5,
        lifeMin: 520,
        lifeMax: 900,
        tints: MINE_TINTS,
        inheritCarrierScale: 0,
      },
    ],
    disruption: {
      radius: 136,
      maxPush: Math.round(MAX_PUSH * 1.12),
      carryRatio: 0.14,
    },
  };
}

function resolveRaptorExplosionSpec(vx = 0, vy = 0) {
  const motion = resolveMotionProfile(vx, vy);
  const speedBase = clamp(180 + motion.speed * 0.22, 180, 340);

  return {
    waves: [
      {
        shape: 'directional',
        countMin: Math.round(clamp(24 + motion.speed / 9, 24, 46)),
        countMax: Math.round(clamp(28 + motion.speed / 8, 28, 50)),
        spreadRad: motion.hasDir ? lerp(2.4, 0.95, motion.motionFactor) : Math.PI,
        speedMin: speedBase * 0.78,
        speedMax: speedBase * 1.06,
        sizeMin: 4.5,
        sizeMax: 7.8,
        lifeMin: 440,
        lifeMax: 760,
        tints: RAPTOR_TINTS,
        inheritCarrierScale: 1,
      },
      {
        shape: 'radial',
        countMin: 12,
        countMax: 18,
        speedMin: 60,
        speedMax: 170,
        sizeMin: 6.4,
        sizeMax: 11.4,
        lifeMin: 560,
        lifeMax: 920,
        tints: RAPTOR_TINTS,
        inheritCarrierScale: 0.25,
      },
    ],
    disruption: {
      radius: 148,
      maxPush: Math.round(MAX_PUSH * 1.18),
      carryRatio: 0.22,
    },
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
   * Player ship barrel-blast explosion — three concentric fragment waves with
   * randomised counts, speeds, sizes, and tints so each death looks different.
   * @param {number} x
   * @param {number} y
   */
  explodePlayer(x, y) {
    // Per-explosion random scale keeps the overall feel consistent while varying details.
    const speedScale = Phaser.Math.FloatBetween(0.85, 1.25);

    // Wave 1 — fast outer ring: ship-colour (green/white) splinters
    const outerCount = Phaser.Math.Between(18, 28);
    for (let i = 0; i < outerCount; i++) {
      const angle = Phaser.Math.FloatBetween(-Math.PI, Math.PI);
      const spd   = Phaser.Math.FloatBetween(310, 520) * speedScale;
      const size  = Phaser.Math.FloatBetween(2.5, 5.5);
      const life  = Phaser.Math.Between(320, 560);
      const tint  = [0x00ff88, 0x88ffcc, 0xffffff, 0x00ffcc][Phaser.Math.Between(0, 3)];
      this._spawnFragment(x, y, Math.cos(angle) * spd, Math.sin(angle) * spd, size, tint, life);
    }

    // Wave 2 — medium shrapnel: fire colours
    const midCount = Phaser.Math.Between(22, 34);
    for (let i = 0; i < midCount; i++) {
      const angle = Phaser.Math.FloatBetween(-Math.PI, Math.PI);
      const spd   = Phaser.Math.FloatBetween(120, 280) * speedScale;
      const size  = Phaser.Math.FloatBetween(4, 9);
      const life  = Phaser.Math.Between(460, 740);
      const tint  = [0xff6600, 0xff8800, 0xffcc00, 0xff3300, 0xffaa00][Phaser.Math.Between(0, 4)];
      this._spawnFragment(x, y, Math.cos(angle) * spd, Math.sin(angle) * spd, size, tint, life);
    }

    // Wave 3 — slow glowing embers that linger
    const innerCount = Phaser.Math.Between(10, 18);
    for (let i = 0; i < innerCount; i++) {
      const angle = Phaser.Math.FloatBetween(-Math.PI, Math.PI);
      const spd   = Phaser.Math.FloatBetween(20, 100) * speedScale;
      const size  = Phaser.Math.FloatBetween(5, 12);
      const life  = Phaser.Math.Between(580, 980);
      const tint  = [0xff2200, 0xff4400, 0xff6600, 0xffcc44][Phaser.Math.Between(0, 3)];
      this._spawnFragment(x, y, Math.cos(angle) * spd, Math.sin(angle) * spd, size, tint, life);
    }
  }

  /**
   * Shield break burst — bright blue-white fireworks that pop outward from the shell.
   * @param {number} x
   * @param {number} y
   * @param {number} [radius=20]
   */
  explodeShield(x, y, radius = 20) {
    const emitter = this._scene.add?.particles?.(0, 0, FRAGMENT_TEXTURE, {
      speed:    { min: radius * 6, max: radius * 12 },
      lifespan: { min: 260, max: 520 },
      scale:    { start: 1.4, end: 0 },
      alpha:    { start: 1, end: 0 },
      quantity: Math.max(12, Math.round(radius * 0.9)),
      tint:     [0xd6f0ff, 0x9fdbff, 0x63bbff, 0x2e86ff, 0x1458ff],
      blendMode: 'ADD',
      emitting: false,
    });

    if (!emitter) return;

    emitter.setDepth?.(FRAGMENT_DEPTH + 1);
    emitter.explode?.(Math.max(12, Math.round(radius * 0.9)), x, y);
    this._scene.time?.delayedCall?.(540, () => emitter.destroy?.());
  }

  /**
   * Floating damage number that rises and fades out.
   * @param {number} x
   * @param {number} y
   * @param {number|string} amount
   * @param {object} [opts]
   * @param {string} [opts.color='#bfe8ff']
   * @param {string} [opts.fontSize='14px']
   * @param {string} [opts.stroke='#001426']
   * @param {number} [opts.strokeThickness=3]
   * @param {number} [opts.glowColor=0xbfe8ff]
   * @param {number} [opts.glowStrength=4]
   * @param {number} [opts.lift=18]
   * @param {number} [opts.duration=320]
   * @param {number} [opts.scaleTo=1.12]
   */
  showDamageNumber(x, y, amount, opts = {}) {
    const value = typeof amount === 'number'
      ? `${Math.round(amount)}`
      : `${amount ?? ''}`;
    const lift = opts.lift ?? 18;
    const duration = opts.duration ?? 320;
    const scaleTo = opts.scaleTo ?? 1.12;
    const text = this._scene.add?.text?.(x, y, value, {
      fontSize: opts.fontSize ?? '14px',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      color: opts.color ?? '#bfe8ff',
      stroke: opts.stroke ?? '#001426',
      strokeThickness: opts.strokeThickness ?? 3,
    });

    if (!text) return null;

    text.setOrigin?.(0.5);
    text.setDepth?.(DAMAGE_TEXT_DEPTH);
    text.setAlpha?.(1);
    text.setScale?.(1, 1);

    const fx = text.preFX ?? text.postFX;
    fx?.addGlow?.(opts.glowColor ?? 0xbfe8ff, opts.glowStrength ?? 4, 0, false, 0.12, 12);

    this._scene.tweens?.add?.({
      targets:  text,
      y:        y - lift,
      alpha:    0,
      scaleX:   scaleTo,
      scaleY:   scaleTo,
      duration,
      ease:     'Cubic.easeOut',
      onComplete: () => text.destroy?.(),
    });

    return text;
  }

  /**
   * Create a particle gravity-well effect tied to a source, and pull the target toward it.
   * Uses Phaser 3.85's particle-emitter `createGravityWell` helper for the visual field.
   * @param {object} source
   * @param {object} target
   * @param {object} [opts]
   * @returns {{emitter: object|null, gravityWell: object|null, update: Function, destroy: Function}}
   */
  createGravityWell(source, target, opts = {}) {
    const radius = opts.radius ?? 48;
    const pullRadius = opts.pullRadius ?? Math.max(radius * 2.8, 140);
    const pullStrength = opts.pullStrength ?? 420;
    const scene = this._scene;
    const zone = typeof Phaser !== 'undefined' && Phaser.Geom?.Circle
      ? new Phaser.Geom.Circle(source?.x ?? 0, source?.y ?? 0, radius)
      : { x: source?.x ?? 0, y: source?.y ?? 0, radius };
    const emitter = scene.add?.particles?.(source?.x ?? 0, source?.y ?? 0, 'flares', {
      frame: 'white',
      color: [0x1b3dff, 0x49a3ff, 0xbfe8ff, 0xffffff],
      lifespan: 820,
      scale: { start: 0.12, end: 0 },
      speed: { min: 8, max: 22 },
      quantity: 1,
      frequency: 55,
      blendMode: 'ADD',
      alpha: { start: 0.55, end: 0 },
      emitting: false,
    }) ?? null;

    emitter?.addEmitZone?.({ type: 'random', source: zone });
    const gravityWell = emitter?.createGravityWell?.({
      x: source?.x ?? 0,
      y: source?.y ?? 0,
      power: opts.power ?? 4.2,
      epsilon: opts.epsilon ?? 250,
      gravity: opts.gravity ?? 100,
    }) ?? null;

    emitter?.setDepth?.(GRAVITY_WELL_DEPTH);

    let clock = 0;
    let emitting = false;

    const controller = {
      emitter,
      gravityWell,
      update: (delta = 16) => {
        clock += delta;
        const active = source?.active !== false && source?.visible !== false;
        if (!active) {
          if (emitting) emitter?.stop?.();
          emitting = false;
          emitter?.setVisible?.(false);
          return;
        }

        if (zone) {
          zone.x = source?.x ?? 0;
          zone.y = source?.y ?? 0;
        }
        if (gravityWell) {
          gravityWell.x = source?.x ?? 0;
          gravityWell.y = source?.y ?? 0;
        }

        emitter?.setPosition?.(source?.x ?? 0, source?.y ?? 0);
        emitter?.setVisible?.(true);
        emitter?.setAlpha?.(0.58 + Math.sin(clock / 260) * 0.12);
        if (!emitting) {
          emitter?.start?.();
          emitting = true;
        }

        this._applyGravityPull(source, target, pullRadius, pullStrength, delta);
      },
      destroy: () => {
        if (emitting) emitter?.stop?.();
        emitting = false;
        emitter?.destroy?.();
      },
    };

    return controller;
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
    const spec = resolveEnemyExplosionSpec(type, vx, vy);
    this._explodeWithSpec(x, y, vx, vy, enemies, enemyBullets, spec);
  }

  /**
   * Play the configured explosion sound for an enemy category.
   * @param {string} type
   */
  _playExplosionSound(type) {
    const soundKey = EXPLOSION_SOUND_KEYS[type] ?? EXPLOSION_SOUND_KEYS.default;
    if (!soundKey) return;
    this._scene.sound?.play(soundKey);
  }

  /**
   * Execute a resolved enemy blast spec.
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   * @param {Array<object>} enemies
   * @param {Array<object>} enemyBullets
   * @param {{waves: Array<object>, disruption: {radius: number, maxPush: number, carryRatio?: number}}} spec
   */
  _explodeWithSpec(x, y, vx, vy, enemies, enemyBullets, spec) {
    for (const wave of spec?.waves ?? []) {
      this._spawnExplosionWave(x, y, vx, vy, wave);
    }

    this._applyShockwave(x, y, vx, vy, enemies, enemyBullets, spec?.disruption);
  }

  /**
   * Spawn one explosion debris wave from a resolved spec.
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   * @param {object} wave
   */
  _spawnExplosionWave(x, y, vx, vy, wave) {
    const motion = resolveMotionProfile(vx, vy);
    const count = Phaser.Math.Between(wave.countMin ?? 0, wave.countMax ?? wave.countMin ?? 0);
    const carrierVx = vx * (wave.inheritCarrierScale ?? 1);
    const carrierVy = vy * (wave.inheritCarrierScale ?? 1);

    for (let i = 0; i < count; i++) {
      const angle = wave.shape === 'directional' && motion.hasDir
        ? motion.dirRad + Phaser.Math.FloatBetween(-(wave.spreadRad ?? Math.PI), wave.spreadRad ?? Math.PI)
        : Phaser.Math.FloatBetween(-Math.PI, Math.PI);
      const blastSpeed = Phaser.Math.FloatBetween(wave.speedMin ?? 0, wave.speedMax ?? wave.speedMin ?? 0);
      const fragVel = composeFragmentVelocity(carrierVx, carrierVy, angle, blastSpeed);
      const size = Phaser.Math.FloatBetween(wave.sizeMin ?? 1, wave.sizeMax ?? wave.sizeMin ?? 1);
      const life = Phaser.Math.Between(wave.lifeMin ?? 300, wave.lifeMax ?? wave.lifeMin ?? 300);
      const tint = wave.tints?.[Phaser.Math.Between(0, Math.max(0, (wave.tints?.length ?? 1) - 1))] ?? 0xffffff;

      this._spawnFragment(x, y, fragVel.vx, fragVel.vy, size, tint, life);
    }
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
   * Enemy bullets inherit a temporary velocity offset on top of their authored path.
   * @param {number} x
   * @param {number} y
   * @param {Array<object>} enemies
   * @param {Array<object>} enemyBullets
   * @param {{radius?: number, maxPush?: number, carryRatio?: number}} [opts]
   */
  _applyShockwave(x, y, vx, vy, enemies, enemyBullets, opts = {}) {
    for (const enemy of enemies) {
      if (!enemy?.alive || typeof enemy.applyPush !== 'function') continue;
      const push = calcShockwavePush(x, y, enemy.x, enemy.y, vx, vy, opts);
      if (push) {
        enemy.applyPush(push.vx, push.vy);
      }
    }

    for (const bullet of enemyBullets) {
      if (!bullet?.active) continue;
      const push = calcShockwavePush(x, y, bullet.x, bullet.y, vx, vy, opts);
      if (push) {
        bullet._pushVx = (bullet._pushVx ?? 0) + push.vx;
        bullet._pushVy = (bullet._pushVy ?? 0) + push.vy;
      }
    }
  }

  _applyGravityPull(source, target, radius, strength, delta) {
    if (!source || !target || target.active === false) return;

    const dx = (source.x ?? 0) - (target.x ?? 0);
    const dy = (source.y ?? 0) - (target.y ?? 0);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0 || dist >= radius) return;

    const nx = dx / dist;
    const ny = dy / dist;
    const falloff = 1 - (dist / radius);
    const impulse = strength * (0.25 + falloff * 0.75) * (Math.max(0, delta) / 1000);

    if (target.body?.setVelocity) {
      const nextVx = (target.body.velocity?.x ?? 0) + nx * impulse;
      const nextVy = (target.body.velocity?.y ?? 0) + ny * impulse;
      target.body.setVelocity(nextVx, nextVy);
      return;
    }

    target.x += nx * impulse * 0.3;
    target.y += ny * impulse * 0.3;
    target.body?.updateFromGameObject?.();
  }
}
