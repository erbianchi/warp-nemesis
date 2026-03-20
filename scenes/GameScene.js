/** @module GameScene
 * Core game loop — orchestrator only.
 * Phase 1: starfield + moveable player rectangle. */

import { GAME_CONFIG } from '../config/game.config.js';
import { ScrollingBackground } from '../systems/ScrollingBackground.js';

const { WIDTH, HEIGHT, PLAYER_SPEED } = GAME_CONFIG;

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    this._bg     = new ScrollingBackground(this);
    this._player = this._createPlayer();
    this._cursors = this.input.keyboard.createCursorKeys();
    this._wasd    = this._createWASD();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('MenuScene'));
  }

  update(_time, delta) {
    this._bg.update(delta);
    this._movePlayer();
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
