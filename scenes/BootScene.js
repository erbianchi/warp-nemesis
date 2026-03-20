/** @module BootScene
 * Preloads all assets, then starts MenuScene.
 * Phase 1: no real assets — transitions immediately. */

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload() {
    // Phases 2+ will load sprites and audio here.
  }

  create() {
    this._generateTextures();
    document.getElementById('loading-overlay')?.classList.add('hidden');
    this.scene.start('MenuScene');
  }

  /** Generate programmatic textures used as placeholders until real sprites arrive. */
  _generateTextures() {
    // Laser bullet — thin cyan bar
    const g = this.make.graphics({ add: false });
    g.fillStyle(0x00ffff, 1);
    g.fillRect(0, 0, 3, 16);
    g.generateTexture('bullet_laser', 3, 16);
    g.destroy();

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

    // Enemy bullet — small red bar
    const eb = this.make.graphics({ add: false });
    eb.fillStyle(0xff3300, 1);
    eb.fillRect(0, 0, 3, 10);
    eb.generateTexture('bullet_enemy', 3, 10);
    eb.destroy();
  }
}
