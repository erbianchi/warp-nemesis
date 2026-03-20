/** @module GameScene
 * Core game loop — orchestrator only.
 * Phase 1: starfield + moveable player rectangle + weapon slot display. */

import { GAME_CONFIG } from '../config/game.config.js';
import { ScrollingBackground } from '../systems/ScrollingBackground.js';
import { WeaponManager } from '../weapons/WeaponManager.js';

const { WIDTH, HEIGHT, PLAYER_SPEED } = GAME_CONFIG;

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    this._bg      = new ScrollingBackground(this);
    this._player  = this._createPlayer();
    this._weapons = new WeaponManager(this);
    this._cursors = this.input.keyboard.createCursorKeys();
    this._wasd    = this._createWASD();
    this._space   = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    this._buildWeaponDisplay();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('MenuScene'));
  }

  update(_time, delta) {
    this._bg.update(delta);
    this._movePlayer();
    this._weapons.update(delta);
    if (this._space.isDown) {
      this._weapons.tryFire(this._player.x, this._player.y);
    }
  }

  // ---------------------------------------------------------------------------

  /** @returns {Phaser.GameObjects.Rectangle} Physics-enabled player rectangle. */
  _createPlayer() {
    const player = this.add.rectangle(WIDTH / 2, HEIGHT - 80, 28, 36, 0x00ff88);
    this.physics.add.existing(player);
    player.body.setCollideWorldBounds(true);
    return player;
  }

  /** @returns {object} WASD key set. */
  _createWASD() {
    return this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
  }

  /**
   * Draw static weapon slot boxes in the bottom-left corner.
   * Re-call whenever the loadout changes (future phases).
   */
  _buildWeaponDisplay() {
    const BOX_W = 62;
    const BOX_H = 38;
    const GAP   = 6;
    const X0    = 8;
    const Y0    = HEIGHT - BOX_H - 8;

    const gfx = this.add.graphics();

    this._weapons.getSlots().forEach((slot, i) => {
      const x      = X0 + i * (BOX_W + GAP);
      const filled = slot !== null;
      const border = filled ? slot.color : 0x2a2a2a;
      const bg     = filled ? 0x001428  : 0x080808;
      const css    = filled ? `#${slot.color.toString(16).padStart(6, '0')}` : '#2a2a2a';

      gfx.fillStyle(bg, 1);
      gfx.fillRect(x, Y0, BOX_W, BOX_H);
      gfx.lineStyle(1, border, 1);
      gfx.strokeRect(x, Y0, BOX_W, BOX_H);

      // Slot number — top-left
      this.add.text(x + 4, Y0 + 3, `${i + 1}`, {
        fontSize: '9px', fill: filled ? '#aaaaaa' : '#333333', fontFamily: 'monospace',
      });

      // Weapon name — centered
      this.add.text(x + BOX_W / 2, Y0 + BOX_H / 2 + 3, filled ? slot.name : '----', {
        fontSize: '11px', fill: css, fontFamily: 'monospace',
      }).setOrigin(0.5);
    });
  }

  /** Read input, set velocity, normalise diagonals. */
  _movePlayer() {
    const body  = this._player.body;
    const c     = this._cursors;
    const w     = this._wasd;

    const left  = c.left.isDown  || w.left.isDown;
    const right = c.right.isDown || w.right.isDown;
    const up    = c.up.isDown    || w.up.isDown;
    const down  = c.down.isDown  || w.down.isDown;

    body.setVelocity(0);
    if (left)  body.setVelocityX(-PLAYER_SPEED);
    if (right) body.setVelocityX(PLAYER_SPEED);
    if (up)    body.setVelocityY(-PLAYER_SPEED);
    if (down)  body.setVelocityY(PLAYER_SPEED);

    if ((left || right) && (up || down)) {
      body.velocity.normalize().scale(PLAYER_SPEED);
    }
  }
}
