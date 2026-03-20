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
  }
}
