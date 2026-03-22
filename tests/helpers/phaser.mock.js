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
  class MockArcadeSprite {
    constructor(scene, x, y, texture) {
      this.scene   = scene;
      this.x       = x;
      this.y       = y;
      this.texture = texture;
      this.depth   = 0;
      this.width   = 0;
      this.height  = 0;
      this.displayWidth = 0;
      this.displayHeight = 0;
      this.scaleX  = 1;
      this.scaleY  = 1;
      this.rotation = 0;
      this.body    = {
        setVelocity:  () => {},
        setVelocityX: () => {},
        setVelocityY: () => {},
      };
      this.active = true;
      this.visible = true;
      this.alpha = 1;
    }
    destroy()        { this.active = false; }
    setActive(v)     { this.active = v; return this; }
    setVisible(v)    { this.visible = v; return this; }
    setVelocity()    { return this; }
    setVelocityX()   { return this; }
    setVelocityY()   { return this; }
    setDepth(v)      { this.depth = v; return this; }
    setOrigin()      { return this; }
    setAlpha(v)      { this.alpha = v; return this; }
    setTint(v)       { this.tint = v; return this; }
    clearTint()      { delete this.tint; return this; }
    setTexture(v)    { this.texture = v; return this; }
    setRotation(v)   { this.rotation = v; return this; }
    setScale(x, y = x) {
      this.scaleX = x;
      this.scaleY = y;
      this.displayWidth = this.width * x;
      this.displayHeight = this.height * y;
      return this;
    }
    setStrokeStyle(width, color, alpha = 1) {
      this.strokeStyle = { width, color, alpha };
      return this;
    }
    setDisplaySize(width, height) {
      this.displayWidth = width;
      this.displayHeight = height;
      return this;
    }
  }

  globalThis.Phaser = {
    Scene: class {
      constructor(cfg) { this.key = cfg?.key; }
    },

    Math: {
      Between:       (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
      FloatBetween:  (min, max) => Math.random() * (max - min) + min,
      Linear:        (a, b, t)  => a + (b - a) * t,
      Clamp:         (val, min, max) => Math.min(Math.max(val, min), max),
    },

    Display: {
      Color: {
        GetColor: (r, g, b) => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff),
      },
    },

    Input: {
      Keyboard: {
        KeyCodes: { W: 87, A: 65, S: 83, D: 68, SPACE: 32 },
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
        Sprite: MockArcadeSprite,
        Image:  MockArcadeSprite,
      },
    },

    Scale: { FIT: 1, CENTER_BOTH: 1 },
    AUTO: 0,
  };
}

