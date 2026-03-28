import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { RunState } = await import('../../systems/RunState.js');
const { MenuScene } = await import('../../scenes/MenuScene.js');

describe('MenuScene', () => {
  it('jumps straight into GameScene when ?level2=1 is present', () => {
    const scene = new MenuScene();
    Object.assign(scene, createMockScene());

    let startedSceneKey = null;
    scene.scene = {
      start(sceneKey) {
        startedSceneKey = sceneKey;
      },
    };

    const previousLocation = globalThis.location;
    const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');

    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { search: '?level2=1' },
    });

    try {
      RunState.score = 900;
      RunState.level = 4;
      scene.create();

      assert.equal(startedSceneKey, 'GameScene');
      assert.equal(RunState.score, 0);
      assert.equal(RunState.level, 1);
    } finally {
      if (hadLocation) {
        Object.defineProperty(globalThis, 'location', {
          configurable: true,
          writable: true,
          value: previousLocation,
        });
      } else {
        delete globalThis.location;
      }
      RunState.reset();
    }
  });
});
