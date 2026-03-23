/** @module LevelTransitionScene
 * Level-end store for meta-progression purchases. */

import { GAME_CONFIG } from '../config/game.config.js';
import { STORE_ITEMS } from '../config/store.config.js';
import { MetaProgression } from '../systems/MetaProgression.js';

const { WIDTH, HEIGHT } = GAME_CONFIG;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;

const STYLE = {
  title: { fontSize: '28px', fill: '#00ffff', fontFamily: 'monospace', fontStyle: 'bold' },
  subtitle: { fontSize: '13px', fill: '#8eb7d6', fontFamily: 'monospace' },
  body: { fontSize: '12px', fill: '#ffffff', fontFamily: 'monospace' },
  dim: { fontSize: '11px', fill: '#5a6f84', fontFamily: 'monospace' },
  status: { fontSize: '12px', fill: '#ffee88', fontFamily: 'monospace' },
  button: { fontSize: '13px', fill: '#ffffff', fontFamily: 'monospace' },
};

export class LevelTransitionScene extends Phaser.Scene {
  constructor() {
    super({ key: 'LevelTransitionScene' });
  }

  /**
   * @param {{levelNumber?: number, runScore?: number, returnSceneKey?: string, continueLabel?: string}} data
   */
  create(data = {}) {
    this._levelNumber = data.levelNumber ?? 1;
    this._runScore = data.runScore ?? 0;
    this._returnSceneKey = data.returnSceneKey ?? 'MenuScene';
    this._continueLabel = data.continueLabel ?? 'CONTINUE';
    this._storeSnapshot = MetaProgression.load();

    this._buildBackground();
    this._buildHeader();
    this._buildStoreItems();
    this._buildOwnedBonuses();
    this._buildStatusText();
    this._buildContinueButton();
    this._refreshStoreTexts();
    this._bindKeyboardShortcuts();
  }

  _buildBackground() {
    this.add.rectangle(CX, CY, WIDTH, HEIGHT, 0x031321);
  }

  _buildHeader() {
    this.add.text(CX, 52, 'STORE', STYLE.title).setOrigin(0.5);
    this.add.text(CX, 80, `LEVEL ${this._levelNumber} COMPLETE`, STYLE.subtitle).setOrigin(0.5);
    this.add.text(CX, 102, `RUN SCORE  ${this._runScore}`, STYLE.body).setOrigin(0.5);
    this._totalScoreText = this.add.text(CX, 126, 'TOTAL SCORE  0', STYLE.body).setOrigin(0.5);
  }

  _buildStoreItems() {
    this._storeButtons = [];
    STORE_ITEMS.forEach((item, index) => {
      const top = 176 + index * 108;
      const bg = this.add.rectangle(CX, top, 384, 86, 0x07233d);
      bg.setStrokeStyle?.(1, 0x1d5f89, 1);
      bg.setInteractive?.();
      bg.on?.('pointerdown', () => this._purchaseItem(item.key));

      const shortcut = this.add.text(64, top - 26, `${index + 1}.`, STYLE.button).setOrigin(0, 0.5);
      const label = this.add.text(96, top - 26, item.label, STYLE.button).setOrigin(0, 0.5);
      const description = this.add.text(96, top - 2, item.description, STYLE.dim).setOrigin(0, 0.5);
      const price = this.add.text(96, top + 24, `PRICE  ${item.price}`, STYLE.body).setOrigin(0, 0.5);

      this._storeButtons.push({
        item,
        bg,
        shortcut,
        label,
        description,
        price,
      });
    });
  }

  _buildOwnedBonuses() {
    this.add.text(CX, 406, 'FUTURE GAMES', STYLE.subtitle).setOrigin(0.5);
    this._ownedHpText = this.add.text(CX, 430, 'HP  +0', STYLE.body).setOrigin(0.5);
    this._ownedShieldText = this.add.text(CX, 452, 'SHIELD  +0', STYLE.body).setOrigin(0.5);
  }

  _buildStatusText() {
    this._statusText = this.add.text(CX, 492, 'PRESS 1 OR 2 TO BUY', STYLE.status).setOrigin(0.5);
  }

  _buildContinueButton() {
    const button = this.add.rectangle(CX, 560, 250, 42, 0x0b3554);
    button.setStrokeStyle?.(1, 0x35a7ff, 1);
    button.setInteractive?.();
    button.on?.('pointerdown', () => this._continue());
    this.add.text(CX, 560, this._continueLabel, STYLE.button).setOrigin(0.5);
  }

  _bindKeyboardShortcuts() {
    this.input.keyboard.on('keydown-ONE', () => this._purchaseItem(STORE_ITEMS[0]?.key));
    this.input.keyboard.on('keydown-TWO', () => this._purchaseItem(STORE_ITEMS[1]?.key));
    this.input.keyboard.on('keydown-ENTER', () => this._continue());
    this.input.keyboard.on('keydown-ESC', () => this._continue());
  }

  _refreshStoreTexts() {
    this._storeSnapshot = MetaProgression.load();
    this._totalScoreText.setText?.(`TOTAL SCORE  ${this._storeSnapshot.totalScore}`);
    this._ownedHpText.setText?.(`HP  +${this._storeSnapshot.ownedBonuses.hp}`);
    this._ownedShieldText.setText?.(`SHIELD  +${this._storeSnapshot.ownedBonuses.shield}`);

    this._storeButtons.forEach(({ item, bg, price, label }) => {
      const affordable = this._storeSnapshot.totalScore >= item.price;
      bg.setFillStyle?.(affordable ? 0x07233d : 0x181818);
      bg.setStrokeStyle?.(1, affordable ? 0x1d5f89 : 0x4c4c4c, 1);
      price.setStyle?.({ ...STYLE.body, fill: affordable ? '#ffffff' : '#888888' });
      label.setStyle?.({ ...STYLE.button, fill: affordable ? '#ffffff' : '#888888' });
    });
  }

  _purchaseItem(itemKey) {
    const result = MetaProgression.purchase(itemKey);
    if (!result.ok) {
      if (result.reason === 'insufficient_score') {
        this._statusText.setText?.('NOT ENOUGH TOTAL SCORE');
      } else {
        this._statusText.setText?.('ITEM UNAVAILABLE');
      }
      this._refreshStoreTexts();
      return result;
    }

    this._statusText.setText?.(`${result.item.label} PURCHASED`);
    this._refreshStoreTexts();
    return result;
  }

  _continue() {
    this.scene.start(this._returnSceneKey);
  }
}
