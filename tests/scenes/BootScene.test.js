import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { BootScene } = await import('../../scenes/BootScene.js');

describe('BootScene', () => {
  it('preloads the weapon, explosion, and bonus pickup sounds', () => {
    const scene = new BootScene();
    const calls = [];
    scene.load = {
      audio: (key, path) => {
        calls.push({ key, path });
      },
    };

    scene.preload();

    assert.deepEqual(calls, [{
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
