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
const TINTS = [0xff5500, 0xff6600, 0xff8800, 0xff9900, 0xffbb00, 0xffcc00, 0xffffff, 0xffee88];

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
   */
  explodeForType(x, y, type, vx = 0, vy = 0, enemies = [], enemyBullets = []) {
    switch (type) {
      case 'skirm':
      default:
        this._explodeSkirm(x, y, vx, vy, enemies, enemyBullets);
        break;
    }
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
    const speed  = Math.sqrt(vx * vx + vy * vy);
    const hasDir = speed > 40;
    const dirRad = hasDir ? Math.atan2(vy, vx) : 0;
    const spreadRad = hasDir
      ? Phaser.Math.Clamp((140 - speed * 0.1) * (Math.PI / 180), 0.9, 2.3)
      : Math.PI;
    const launchSpeed = Phaser.Math.Clamp(120 + speed * 0.7, 120, 480);
    const count       = Math.round(Phaser.Math.Clamp(18 + speed / 8, 18, 48));

    for (let i = 0; i < count; i++) {
      const angle = hasDir
        ? dirRad + Phaser.Math.FloatBetween(-spreadRad, spreadRad)
        : Phaser.Math.FloatBetween(-Math.PI, Math.PI);
      const mag   = Phaser.Math.FloatBetween(launchSpeed * 0.2, launchSpeed);
      const size  = Phaser.Math.FloatBetween(2, 5 + speed / 100);
      const life  = Phaser.Math.Between(320, 700);
      const tint  = TINTS[Phaser.Math.Between(0, TINTS.length - 1)];

      this._spawnFragment(
        x,
        y,
        Math.cos(angle) * mag,
        Math.sin(angle) * mag,
        size,
        tint,
        life
      );
    }

    this._applyShockwave(x, y, enemies, enemyBullets);
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
  _applyShockwave(x, y, enemies, enemyBullets) {
    const radialPush = (ox, oy) => {
      const dx   = ox - x;
      const dy   = oy - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0 || dist >= PUSH_RADIUS) return null;
      const force = MAX_PUSH * (1 - dist / PUSH_RADIUS);
      return { vx: (dx / dist) * force, vy: (dy / dist) * force };
    };

    for (const enemy of enemies) {
      if (!enemy?.alive || typeof enemy.applyPush !== 'function') continue;
      const push = radialPush(enemy.x, enemy.y);
      if (push) enemy.applyPush(push.vx, push.vy);
    }

    for (const bullet of enemyBullets) {
      if (!bullet?.active) continue;
      const push = radialPush(bullet.x, bullet.y);
      if (push) bullet._pushVx = (bullet._pushVx ?? 0) + push.vx;
    }
  }
}
