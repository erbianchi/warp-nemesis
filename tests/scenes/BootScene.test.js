import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { BootScene } = await import('../../scenes/BootScene.js');

describe('BootScene', () => {
  it('preloads the player sprite, particle atlas, and current audio set', () => {
    const scene = new BootScene();
    const imageCalls = [];
    const atlasCalls = [];
    const audioCalls = [];
    scene.load = {
      image: (key, path) => {
        imageCalls.push({ key, path });
      },
      atlas: (key, textureURL, atlasURL) => {
        atlasCalls.push({ key, textureURL, atlasURL });
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
    assert.deepEqual(atlasCalls, [{
      key: 'flares',
      textureURL: 'assets/particles/flares.png',
      atlasURL: 'assets/particles/flares.json',
    }]);
    assert.deepEqual(audioCalls, [{
      key: 'laserSmall_000',
      path: 'assets/audio/sfx/laserSmall_000.ogg',
    }, {
      key: 'laserOverheat_000',
      path: 'assets/audio/sfx/laserOverheat_000.ogg',
    }, {
      key: 'laserCooling',
      path: 'assets/audio/sfx/laserCooling.ogg',
    }, {
      key: 'explosionSkirm_000',
      path: 'assets/audio/sfx/explosionSkirm_000.ogg',
    }, {
      key: 'forceField_001',
      path: 'assets/audio/sfx/forceField_001.ogg',
    }]);
  });

  it('starts the menu scene by default after boot', () => {
    const scene = new BootScene();
    let startedScene = null;
    let texturesGenerated = 0;
    const originalDocument = globalThis.document;
    const originalLocation = globalThis.location;

    scene._generateTextures = () => {
      texturesGenerated++;
    };
    scene.scene = {
      start: (sceneKey) => {
        startedScene = sceneKey;
      },
    };
    globalThis.document = {
      getElementById: () => ({ classList: { add: () => {} } }),
    };
    globalThis.location = { search: '' };

    try {
      scene.create();
      assert.equal(texturesGenerated, 1);
      assert.equal(startedScene, 'MenuScene');
    } finally {
      globalThis.document = originalDocument;
      globalThis.location = originalLocation;
    }
  });

  it('jumps straight into GameScene when ?level2=1 is present', () => {
    const scene = new BootScene();
    let startedScene = null;
    const originalDocument = globalThis.document;
    const originalLocation = globalThis.location;

    scene._generateTextures = () => {};
    scene.scene = {
      start: (sceneKey) => {
        startedScene = sceneKey;
      },
    };
    globalThis.document = {
      getElementById: () => ({ classList: { add: () => {} } }),
    };
    globalThis.location = { search: '?level2=1' };

    try {
      scene.create();
      assert.equal(startedScene, 'GameScene');
    } finally {
      globalThis.document = originalDocument;
      globalThis.location = originalLocation;
    }
  });
});
