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
    document.getElementById('loading-overlay')?.classList.add('hidden');
    this.scene.start('MenuScene');
  }
}
