/** @module MenuScene
 * Main menu: title, start button, keyboard shortcut. */

import { GAME_CONFIG } from '../config/game.config.js';

const { WIDTH, HEIGHT } = GAME_CONFIG;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;

const STYLE = {
  title:    { fontSize: '34px', fill: '#00ffff', fontFamily: 'monospace', fontStyle: 'bold' },
  subtitle: { fontSize: '13px', fill: '#557799', fontFamily: 'monospace' },
  btn:      { fontSize: '17px', fill: '#ffffff', fontFamily: 'monospace' },
  hint:     { fontSize: '11px', fill: '#334455', fontFamily: 'monospace' },
};

export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MenuScene' });
  }

  create() {
    this._buildBackground();
    this._buildTitle();
    this._buildStartButton();
    this._buildHints();
  }

  /** Subtle gradient-like backdrop using a single dark rectangle. */
  _buildBackground() {
    this.add.rectangle(CX, CY, WIDTH, HEIGHT, 0x000814);
  }

  _buildTitle() {
    this.add.text(CX, CY - 130, 'STARSHIP', STYLE.title).setOrigin(0.5);
    this.add.text(CX, CY - 90,  'NEMESIS',  { ...STYLE.title, fill: '#ff4444' }).setOrigin(0.5);
    this.add.text(CX, CY - 55,  'A SPACE ROGUELIKE', STYLE.subtitle).setOrigin(0.5);
  }

  _buildStartButton() {
    const btn = this.add.rectangle(CX, CY + 20, 200, 46, 0x002244).setInteractive();
    const label = this.add.text(CX, CY + 20, 'START GAME', STYLE.btn).setOrigin(0.5);

    btn.on('pointerover',  () => { btn.setFillStyle(0x0044aa); label.setStyle({ fill: '#00ffff' }); });
    btn.on('pointerout',   () => { btn.setFillStyle(0x002244); label.setStyle({ fill: '#ffffff' }); });
    btn.on('pointerdown',  () => this._startGame());

    this.input.keyboard.on('keydown-ENTER', () => this._startGame());
    this.input.keyboard.on('keydown-SPACE', () => this._startGame());
  }

  _buildHints() {
    this.add.text(CX, HEIGHT - 48, 'ARROW KEYS or WASD  ·  move', STYLE.hint).setOrigin(0.5);
    this.add.text(CX, HEIGHT - 30, 'ENTER or SPACE  ·  start', STYLE.hint).setOrigin(0.5);
  }

  _startGame() {
    this.scene.start('GameScene');
  }
}
