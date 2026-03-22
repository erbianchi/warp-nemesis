/** @module BootScene
 * Preloads all assets, then starts MenuScene.
 * Phase 1: no real assets — transitions immediately. */

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload() {
    this.load.image('spacecraft1', 'assets/sprites/spacecraft1.png');
    this.load.audio('laserSmall_000', 'assets/audio/sfx/laserSmall_000.ogg');
    this.load.audio('laserOverheat_000', 'assets/audio/sfx/laserOverheat_000..ogg');
    this.load.audio('explosionSkirm_000', 'assets/audio/sfx/explosionSkirm_000.ogg');
    this.load.audio('forceField_001', 'assets/audio/sfx/forceField_001.ogg');
  }

  create() {
    this._generateTextures();
    document.getElementById('loading-overlay')?.classList.add('hidden');
    this.scene.start('MenuScene');
  }

  /** Generate programmatic textures used as placeholders until real sprites arrive. */
  _generateTextures() {
    // Laser bullet — thin cyan bar (3 px wide)
    const g = this.make.graphics({ add: false });
    g.fillStyle(0x00ffff, 1);
    g.fillRect(0, 0, 3, 16);
    g.generateTexture('bullet_laser', 3, 16);
    g.destroy();

    // Warning laser bullet — two 3 px beams with a 5 px gap (total 11 px wide)
    const wl = this.make.graphics({ add: false });
    wl.fillStyle(0x00ffff, 1);
    wl.fillRect(0, 0, 3, 16);   // left beam
    wl.fillRect(8, 0, 3, 16);   // right beam  (offset = 3 + 5-gap = 8)
    wl.generateTexture('bullet_laser_warning', 11, 16);
    wl.destroy();

    // Enemy fighter — 24×20 px, nose pointing down (toward player)
    const ef = this.make.graphics({ add: false });
    ef.fillStyle(0xdd2211, 1);
    ef.fillTriangle(12, 20, 0, 6, 24, 6);   // main body
    ef.fillStyle(0xff5544, 1);
    ef.fillRect(6, 0, 12, 8);               // cockpit
    ef.fillStyle(0xdd2211, 1);
    ef.fillRect(0, 5, 8, 6);                // left wing
    ef.fillRect(16, 5, 8, 6);              // right wing
    ef.generateTexture('enemy_fighter', 24, 20);
    ef.destroy();

    // Skirm — 20×16 px basic cannon-fodder, orange-red, nose down
    const sk = this.make.graphics({ add: false });
    sk.fillStyle(0xff6600, 1);
    sk.fillTriangle(10, 16, 0, 4, 20, 4);   // body
    sk.fillStyle(0xffaa44, 1);
    sk.fillRect(7, 0, 6, 5);                // cockpit
    sk.fillStyle(0xff6600, 1);
    sk.fillRect(0, 3, 5, 5);               // left wing
    sk.fillRect(15, 3, 5, 5);              // right wing
    sk.generateTexture('skirm', 20, 16);
    sk.destroy();

    // Enemy bullet — small red bar
    const eb = this.make.graphics({ add: false });
    eb.fillStyle(0xff3300, 1);
    eb.fillRect(0, 0, 3, 10);
    eb.generateTexture('bullet_enemy', 3, 10);
    eb.destroy();

    // Particle dot — 4×4 white square, tinted per-emitter at runtime
    const pt = this.make.graphics({ add: false });
    pt.fillStyle(0xffffff, 1);
    pt.fillRect(0, 0, 4, 4);
    pt.generateTexture('particle', 4, 4);
    pt.destroy();

    // Bonus pickup — white octagon
    const bonus = this.make.graphics({ add: false });
    bonus.fillStyle(0xffffff, 1);
    bonus.lineStyle(2, 0xd8ecff, 1);
    bonus.beginPath();
    bonus.moveTo(8, 0);
    bonus.lineTo(16, 0);
    bonus.lineTo(24, 8);
    bonus.lineTo(24, 16);
    bonus.lineTo(16, 24);
    bonus.lineTo(8, 24);
    bonus.lineTo(0, 16);
    bonus.lineTo(0, 8);
    bonus.closePath();
    bonus.fillPath();
    bonus.strokePath();
    bonus.generateTexture('bonus_octagon', 24, 24);
    bonus.destroy();
  }
}
