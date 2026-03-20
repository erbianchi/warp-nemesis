/**
 * Minimal Phaser stubs for unit tests.
 * No browser, no canvas, no WebGL required.
 *
 * Usage:
 *   import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';
 *   installPhaserGlobal();   // call before importing any Phaser-dependent module
 */

/** Install a minimal `globalThis.Phaser` matching the APIs used by game code. */
export function installPhaserGlobal() {
  globalThis.Phaser = {
    Scene: class {
      constructor(cfg) { this.key = cfg?.key; }
    },

    Math: {
      Between:       (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
      FloatBetween:  (min, max) => Math.random() * (max - min) + min,
      Linear:        (a, b, t)  => a + (b - a) * t,
    },

    Display: {
      Color: {
        GetColor: (r, g, b) => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff),
      },
    },

    Input: {
      Keyboard: {
        KeyCodes: { W: 87, A: 65, S: 83, D: 68 },
      },
    },

    Physics: {
      Arcade: {
        Body: class {
          constructor() {
            this.velocity = { normalize: () => ({ scale: () => {} }) };
          }
          setCollideWorldBounds() {}
          setVelocity() {}
          setVelocityX() {}
          setVelocityY() {}
        },
      },
    },

    Scale: { FIT: 1, CENTER_BOTH: 1 },
    AUTO: 0,
  };
}

/** Create a mock Phaser scene with stubbed add/physics/input/events APIs. */
export function createMockScene() {
  const mockBody = {
    velocity: { normalize: () => ({ scale: () => {} }) },
    setCollideWorldBounds: () => {},
    setVelocity:  () => {},
    setVelocityX: () => {},
    setVelocityY: () => {},
  };

  const mockGraphics = {
    clear:     () => {},
    fillStyle: () => {},
    fillRect:  () => {},
  };

  return {
    add: {
      graphics:  () => mockGraphics,
      rectangle: () => ({ body: mockBody, setInteractive: () => ({ on: () => {} }), on: () => {} }),
      text:      () => ({ setOrigin: () => ({ setStyle: () => {} }), setStyle: () => {} }),
    },
    physics: {
      add: {
        existing: (obj) => { obj.body = { ...mockBody }; },
      },
    },
    input: {
      keyboard: {
        createCursorKeys: () => ({
          left:  { isDown: false },
          right: { isDown: false },
          up:    { isDown: false },
          down:  { isDown: false },
        }),
        addKeys: () => ({
          left:  { isDown: false },
          right: { isDown: false },
          up:    { isDown: false },
          down:  { isDown: false },
        }),
        on:   () => {},
        once: () => {},
      },
    },
    scene:  { start: () => {} },
    events: { emit: () => {}, on: () => {} },
  };
}
