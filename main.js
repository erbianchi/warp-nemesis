/** @module main
 * Phaser game bootstrap — config and scene registry.
 * No game logic lives here. */

import { GAME_CONFIG } from './config/game.config.js';
import { BootScene }   from './scenes/BootScene.js';
import { MenuScene }   from './scenes/MenuScene.js';
import { GameScene }   from './scenes/GameScene.js';
import { LevelTransitionScene } from './scenes/LevelTransitionScene.js';

const { WIDTH, HEIGHT } = GAME_CONFIG;

// eslint-disable-next-line no-unused-vars
const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: WIDTH,
  height: HEIGHT,
  backgroundColor: '#000814',
  parent: 'game-container',

  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },

  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false },
  },

  scene: [BootScene, MenuScene, GameScene, LevelTransitionScene],
});
