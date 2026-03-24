import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { MenuScene } = await import('../../scenes/MenuScene.js');

describe('MenuScene', () => {
  it('always starts GameScene from the menu', () => {
    const scene = new MenuScene();
    Object.assign(scene, createMockScene());

    let startedScene = null;
    scene.scene = {
      start: (sceneKey) => {
        startedScene = sceneKey;
      },
    };

    scene._startGame();

    assert.equal(startedScene, 'GameScene');
  });
});