/** Create a mock Phaser scene with stubbed add/physics/input/events APIs. */
export function createMockScene() {
  const makeMockBody = () => ({
    velocity:              { x: 0, y: 0, normalize: () => ({ scale: () => {} }) },
    speed:                 0,
    allowGravity:          true,
    useDamping:            false,
    enable:                true,
    gravityY:              0,
    drag:                  0,
    setCollideWorldBounds: () => {},
    setGravityY:           function(v)    { this.gravityY = v; },
    setVelocity:           function(x, y) { this.velocity.x = x; this.velocity.y = y; },
    setVelocityX:          function(v)    { this.velocity.x = v; },
    setVelocityY:          function(v)    { this.velocity.y = v; },
    setAcceleration:       () => {},
    setDrag:               function(v)    { this.drag = v; },
    setAllowGravity:       function(v)    { this.allowGravity = v; },
    reset:                 function(x, y) { this.x = x; this.y = y; this.velocity.x = 0; this.velocity.y = 0; },
    stop:                  function()     { this.velocity.x = 0; this.velocity.y = 0; },
    updateFromGameObject:  function() {
      if (!this.gameObject) return;
      this.x = this.gameObject.x;
      this.y = this.gameObject.y;
    },
  });

  const mockGraphics = {
    setDepth:  () => mockGraphics,
    clear:     () => {},
    fillStyle: () => {},
    fillRect:  () => {},
    lineStyle: () => {},
    strokeRect: () => {},
  };

  const mockGameObject = () => {
    const obj = {
      x: 0, y: 0,
      body:           null,
      active:         true,
      visible:        true,
      alpha:          1,
      depth:          0,
      width:          0,
      height:         0,
      displayWidth:   0,
      displayHeight:  0,
      scaleX:         1,
      scaleY:         1,
      rotation:       0,
      setInteractive: () => ({ on: () => {} }),
      setDepth:       function(v) { this.depth = v; return this; },
      setOrigin:      function() { return this; },
      setAlpha:       function(v) { this.alpha = v; return this; },
      setActive:      function(v) { this.active = v; return this; },
      setVisible:     function(v) { this.visible = v; return this; },
      setTint:        function(v) { this.tint = v; return this; },
      clearTint:      function() { delete this.tint; return this; },
      setTexture:     function(v) { this.texture = v; return this; },
      setRotation:    function(v) { this.rotation = v; return this; },
      setScale:       function(x, y = x) {
        this.scaleX = x;
        this.scaleY = y;
        this.displayWidth = this.width * x;
        this.displayHeight = this.height * y;
        return this;
      },
      setStrokeStyle: function(width, color, alpha = 1) {
        this.strokeStyle = { width, color, alpha };
        return this;
      },
      setDisplaySize: function(width, height) {
        this.displayWidth = width;
        this.displayHeight = height;
        return this;
      },
      setText:        function(v) { this.text = v; return this; },
      on:             () => {},
      destroy:        function() { this.active = false; },
    };
    obj.preFX = {
      addGlow: (color, outerStrength = 0) => ({ color, outerStrength }),
    };
    obj.body = makeMockBody();
    obj.body.gameObject = obj;
    return obj;
  };

  const createMockGroup = (cfg = {}) => {
    const children = [];
    const maxSize = cfg.maxSize ?? Infinity;

    const spawn = (x = 0, y = 0) => {
      const child = mockGameObject();
      child.x = x;
      child.y = y;
      return child;
    };

    return {
      _children: children,
      add: (obj) => { children.push(obj); return obj; },
      remove: (obj) => {
        const idx = children.indexOf(obj);
        if (idx !== -1) children.splice(idx, 1);
        return obj;
      },
      getChildren: () => children,
      killAndHide: (obj) => {
        obj.setActive(false).setVisible(false);
        return obj;
      },
      createMultiple: ({ quantity = 1, active = true, visible = true } = {}) => {
        for (let i = 0; i < quantity && children.length < maxSize; i++) {
          const child = spawn();
          child.setActive(active).setVisible(visible);
          child.body.enable = active;
          children.push(child);
        }
      },
      get: (x = 0, y = 0) => {
        const reuse = children.find(child => !child.active);
        if (reuse) {
          reuse.setActive(true).setVisible(true);
          reuse.x = x;
          reuse.y = y;
          return reuse;
        }

        if (children.length >= maxSize) return null;
        const child = spawn(x, y);
        children.push(child);
        return child;
      },
    };
  };

  return {
    add: {
      graphics:  () => mockGraphics,
      rectangle: (x = 0, y = 0, width = 0, height = 0) => Object.assign(mockGameObject(), {
        x, y, width, height, displayWidth: width, displayHeight: height,
      }),
      circle:    (x = 0, y = 0, radius = 0) => Object.assign(mockGameObject(), {
        x, y, width: radius * 2, height: radius * 2, displayWidth: radius * 2, displayHeight: radius * 2,
      }),
      triangle:  (x = 0, y = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0) => Object.assign(mockGameObject(), {
        x,
        y,
        width: Math.max(x1, x2, x3) - Math.min(x1, x2, x3),
        height: Math.max(y1, y2, y3) - Math.min(y1, y2, y3),
        displayWidth: Math.max(x1, x2, x3) - Math.min(x1, x2, x3),
        displayHeight: Math.max(y1, y2, y3) - Math.min(y1, y2, y3),
      }),
      image:     (x = 0, y = 0, texture = '') => Object.assign(mockGameObject(), { x, y, texture }),
      text:      () => {
        const text = mockGameObject();
        text.style = {
          values: {},
          setStyle(style = {}) {
            this.values = { ...this.values, ...style };
          },
        };
        text.setStyle = (style = {}) => {
          text.style.setStyle(style);
          return text;
        };
        return text;
      },
      particles: () => {
        const emitter = mockGameObject();
        emitter.explode = () => {};
        emitter.destroy = function() { this.active = false; };
        return emitter;
      },
      existing:  () => {},
    },
    physics: {
      add: {
        existing: (obj) => {
          obj.body = makeMockBody();
          obj.body.gameObject = obj;
        },
        group:    (cfg) => createMockGroup(cfg),
        overlap:  () => {},
      },
    },
    tweens: {
      add: () => {},
      killTweensOf: () => {},
    },
    time: {
      delayedCall: () => {},
      addEvent:    () => ({ remove: () => {} }),
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
        addKey: () => ({ isDown: false }),
        on:     () => {},
        once:   () => {},
      },
    },
    scene:  { start: () => {} },
    events: { emit: () => {}, on: () => {}, off: () => {} },
  };
}
