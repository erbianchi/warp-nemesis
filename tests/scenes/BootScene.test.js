import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { BootScene } = await import('../../scenes/BootScene.js');

describe('BootScene', () => {
  it('preloads the player sprite and current audio set', () => {
    const scene = new BootScene();
    const imageCalls = [];
    const audioCalls = [];
    scene.load = {
      image: (key, path) => {
        imageCalls.push({ key, path });
      },
      audio: (key, path) => {
        audioCalls.push({ key, path });
      },
    };

    scene.preload();

    assert.deepEqual(imageCalls, [{
      key: 'spacecraft1',
      path: 'assets/sprites/spacecraft1.png',
    }]);
    assert.deepEqual(audioCalls, [{
      key: 'laserSmall_000',
      path: 'assets/audio/sfx/laserSmall_000.ogg',
    }, {
      key: 'laserOverheat_000',
      path: 'assets/audio/sfx/laserOverheat_000..ogg',
    }, {
      key: 'explosionSkirm_000',
      path: 'assets/audio/sfx/explosionSkirm_000.ogg',
    }, {
      key: 'forceField_001',
      path: 'assets/audio/sfx/forceField_001.ogg',
    }]);
  });
});
