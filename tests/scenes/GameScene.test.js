import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { GAME_CONFIG } = await import('../../config/game.config.js');
const { RunState } = await import('../../systems/RunState.js');
const { MetaProgression } = await import('../../systems/MetaProgression.js');
const { EVENTS } = await import('../../config/events.config.js');
const { LEVELS } = await import('../../config/levels.config.js');
const { EffectsSystem } = await import('../../systems/EffectsSystem.js');
const { resolveStats } = await import('../../systems/WaveSpawner.js');
const { Skirm } = await import('../../entities/enemies/Skirm.js');
const { Mine } = await import('../../entities/enemies/Mine.js');
const { Raptor } = await import('../../entities/enemies/Raptor.js');
const {
  GameScene,
  isHeatWarningActive,
  resolveHeatBarStyle,
} = await import('../../scenes/GameScene.js');
const { ENEMY_LEARNING_CONFIG } = await import('../../config/enemyLearning.config.js');
const SKIRM_STATS = resolveStats('skirm', 1.0, 1.0, {});
const MINE_STATS = resolveStats('mine', 1.0, 1.0, {});
const RAPTOR_STATS = resolveStats('raptor', 1.0, 1.0, {});

function createLocalStorageMock(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function createDancePolicyStub() {
  return {
    _encoder: {
      buildSample(sample) {
        return sample;
      },
      encodeSample() {
        return { vector: new Array(33).fill(0) };
      },
    },
    load() {},
    getDanceNetwork() {
      return {
        predict() {
          return {
            mode: 'press',
            confidence: 0.78,
            probabilities: [0.04, 0.78, 0.08, 0.05, 0.05],
          };
        },
      };
    },
    getModifiers() {
      return {
        enabled: false,
        minSpeedScalar: 1,
        maxSpeedScalar: 1,
        sampleCount: 0,
        predictedEnemyWinRate: 0.5,
        predictedSurvival: 0.5,
        predictedPressure: 0.5,
        predictedCollisionRisk: 0.5,
        predictedBulletRisk: 0.5,
      };
    },
    createRunSession() {
      return {
        update() {},
        destroy() {},
      };
    },
  };
}

function createHeatWarningScene(heatShots) {
  const calls = [];
  const scene = new GameScene();
  scene._weapons = {
    heatShots,
    maxHeatShots: GAME_CONFIG.PLAYER_HEAT_MAX,
  };
  scene.cameras = {
    main: {
      shake: (duration, intensity, force) => {
        calls.push({ type: 'shake', duration, intensity, force });
      },
      stopShake: () => {
        calls.push({ type: 'stopShake' });
      },
    },
  };
  scene._heatWarningActive = false;
  scene._nextHeatWarningShakeAt = 0;
  return { scene, calls };
}

beforeEach(() => {
  RunState.reset();
});

describe('GameScene create', () => {
  it('creates the player from the spacecraft1 sprite', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());

    const player = scene._createPlayer();

    assert.equal(player.texture, 'spacecraft1');
    assert.equal(player.displayWidth, 34);
    assert.equal(player.displayHeight, 42);
    assert.equal(player.x, GAME_CONFIG.WIDTH / 2);
    assert.equal(player.y, GAME_CONFIG.HEIGHT - 80);
    assert.ok(player.body, 'player should get an Arcade body');
  });

  it('creates the bonus system before wiring bonus overlaps', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());

    const overlapCalls = [];
    scene.physics.add.overlap = (...args) => {
      overlapCalls.push(args);
    };

    scene.create();

    assert.ok(scene._bonuses, 'bonus system should be created during scene setup');
    assert.ok(
      overlapCalls.some(([, target, callback]) => target === scene._bonuses.group && callback === scene._onBulletHitBonus),
      'player bullets should overlap bonus pickups'
    );
    assert.ok(
      overlapCalls.some(([, target, callback]) => target === scene._bonuses.group && callback === scene._onPlayerCollectBonus),
      'player ship should overlap bonus pickups'
    );
  });

  it('applies permanent bought hp and shield bonuses when a new run starts', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());

    const originalGetStartingBonuses = MetaProgression.getStartingBonuses;
    MetaProgression.getStartingBonuses = () => ({ hp: 50, shield: 50 });

    try {
      scene.create();

      assert.equal(scene._startingPlayerHp, 60);
      assert.equal(scene._startingPlayerShield, 50);
      assert.equal(scene._playerHp, 60);
      assert.equal(scene._playerShield, 50);
    } finally {
      MetaProgression.getStartingBonuses = originalGetStartingBonuses;
    }
  });

  it('wires adaptive model metadata into the spawner stats resolver', () => {
    const enemyAdaptivePolicy = {
      _encoder: {
        buildSample(sample) {
          return sample;
        },
        encodeSample() {
          return { vector: new Array(33).fill(0) };
        },
      },
      load() {},
      getDanceNetwork() {
        return {
          predict() {
            return {
              mode: 'hold',
              confidence: 0.6,
              probabilities: [0.6, 0.1, 0.1, 0.1, 0.1],
            };
          },
        };
      },
      getModifiers(enemyType) {
        return {
          enabled: enemyType === 'skirm',
          minSpeedScalar: enemyType === 'skirm' ? 0.9 : 1,
          maxSpeedScalar: enemyType === 'skirm' ? 1.25 : 1,
          predictedEnemyWinRate: 0.61,
          predictedPressure: 0.57,
          predictedCollisionRisk: 0.22,
          predictedBulletRisk: 0.19,
        };
      },
      createRunSession() {
        return {
          update() {},
          destroy() {},
        };
      },
      resolveBehavior() { return null; },
      getSpeedCandidates() { return [0.9, 1, 1.25]; },
      getPositionOffsets() { return [-1, 0, 1]; },
    };
    const scene = new GameScene({ enemyAdaptivePolicy });
    Object.assign(scene, createMockScene());

    scene.create();

    const adaptedStats = scene._spawner._statsResolver({
      type: 'skirm',
      difficultyBase: 1,
      difficultyFactor: 1,
      planeOverrides: {},
    });

    assert.equal(adaptedStats.speed, SKIRM_STATS.speed);
    assert.equal(adaptedStats.adaptive.minSpeedScalar, 0.9);
    assert.equal(adaptedStats.adaptive.maxSpeedScalar, 1.25);
    assert.equal(adaptedStats.adaptive.predictedCollisionRisk, 0.22);
  });

  it('loads persisted enemy learning from browser storage when a new game starts', async () => {
    const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    const previousLocalStorage = globalThis.localStorage;
    const { ENEMY_LEARNING_STORAGE_KEY } = await import('../../systems/ml/EnemyLearningStore.js');

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: createLocalStorageMock(),
    });

    globalThis.localStorage.setItem(ENEMY_LEARNING_STORAGE_KEY, JSON.stringify({
      featureVersion: ENEMY_LEARNING_CONFIG.featureVersion,
      enemyModels: {
        skirm: {
          winModel: { weights: [], bias: 0 },
          survivalModel: { weights: [], bias: 0 },
          pressureModel: { weights: [], bias: 0 },
          collisionModel: { weights: [], bias: 0 },
          bulletModel: { weights: [], bias: 0 },
          sampleCount: 3,
          lastScores: {
            win: 0.61,
            survival: 0.55,
            pressure: 0.52,
            collision: 0.28,
            bullet: 0.31,
          },
        },
      },
    }));

    try {
      const scene = new GameScene();
      Object.assign(scene, createMockScene());

      scene.create();

      const adaptedStats = scene._spawner._statsResolver({
        type: 'skirm',
        difficultyBase: 1,
        difficultyFactor: 1,
        planeOverrides: {},
      });

      assert.equal(adaptedStats.speed, SKIRM_STATS.speed);
      assert.equal(adaptedStats.adaptive.sampleCount, 3);
      assert.equal(adaptedStats.adaptive.predictedEnemyWinRate, 0.61);
      assert.equal(adaptedStats.adaptive.predictedCollisionRisk, 0.28);

      scene._spawnEnemy('skirm', 140, 80, adaptedStats, 'straight', {});
      const spawned = scene._enemies.at(-1);
      assert.equal(spawned.adaptiveProfile.minSpeedScalar, 0.9);
      assert.equal(spawned.adaptiveProfile.maxSpeedScalar, 1.15);
      assert.equal(spawned.adaptiveProfile.predictedEnemyWinRate, 0.61);
    } finally {
      if (hadLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          writable: true,
          value: previousLocalStorage,
        });
      } else {
        delete globalThis.localStorage;
      }
    }
  });

  it('generates runtime waves before building the spawner when starting directly on level 2', () => {
    const scene = new GameScene({
      enemyAdaptivePolicy: createDancePolicyStub(),
    });
    Object.assign(scene, createMockScene());
    RunState.reset();
    RunState.level = 2;

    try {
      scene.create();

      assert.equal(scene._levelIndex, 1);
      assert.ok(scene._spawner._levelConfig.waves.length > 0);
      assert.ok(scene._spawner._levelConfig.waves.every((wave) => (
        Array.isArray(wave.squadrons) && wave.squadrons.length >= 1
      )));
    } finally {
      RunState.reset();
    }
  });

  it('honors the ?level2=1 debug flag for a fresh direct Level 2 start', () => {
    const scene = new GameScene({
      enemyAdaptivePolicy: createDancePolicyStub(),
    });
    Object.assign(scene, createMockScene());

    const previousLocation = globalThis.location;
    const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');

    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { search: '?level2=1' },
    });

    try {
      RunState.reset();
      scene.create();

      assert.equal(scene._levelIndex, 1);
      assert.equal(RunState.level, 2);
      assert.ok(scene._spawner._levelConfig.waves.length > 0);
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

  it('restores hp, shield, weapon state, and active cooling bonuses when continuing into the next level', () => {
    RunState.beginNewRun({ level: 2, lives: 2 });
    RunState.score = 840;
    RunState.kills = 11;
    RunState.savePlayerState({
      hp: 37,
      shield: 64,
      coolingBoostRemainingMs: 5000,
      weaponState: {
        slots: ['tLaser', null],
        cooldown: 220,
        heatShots: 6,
        isOverheated: true,
        heatRecoveryStepMs: 50,
        primaryDamageMultiplier: 2,
      },
    });

    const scene = new GameScene({
      enemyAdaptivePolicy: createDancePolicyStub(),
    });
    Object.assign(scene, createMockScene());

    try {
      scene.create();

      assert.equal(scene._levelIndex, 1);
      assert.equal(scene._playerLives, 2);
      assert.equal(scene._playerHp, 37);
      assert.equal(scene._playerShield, 64);
      assert.equal(scene._coolingBoostEndsAt, 5000);
      assert.equal(scene._weapons.primaryWeaponKey, 'tLaser');
      assert.equal(scene._weapons.primaryDamageMultiplier, 2);
      assert.equal(scene._weapons.heatRecoveryStepMs, 50);
      assert.equal(scene._weapons.isOverheated, true);
      assert.equal(RunState.score, 840);
      assert.equal(RunState.kills, 11);
      assert.equal(RunState.hasPlayerState(), false);
    } finally {
      RunState.reset();
    }
  });

  it('keeps the spacecraft sprite at its configured size when rubber-band animation is idle', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._player = scene._createPlayer();
    scene._cursors = {
      up: { isDown: false },
      down: { isDown: false },
    };
    scene._wasd = {
      up: { isDown: false },
      down: { isDown: false },
    };
    scene._rbOffset = 0;
    scene._rbVel = 0;

    scene._updateRubberBand(16);

    assert.equal(scene._player.displayWidth, 34);
    assert.equal(scene._player.displayHeight, 42);
  });

  it('adds a layered parallax drift to the fighter visuals while moving sideways', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._player = scene._createPlayer();
    scene._playerSpeed = GAME_CONFIG.PLAYER_SPEED_DEFAULT;
    scene._player.body.velocity.x = GAME_CONFIG.PLAYER_SPEED;
    scene._player.body.velocity.y = 0;

    scene._updatePlayerParallax(100);

    assert.equal(scene._player.rotation, 0);
    assert.ok(scene._playerShadow.x > scene._player.x);
    assert.ok(scene._playerHighlight.x > scene._player.x);
    assert.ok(scene._playerShadow.x > scene._playerHighlight.x);
  });

  it('can jump straight to the ending flow with the debugEnd query flag', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());

    const delayedCalls = [];
    scene.time.delayedCall = (delay, callback) => {
      delayedCalls.push({ delay, callback });
      return { remove: () => {} };
    };

    let levelClearCalls = 0;
    scene._onLevelClear = () => {
      levelClearCalls += 1;
    };

    const previousLocation = globalThis.location;
    const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location');

    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { search: '?debugEnd=1' },
    });

    try {
      scene.create();

      assert.equal(
        delayedCalls.some(({ delay }) => delay === 2000),
        false,
        'normal enemy spawning should be skipped in ending debug mode'
      );

      const debugEndCall = delayedCalls.find(({ delay }) => delay === 250);
      assert.ok(debugEndCall, 'debug ending mode should schedule the level-clear flow');

      debugEndCall.callback();
      assert.equal(levelClearCalls, 1);
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
    }
  });

});

describe('isHeatWarningActive', () => {
  it('returns false below the warning threshold', () => {
    assert.equal(
      isHeatWarningActive(
        GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO - 0.01,
        GAME_CONFIG.PLAYER_HEAT_MAX
      ),
      false
    );
  });

  it('returns true at the warning threshold', () => {
    assert.equal(
      isHeatWarningActive(
        GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO,
        GAME_CONFIG.PLAYER_HEAT_MAX
      ),
      true
    );
  });
});

describe('resolveHeatBarStyle', () => {
  it('keeps the heat bar red and fully opaque below the warning threshold', () => {
    const style = resolveHeatBarStyle(
      GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO - 0.01,
      GAME_CONFIG.PLAYER_HEAT_MAX,
      0
    );

    assert.equal(style.color, 0xff3300);
    assert.equal(style.alpha, 1);
  });

  it('turns the heat bar yellow and blinks once the warning threshold is reached', () => {
    const heatShots = GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO;
    const bright = resolveHeatBarStyle(heatShots, GAME_CONFIG.PLAYER_HEAT_MAX, 0);
    const dim = resolveHeatBarStyle(
      heatShots,
      GAME_CONFIG.PLAYER_HEAT_MAX,
      GAME_CONFIG.PLAYER_HEAT_WARNING_BLINK_MS
    );

    assert.equal(bright.color, 0xffdd33);
    assert.equal(bright.alpha, 1);
    assert.equal(dim.color, 0xffdd33);
    assert.equal(dim.alpha, 0.3);
  });
});

describe('GameScene heat warning shake', () => {
  it('starts a fast camera shake while heat is in the warning zone', () => {
    const { scene, calls } = createHeatWarningScene(
      GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO
    );

    scene._updateHeatWarningShake(1000);

    assert.equal(scene._heatWarningActive, true);
    assert.deepEqual(calls, [{
      type: 'shake',
      duration: GAME_CONFIG.PLAYER_HEAT_WARNING_SHAKE_MS,
      intensity: GAME_CONFIG.PLAYER_HEAT_WARNING_SHAKE_INTENSITY,
      force: true,
    }]);
    assert.equal(scene._nextHeatWarningShakeAt, 1000 + GAME_CONFIG.PLAYER_HEAT_WARNING_SHAKE_MS);
  });

  it('stops the camera shake once heat drops back below the warning zone', () => {
    const { scene, calls } = createHeatWarningScene(
      GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO
    );

    scene._updateHeatWarningShake(1000);
    scene._weapons.heatShots = GAME_CONFIG.PLAYER_HEAT_MAX * GAME_CONFIG.PLAYER_HEAT_WARNING_RATIO - 0.01;
    scene._updateHeatWarningShake(1020);

    assert.equal(scene._heatWarningActive, false);
    assert.deepEqual(calls.at(-1), { type: 'stopShake' });
  });

  it('adds a short extra punch when a hot twin-laser shot fires', () => {
    const { scene, calls } = createHeatWarningScene(0);

    scene._playPlayerShotFeedback({
      warningShot: true,
      shotShakeMs: 24,
      shotShakeIntensity: 0.0018,
    });

    assert.deepEqual(calls, [{
      type: 'shake',
      duration: 24,
      intensity: 0.0018,
      force: true,
    }]);
  });

  it('does not add the hot-shot punch for normal laser shots', () => {
    const { scene, calls } = createHeatWarningScene(0);

    scene._playPlayerShotFeedback({
      warningShot: false,
      shotShakeMs: 24,
      shotShakeIntensity: 0.0018,
    });

    assert.deepEqual(calls, []);
  });
});

describe('GameScene bullet damage', () => {
  it('uses the shared hot-shot payload when a warning beam hits an enemy', () => {
    const scene = new GameScene();
    let hitDamage = 0;
    let hitOptions = null;
    let hiddenBullet = null;
    const enemy = {
      alive: true,
      takeDamage: (damage, options) => {
        hitDamage = damage;
        hitOptions = options;
      },
    };
    const shotPayload = {
      damage: 12,
      hitEnemies: new Set(),
      scoreMultiplier: 1.2,
    };
    const bullet = {
      _damage: 12,
      _scoreMultiplier: 1.2,
      _shotPayload: shotPayload,
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: (target) => {
          hiddenBullet = target;
        },
      },
    };

    scene._onBulletHitEnemy(bullet, enemy);

    assert.equal(hiddenBullet, bullet);
    assert.equal(hitDamage, 12);
    assert.deepEqual(hitOptions, {
      scoreMultiplier: 1.2,
      cause: 'player_bullet',
    });
    assert.ok(shotPayload.hitEnemies.has(enemy));
    assert.equal(bullet.body.enable, false);
  });

  it('does not let the sister warning beam hit the same enemy twice', () => {
    const scene = new GameScene();
    let hitCount = 0;
    const enemy = {
      alive: true,
      takeDamage: () => { hitCount++; },
    };
    const shotPayload = {
      damage: 12,
      hitEnemies: new Set([enemy]),  // enemy already recorded as hit
      scoreMultiplier: 1.2,
    };
    const bullet = {
      _damage: 12,
      _scoreMultiplier: 1.2,
      _shotPayload: shotPayload,
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: () => {},
      },
    };

    scene._onBulletHitEnemy(bullet, enemy);

    assert.equal(hitCount, 0);
  });

  it('lets a player laser destroy an enemy laser before it reaches the player', () => {
    const scene = new GameScene();
    let hiddenBullet = null;
    let playerHit = false;
    const playerBullet = {
      active: true,
      x: 220,
      y: 180,
      texture: 'bullet_laser',
      body: {
        enable: true,
        stop: () => {},
      },
    };
    const enemyBullet = {
      active: true,
      x: 220,
      y: 180,
      width: 3,
      height: 10,
      displayWidth: 3,
      displayHeight: 10,
      destroy() {
        this.active = false;
      },
    };

    scene._gameOver = false;
    scene._respawning = false;
    scene._bg = { update: () => {} };
    scene._movePlayer = () => {};
    scene._updateRubberBand = () => {};
    scene._updateHeatWarningShake = () => {};
    scene._drawStatusBars = () => {};
    scene._spawner = { update: () => {}, isWaveActive: false, pendingSquadrons: 0 };
    scene._bonuses = { update: () => {} };
    scene._enemies = [];
    scene._player = { x: 220, y: 520 };
    scene._space = { isDown: false };
    scene._eBullets = [enemyBullet];
    scene._weapons = {
      damage: 10,
      update: () => {},
      tryFire: () => false,
      pool: {
        getChildren: () => [playerBullet],
        killAndHide: (target) => {
          hiddenBullet = target;
          target.active = false;
          target.visible = false;
        },
      },
    };
    scene._onPlayerHit = () => {
      playerHit = true;
    };

    scene.update(0, 16);

    assert.equal(hiddenBullet, playerBullet);
    assert.equal(playerBullet.body.enable, false);
    assert.equal(enemyBullet.active, false);
    assert.equal(scene._eBullets.length, 0);
    assert.equal(playerHit, false);
  });

  it('lets a player laser cancel a Raptor beam even when the crossing happens between frames', () => {
    const scene = new GameScene();
    let hiddenBullet = null;
    let playerHit = false;
    const playerBullet = {
      active: true,
      x: 220,
      y: 165,
      texture: 'bullet_laser',
      body: {
        enable: true,
        velocity: { x: 0, y: -625 },
        stop: () => {},
      },
    };
    const enemyBullet = {
      active: true,
      x: 220,
      y: 180,
      _vx: 0,
      _vy: 0,
      _hitboxWidth: 22,
      _hitboxHeight: 7,
      destroy() {
        this.active = false;
      },
    };

    scene._gameOver = false;
    scene._respawning = false;
    scene._bg = { update: () => {} };
    scene._movePlayer = () => {};
    scene._updateRubberBand = () => {};
    scene._updateHeatWarningShake = () => {};
    scene._drawStatusBars = () => {};
    scene._spawner = { update: () => {}, isWaveActive: false, pendingSquadrons: 0 };
    scene._bonuses = { update: () => {} };
    scene._enemies = [];
    scene._player = { x: 220, y: 520 };
    scene._space = { isDown: false };
    scene._weapons = {
      update: () => {},
      tryFire: () => false,
      pool: {
        getChildren: () => [playerBullet],
        killAndHide: (bullet) => {
          hiddenBullet = bullet;
          bullet.active = false;
        },
      },
    };
    scene._eBullets = [enemyBullet];
    scene._onPlayerHit = () => { playerHit = true; };

    scene.update(0, 16);

    assert.equal(hiddenBullet, playerBullet);
    assert.equal(enemyBullet.active, false);
    assert.equal(scene._eBullets.length, 0);
    assert.equal(playerHit, false);
  });

  it('spawns an enemy laser with the configured damage, size, and trajectory', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._eBullets = [];
    scene._onEnemyFire({ x: 120, y: 90, vx: 80, vy: 160, damage: 14, width: 9, height: 24 });

    assert.equal(scene._eBullets.length, 1);
    const bullet = scene._eBullets[0];
    assert.equal(bullet._damage, 14);
    assert.equal(bullet._vx, 80);
    assert.equal(bullet._vy, 160);
    assert.equal(bullet.x, 120);
    assert.equal(bullet.y, 90);
    assert.equal(bullet.displayWidth, 9);
    assert.equal(bullet.displayHeight, 24);
    assert.ok(Math.abs(bullet.rotation - (Math.atan2(160, 80) - Math.PI / 2)) < 0.0001);
    assert.ok(bullet._hitboxWidth > 17);
    assert.ok(bullet._hitboxHeight > 20);
  });

  it('moves enemy lasers with their own vx/vy and culls them when they leave any screen edge', () => {
    const scene = new GameScene();
    scene._gameOver = false;
    scene._respawning = false;
    scene._bg = { update: () => {} };
    scene._movePlayer = () => {};
    scene._updateRubberBand = () => {};
    scene._updateHeatWarningShake = () => {};
    scene._drawStatusBars = () => {};
    scene._spawner = { update: () => {}, isWaveActive: false, pendingSquadrons: 0 };
    scene._bonuses = { update: () => {} };
    scene._enemies = [];
    scene._player = { x: 20, y: 20 };
    scene._space = { isDown: false };
    scene._weapons = {
      update: () => {},
      tryFire: () => false,
      pool: { getChildren: () => [] },
    };
    scene._onPlayerHit = () => {};

    const enemyBullet = {
      active: true,
      x: 100,
      y: 100,
      width: 9,
      height: 24,
      displayWidth: 9,
      displayHeight: 24,
      _vx: 60,
      _vy: 120,
      destroy() {
        this.active = false;
      },
    };
    scene._eBullets = [enemyBullet];

    scene.update(0, 1000);

    assert.equal(enemyBullet.x, 160);
    assert.equal(enemyBullet.y, 220);
    assert.equal(scene._eBullets.length, 1);

    scene.update(1000, 4000);

    assert.equal(enemyBullet.active, false);
    assert.equal(scene._eBullets.length, 0);
  });

  it('enemy laser overflow reaches player hp after the shield absorbs what it can', () => {
    const scene = new GameScene();
    let playerHitDamage = null;
    const enemyBullet = {
      active: true,
      x: 220,
      y: 520,
      width: 3,
      height: 10,
      displayWidth: 3,
      displayHeight: 10,
      _damage: 17,
      destroy() {
        this.active = false;
      },
    };

    scene._gameOver = false;
    scene._respawning = false;
    scene._bg = { update: () => {} };
    scene._movePlayer = () => {};
    scene._updateRubberBand = () => {};
    scene._updateHeatWarningShake = () => {};
    scene._drawStatusBars = () => {};
    scene._spawner = { update: () => {}, isWaveActive: false, pendingSquadrons: 0 };
    scene._bonuses = { update: () => {} };
    scene._enemies = [];
    scene._player = { x: 220, y: 520 };
    scene._space = { isDown: false };
    scene._eBullets = [enemyBullet];
    scene._weapons = {
      update: () => {},
      tryFire: () => false,
      pool: { getChildren: () => [] },
    };
    scene._onPlayerHit = (damage) => {
      playerHitDamage = damage;
    };

    scene.update(0, 16);

    assert.equal(playerHitDamage, 17);
    assert.equal(enemyBullet.active, false);
    assert.equal(scene._eBullets.length, 0);
  });
});

describe('GameScene enemy spawning', () => {
  it('creates a Mine instance and binds its gravity well when the spawner requests one', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._player = { x: 220, y: 520, active: true };
    scene._enemies = [];
    scene._enemyGroup = { add: () => {} };

    let gravityCall = null;
    scene._effects = {
      createGravityWell: (source, target, opts) => {
        gravityCall = { source, target, opts };
        return { update: () => {}, destroy: () => {} };
      },
    };

    scene._spawnEnemy('mine', 180, -40, MINE_STATS, 'creep_drop', { overlay: true, waveId: 4 });

    assert.equal(scene._enemies.length, 1);
    assert.ok(scene._enemies[0] instanceof Mine);
    assert.equal(scene._enemies[0].displayWidth, 28);
    assert.equal(scene._enemies[0].displayHeight, 28);
    assert.equal(scene._enemies[0]._overlayRaid, true);
    assert.equal(scene._enemies[0]._spawnWaveId, 4);
    assert.equal(gravityCall.source, scene._enemies[0]);
    assert.equal(gravityCall.target, scene._player);
    assert.equal(gravityCall.opts.power, 14);
    assert.equal(gravityCall.opts.gravity, 360);
  });

  it('creates a Raptor instance when the spawner requests one', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._enemies = [];
    scene._enemyGroup = { add: () => {} };

    scene._spawnEnemy('raptor', 140, -60, RAPTOR_STATS, 'side_left', { overlay: true, waveId: 3 });

    assert.equal(scene._enemies.length, 1);
    assert.ok(scene._enemies[0] instanceof Raptor);
    assert.equal(scene._enemies[0].displayWidth, 40);
    assert.equal(scene._enemies[0].displayHeight, 32);
    assert.equal(scene._enemies[0]._overlayRaid, true);
    assert.equal(scene._enemies[0]._spawnWaveId, 3);
  });

  it('primes squad-member fire cooldown from spawn metadata so skirm volleys are phased, not all cold-started', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._enemies = [];
    scene._enemyGroup = { add: () => {} };

    scene._spawnEnemy('skirm', 140, -40, SKIRM_STATS, 'straight', {
      squadSize: 4,
      squadIndex: 2,
    });

    const spawned = scene._enemies[0];
    assert.equal(spawned._squadSpawnCount, 4);
    assert.equal(spawned._squadSpawnIndex, 2);
    assert.equal(spawned._fireCooldown, Math.round(SKIRM_STATS.fireRate * (2 / 4)));
  });

  it('prefers enemy-specific contact damage in the shared enemy-touch path', () => {
    const scene = new GameScene();
    let playerDamage = 0;
    let died = null;
    const mine = {
      alive: true,
      damage: 10,
      contactDamage: 200,
      die: (opts) => { died = opts; },
    };

    scene._onPlayerHit = (damage) => { playerDamage = damage; };
    scene._onEnemyTouchPlayer(scene._player, mine);

    assert.equal(playerDamage, 200);
    assert.equal(died.cause, 'player_collision');
  });

  it('colliding with a real Mine damages the player and triggers the mine blast route', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    let playerDamage = 0;
    const blastTypes = [];

    scene._player = { x: 220, y: 520, active: true };
    scene._effects = {
      createGravityWell: () => ({ update: () => {}, destroy: () => {} }),
    };
    scene._animateScore = () => {};
    scene._explodeForType = (x, y, type) => {
      blastTypes.push(type);
    };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };
    scene._onPlayerHit = (damage) => {
      playerDamage = damage;
    };

    const mine = new Mine(scene, 180, 220, MINE_STATS, 'creep_drop');
    scene._onEnemyTouchPlayer(scene._player, mine);

    assert.equal(playerDamage, MINE_STATS.contactDamage);
    assert.equal(mine.alive, false);
    assert.deepEqual(blastTypes, ['mine']);
  });

  it('does not silently cull a persistent enemy when it drifts beyond the normal bounds', () => {
    const scene = new GameScene();
    scene._gameOver = false;
    scene._respawning = false;
    scene._bg = { update: () => {} };
    scene._movePlayer = () => {};
    scene._updateRubberBand = () => {};
    scene._updateHeatWarningShake = () => {};
    scene._drawStatusBars = () => {};
    scene._spawner = { update: () => {}, isWaveActive: false, pendingSquadrons: 0 };
    scene._bonuses = { update: () => {} };
    scene._player = { x: 20, y: 20 };
    scene._space = { isDown: false };
    scene._eBullets = [];
    scene._weapons = {
      update: () => {},
      tryFire: () => false,
      pool: { getChildren: () => [] },
    };
    scene._enemyGroup = { remove: () => {} };

    const enemy = {
      active: true,
      x: GAME_CONFIG.WIDTH + 140,
      y: 220,
      _persistUntilDestroyed: true,
      updateCalled: 0,
      update() {
        this.updateCalled += 1;
      },
    };
    scene._enemies = [enemy];

    scene.update(0, 16);

    assert.equal(scene._enemies.length, 1);
    assert.equal(enemy.updateCalled, 1);
  });

  it('ignores overlay squadron spawns for the main wave checkpoint flow', () => {
    const scene = new GameScene();
    scene._squadronScoreCheckpoint = 27;
    scene._enemies = [];
    scene._formations = [];

    scene._onSquadronSpawned({
      overlay: true,
      count: 2,
      squadron: {
        dance: 'side_left',
        controller: {},
      },
    });

    assert.equal(scene._squadronScoreCheckpoint, 27);
    assert.equal(scene._formations.length, 0);
  });

  it('advances the main wave even while only overlay raid enemies remain alive', () => {
    const scene = new GameScene();
    let waveCleared = 0;
    scene._gameOver = false;
    scene._respawning = false;
    scene._bg = { update: () => {} };
    scene._movePlayer = () => {};
    scene._updateRubberBand = () => {};
    scene._updateHeatWarningShake = () => {};
    scene._drawStatusBars = () => {};
    scene._bonuses = { update: () => {} };
    scene._player = { x: 20, y: 20 };
    scene._space = { isDown: false };
    scene._eBullets = [];
    scene._weapons = {
      update: () => {},
      tryFire: () => false,
      pool: { getChildren: () => [] },
    };
    scene._spawner = {
      update: () => {},
      isWaveActive: true,
      pendingMainSquadrons: 0,
      onWaveCleared: () => { waveCleared += 1; },
    };
    scene._enemies = [
      {
        active: true,
        _overlayRaid: true,
        update: () => {},
      },
    ];
    scene._enemyGroup = { remove: () => {} };

    scene.update(0, 16);

    assert.equal(waveCleared, 1);
  });
});

describe('GameScene enemy score awards', () => {
  it('applies the killing shot score multiplier to the awarded score', () => {
    RunState.reset();
    const scene = new GameScene();
    scene._explodeForType = () => {};
    scene._animateScore = () => {};

    scene._onEnemyDied({ x: 0, y: 0, type: 'skirm', score: 10, scoreMultiplier: 1.4 });

    assert.equal(RunState.score, 14);
    assert.equal(RunState.kills, 1);
  });

  it('awards the hotter kill score through the real bullet-hit to enemy-death path', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: () => {},
      },
    };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, SKIRM_STATS, 'straight');
    const bullet = {
      _damage: 11,
      _scoreMultiplier: 1.1,
      _shotPayload: {
        damage: 11,
        scoreMultiplier: 1.1,
        hitEnemies: new Set(),
      },
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._onBulletHitEnemy(bullet, skirm);

    assert.equal(RunState.score, 55);
    assert.equal(RunState.kills, 1);
  });

  it('uses the killing shot multiplier for score even after earlier hot damage', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: () => {},
      },
    };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, { ...SKIRM_STATS, hp: 10 }, 'straight');
    const hotBullet = {
      _damage: 5,
      _scoreMultiplier: 1.2,
      _shotPayload: {
        damage: 5,
        scoreMultiplier: 1.2,
        hitEnemies: new Set(),
      },
      body: {
        enable: true,
        stop: () => {},
      },
    };
    const normalBullet = {
      _damage: 5,
      _scoreMultiplier: 1,
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._onBulletHitEnemy(hotBullet, skirm);
    scene._onBulletHitEnemy(normalBullet, skirm);

    assert.equal(RunState.score, 50);
    assert.equal(RunState.kills, 1);
  });

  it('a 1.5× hot bullet (damage=15) kills a 10-HP Skirm and awards 75 points (= round(50 × 1.5))', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = { damage: 10, pool: { killAndHide: () => {} } };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, SKIRM_STATS, 'straight');
    const bullet = {
      _damage: 15,
      _scoreMultiplier: 1.5,
      _shotPayload: { damage: 15, scoreMultiplier: 1.5, hitEnemies: new Set() },
      body: { enable: true, stop: () => {} },
    };

    scene._onBulletHitEnemy(bullet, skirm);

    assert.equal(skirm.hp, 0);
    assert.equal(skirm.alive, false);
    assert.equal(RunState.score, 75);
    assert.equal(RunState.kills, 1);
  });

  it('a 1.5× hot bullet (damage=15) only reduces a 20-HP Skirm to 5 HP — no kill, no score', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._explodeForType = () => {};
    scene._animateScore = () => {};
    scene._weapons = { damage: 10, pool: { killAndHide: () => {} } };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) scene._onEnemyDied(data);
    };

    const skirm = new Skirm(scene, 120, 80, { ...SKIRM_STATS, hp: 20 }, 'straight');
    const bullet = {
      _damage: 15,
      _scoreMultiplier: 1.5,
      _shotPayload: { damage: 15, scoreMultiplier: 1.5, hitEnemies: new Set() },
      body: { enable: true, stop: () => {} },
    };

    scene._onBulletHitEnemy(bullet, skirm);

    assert.equal(skirm.hp, 5);
    assert.equal(skirm.alive, true);
    assert.equal(RunState.score, 0);
    assert.equal(RunState.kills, 0);
  });

  it('tracks the animated HUD score from the current tween value during rapid updates', () => {
    const scene = new GameScene();
    let tweenConfig = null;
    let scoreText = '';
    scene._displayedScore = 0;
    scene._scoreText = {
      setText: (value) => {
        scoreText = value;
      },
    };
    scene.tweens = {
      add: (config) => {
        tweenConfig = config;
        return { stop: () => {} };
      },
    };

    scene._animateScore(55);
    tweenConfig.targets.val = 27.9;
    tweenConfig.onUpdate();

    assert.equal(scene._displayedScore, 27.9);
    assert.equal(scoreText, 'SCORE  27');
  });

  it('pushes a nearby skirm aside when another skirm explodes', () => {
    RunState.reset();
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._effects = new EffectsSystem(scene, { fragmentPoolSize: 4 });
    scene._bonuses = { spawnRandomDrop: () => {} };
    scene._animateScore = () => {};
    scene._eBullets = [];
    scene._enemyGroup = { add: () => {}, remove: () => {} };
    scene._player = { x: 220, y: 520, active: true };

    const dyingSkirm = new Skirm(scene, 100, 100, SKIRM_STATS, 'straight');
    const nearbySkirm = new Skirm(scene, 112, 100, SKIRM_STATS, 'straight');
    scene._enemies = [dyingSkirm, nearbySkirm];

    const startX = nearbySkirm.x;
    scene._onEnemyDied({
      x: dyingSkirm.x,
      y: dyingSkirm.y,
      type: 'skirm',
      vx: 0,
      vy: 0,
      score: 0,
      dropChance: 0,
    });

    assert.ok(nearbySkirm._pushVx > 0, `expected positive blast push, got ${nearbySkirm._pushVx}`);

    nearbySkirm.update(16);

    assert.ok(nearbySkirm.x > startX, 'nearby skirm should be displaced away from the blast');
  });
});

describe('GameScene player explosion', () => {
  it('calls explodePlayer on the effects system and flashes the camera', () => {
    const scene = new GameScene();
    let explodePlayerCalled = false;
    let flashCalled = false;
    scene._effects = {
      explodePlayer: () => { explodePlayerCalled = true; },
    };
    scene.cameras = { main: { flash: () => { flashCalled = true; } } };

    scene._explode(120, 240);

    assert.equal(explodePlayerCalled, true, 'explodePlayer must be called');
    assert.equal(flashCalled, true, 'camera flash must be called');
  });
});

describe('GameScene level clear', () => {
  it('sends the player off-screen with warp stars before showing the level-complete card', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());

    const tweenCalls = [];
    const delayedCalls = [];
    const textCalls = [];
    let warpDuration = null;
    let fadeDuration = null;
    let clearedBonuses = 0;
    let stoppedFormations = 0;
    let destroyedEnemyBullets = 0;
    let removedEnemies = 0;
    const recordedLevelScores = [];
    let sceneStart = null;

    scene.tweens.add = (config) => {
      tweenCalls.push(config);
      return config;
    };
    scene.time.delayedCall = (delay, cb) => {
      delayedCalls.push({ delay, cb });
      return { remove: () => {} };
    };
    scene.add.text = (x, y, value, style) => {
      const text = {
        x,
        y,
        value,
        style,
        setOrigin() { return this; },
        setDepth() { return this; },
      };
      textCalls.push(text);
      return text;
    };
    scene._bg = {
      startWarpExit: (duration) => { warpDuration = duration; },
      fadeToBlack: (duration) => { fadeDuration = duration; },
      update: () => {},
    };
    scene._player = scene.add.image(220, 520, 'spacecraft1');
    scene._playerShadow = scene.add.image(220, 520, 'spacecraft1');
    scene._playerHighlight = scene.add.image(220, 520, 'spacecraft1');
    scene._player.body = {
      enable: true,
      stop() {},
    };
    scene._bonuses = {
      clear: () => { clearedBonuses += 1; },
    };
    scene._formations = [{
      stop: () => { stoppedFormations += 1; },
    }];
    scene._enemyGroup = {
      remove: () => { removedEnemies += 1; },
    };
    scene._enemies = [{
      alive: true,
      setActive() { return this; },
      setVisible() { return this; },
      body: { stop() {} },
      destroy() {},
    }];
    scene._eBullets = [{
      destroy: () => { destroyedEnemyBullets += 1; },
    }];
    scene._levelIndex = 0;
    scene._playerHp = 33;
    scene._playerShield = 48;
    scene._playerLives = 2;
    scene._hudTimeMs = 1200;
    scene._coolingBoostEndsAt = 6200;
    scene._weapons = {
      getPersistentState() {
        return {
          slots: ['tLaser', null],
          cooldown: 140,
          heatShots: 3,
          isOverheated: false,
          heatRecoveryStepMs: 50,
          primaryDamageMultiplier: 2,
        };
      },
    };
    scene.scene = {
      start: (sceneKey, data) => {
        sceneStart = { sceneKey, data };
      },
    };
    RunState.reset();
    RunState.score = 2450;
    const originalRecordCompletedLevel = MetaProgression.recordCompletedLevel;
    MetaProgression.recordCompletedLevel = (score) => {
      recordedLevelScores.push(score);
      return {
        totalScore: score,
        ownedBonuses: { hp: 0, shield: 0 },
      };
    };

    try {
      scene._onLevelClear();

      assert.equal(scene._levelClearing, true);
      assert.equal(warpDuration, 1200);
      assert.equal(scene._player.body.enable, false);
      assert.equal(stoppedFormations, 1);
      assert.equal(clearedBonuses, 1);
      assert.equal(destroyedEnemyBullets, 1);
      assert.equal(removedEnemies, 1);
      assert.equal(tweenCalls.length, 1);
    assert.deepEqual(tweenCalls[0].targets, [scene._player, scene._playerShadow, scene._playerHighlight]);
      assert.ok(tweenCalls[0].y < 0, 'player exit tween should leave the top of the screen');
      assert.equal(textCalls.length, 0, 'the level-complete card should wait until after the exit run-up');

      tweenCalls[0].onComplete();
      assert.equal(scene._player.visible, false);

      delayedCalls[0].cb();
      assert.equal(fadeDuration, 600);
      assert.equal(textCalls[0].value, 'LEVEL COMPLETE');
      assert.equal(textCalls[1].value, 'SCORE  2450');
      assert.deepEqual(RunState.playerState, {
        hp: 33,
        shield: 48,
        coolingBoostRemainingMs: 5000,
        weaponState: {
          slots: ['tLaser', null],
          cooldown: 140,
          heatShots: 3,
          isOverheated: false,
          heatRecoveryStepMs: 50,
          primaryDamageMultiplier: 2,
        },
      });
      assert.equal(delayedCalls[1].delay, 4000);
      delayedCalls[1].cb();
      assert.deepEqual(recordedLevelScores, [2450]);
      assert.equal(RunState.level, 2);
      assert.equal(RunState.lives, 2);
      assert.deepEqual(sceneStart, {
        sceneKey: 'LevelTransitionScene',
        data: {
          levelNumber: 1,
          runScore: 2450,
          returnSceneKey: 'GameScene',
          continueLabel: 'CONTINUE TO LEVEL 2',
        },
      });
    } finally {
      MetaProgression.recordCompletedLevel = originalRecordCompletedLevel;
    }
  });
});

describe('GameScene player death', () => {
  it('resets weapon heat when the player loses a life', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    let drawCalls = 0;
    let weaponHudRedraws = 0;
    let livesText = '';
    let shieldReset = null;
    let weaponReset = false;
    let heatRecoveryReset = false;
    let laserPowerReset = false;

    scene._gameOver = false;
    scene._respawning = false;
    scene._player = scene.add.image(180, 420, 'spacecraft1');
    scene._playerHp = 6;
    scene._playerLives = 2;
    scene._playerShield = 150;
    scene._hudTimeMs = 1200;
    scene._coolingBoostEndsAt = 20000;
    scene._heatCountdownText = {
      visible: true,
      setVisible(value) {
        this.visible = value;
        return this;
      },
      setText() {
        return this;
      },
    };
    scene._playerShieldFx = {
      takeDamage: () => ({ absorbed: 0, overflow: 6 }),
      setPoints: (value) => {
        shieldReset = value;
        scene._playerShield = value;
      },
    };
    scene._weapons = {
      heatShots: 17,
      maxHeatShots: GAME_CONFIG.PLAYER_HEAT_MAX,
      resetHeat() {
        this.heatShots = 0;
      },
      resetPrimaryWeapon() {
        weaponReset = true;
      },
      resetHeatRecoveryStepMs() {
        heatRecoveryReset = true;
      },
      resetPrimaryDamageMultiplier() {
        laserPowerReset = true;
      },
    };
    scene._formations = [];
    scene._explode = () => {};
    scene._drawStatusBars = () => {
      drawCalls++;
    };
    scene._drawWeaponDisplay = () => {
      weaponHudRedraws++;
    };
    scene._livesText = {
      setText: (value) => {
        livesText = value;
      },
    };
    scene.events = { emit: () => {} };

    scene._onPlayerHit(6);

    assert.equal(scene._weapons.heatShots, 0);
    assert.equal(shieldReset, GAME_CONFIG.PLAYER_SHIELD_DEFAULT);
    assert.equal(scene._playerShield, GAME_CONFIG.PLAYER_SHIELD_DEFAULT);
    assert.equal(scene._coolingBoostEndsAt, 0);
    assert.equal(scene._heatCountdownText.visible, false);
    assert.equal(heatRecoveryReset, true);
    assert.equal(laserPowerReset, true);
    assert.equal(weaponReset, true);
    assert.equal(weaponHudRedraws, 1);
    assert.equal(scene._playerLives, 1);
    assert.equal(scene._respawning, true);
    assert.equal(livesText, '× 1');
    assert.ok(drawCalls >= 2, 'status bars should redraw after death and reset');
  });

  it('does not record the total score when the player loses the last life', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    let recordedLevelCompletions = 0;

    scene._player = scene.add.image(180, 420, 'spacecraft1');
    scene._player.body = { enable: true };
    scene._formations = [];
    scene._explode = () => {};
    scene._resetPlayerHeat = () => {};
    scene._resetPlayerBonuses = () => {};

    const originalRecordCompletedLevel = MetaProgression.recordCompletedLevel;
    MetaProgression.recordCompletedLevel = () => {
      recordedLevelCompletions += 1;
      return {
        totalScore: RunState.score,
        ownedBonuses: { hp: 0, shield: 0 },
      };
    };

    try {
      scene._killPlayer();
      scene._killPlayer();

      assert.equal(recordedLevelCompletions, 0);
    } finally {
      MetaProgression.recordCompletedLevel = originalRecordCompletedLevel;
    }
  });

  it('trains enemy learning once when the player loses the last life', () => {
    const outcomes = [];
    const scene = new GameScene();
    Object.assign(scene, createMockScene());

    scene._player = scene.add.image(180, 420, 'spacecraft1');
    scene._player.body = { enable: true };
    scene._formations = [];
    scene._explode = () => {};
    scene._resetPlayerHeat = () => {};
    scene._resetPlayerBonuses = () => {};
    scene._enemyAdaptivePolicy = {
      trainFromSession: (_session, outcome) => {
        outcomes.push(outcome);
        return {};
      },
    };
    scene._enemyLearningSession = { destroy() {} };

    scene._killPlayer();
    scene._killPlayer();

    assert.deepEqual(outcomes, ['enemy_win']);
  });

  it('does not crash the end-of-run flow when adaptive training throws', () => {
    const emitted = [];
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene.events = {
      emit: (...args) => emitted.push(args),
    };
    scene._enemyAdaptivePolicy = {
      trainFromSession() {
        throw new Error('training failed');
      },
      getSnapshot() {
        return { enemyModels: {} };
      },
    };
    scene._enemyLearningSession = { destroy() {} };

    assert.doesNotThrow(() => scene._finalizeEnemyLearning('enemy_win'));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0][0], EVENTS.RUN_ENDED);
    assert.equal(emitted[0][1].outcome, 'enemy_win');
  });

  it('immediately trains for Level 2 and saves the player style profile before generating runtime waves', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    const originalLevel2Waves = LEVELS[1].waves;
    const originalRecordCompletedLevel = MetaProgression.recordCompletedLevel;
    const trainCalls = [];
    const generationCalls = [];

    scene._levelIndex = 0;
    scene._playerHp = 24;
    scene._playerShield = 18;
    scene._startingPlayerHp = 24;
    scene._startingPlayerShield = 18;
    scene._playerLives = 2;
    scene._hudTimeMs = 0;
    scene._weapons = {
      getPersistentState() {
        return null;
      },
    };
    scene._enemyLearningSession = { destroy() {} };
    scene._enemyAdaptivePolicy = {
      trainFromSession(_session, outcome, options) {
        trainCalls.push({ outcome, options });
        return {
          playerStyleProfile: {
            laneBiasX: -0.42,
            aggression: 0.5,
            dodgeIntensity: 0.36,
            heatGreed: 0.58,
          },
        };
      },
    };
    scene._danceGenerator = {
      currentProfile: null,
      setPlayerStyleProfile(profile) {
        this.currentProfile = profile;
        return this;
      },
      generateAndInjectWaves(levels, levelIndex, count) {
        generationCalls.push({
          levelIndex,
          count,
          profile: this.currentProfile,
        });
        levels[levelIndex].waves = [{ id: 1, difficultyFactor: 1.2, squadrons: [{ id: 'generated', planes: [{}] }] }];
        return levels[levelIndex].waves;
      },
    };
    scene._bg = {
      fadeToBlack() {},
    };

    try {
      MetaProgression.recordCompletedLevel = () => ({
        totalScore: RunState.score,
        ownedBonuses: { hp: 0, shield: 0 },
      });
      RunState.reset();

      scene._showLevelCompleteCard();

      assert.equal(trainCalls.length, 1);
      assert.equal(trainCalls[0].outcome, 'player_win');
      assert.equal(trainCalls[0].options.immediate, true);
      assert.equal(trainCalls[0].options.nextLevelNumber, 2);
      assert.equal(RunState.level, 2);
      assert.deepEqual(RunState.playerStyleProfile, {
        laneBiasX: -0.42,
        aggression: 0.5,
        dodgeIntensity: 0.36,
        heatGreed: 0.58,
      });
      assert.equal(generationCalls.length, 1);
      assert.equal(generationCalls[0].levelIndex, 1);
      assert.equal(generationCalls[0].count, LEVELS[1].runtimeWaveCount);
      assert.equal(generationCalls[0].profile.laneBiasX, -0.42);
    } finally {
      LEVELS[1].waves = originalLevel2Waves;
      MetaProgression.recordCompletedLevel = originalRecordCompletedLevel;
      RunState.reset();
    }
  });
});

describe('GameScene player shield and bonuses', () => {
  it('lets the shared shield absorb player damage before hp', () => {
    const scene = new GameScene();
    scene._gameOver = false;
    scene._respawning = false;
    scene._playerHp = 20;
    scene._playerShield = 12;
    scene._playerShieldFx = {
      takeDamage: () => ({ absorbed: 8, overflow: 0 }),
    };
    scene.events = { emit: () => {} };
    scene._drawStatusBars = () => {};

    scene._onPlayerHit(8);

    assert.equal(scene._playerHp, 20);
  });

  it('applies a shield bonus through the shared shield controller', () => {
    const scene = new GameScene();
    let addedShield = 0;
    scene._playerShield = 0;
    scene._playerShieldFx = {
      addPoints: (value) => { addedShield += value; },
    };
    scene.events = { emit: () => {} };
    scene._drawStatusBars = () => {};

    scene._applyBonusEffect({ key: 'shield50', kind: 'shield', value: 50 });

    assert.equal(addedShield, 50);
  });

  it('equips a collected T-Laser into weapon 1 and redraws the weapon HUD', () => {
    const scene = new GameScene();
    let equippedWeapon = null;
    let weaponEvent = null;
    let redrawCalls = 0;

    scene._weapons = {
      equipPrimaryWeapon: (weaponKey) => {
        equippedWeapon = weaponKey;
      },
    };
    scene._drawWeaponDisplay = () => {
      redrawCalls++;
    };
    scene._drawStatusBars = () => {};
    scene.events = {
      emit: (event, payload) => {
        weaponEvent = { event, payload };
      },
    };

    scene._applyBonusEffect({
      key: 'tLaser',
      kind: 'newWeapon',
      value: 1,
      label: 'T-LASER',
      weaponKey: 'tLaser',
      pending: false,
    });

    assert.equal(equippedWeapon, 'tLaser');
    assert.equal(redrawCalls, 1);
    assert.deepEqual(weaponEvent, {
      event: EVENTS.WEAPON_CHANGED,
      payload: {
        key: 'tLaser',
        kind: 'newWeapon',
        value: 1,
        label: 'T-LASER',
        weaponKey: 'tLaser',
        pending: false,
        slot: 0,
      },
    });
  });

  it('applies a 30-second cooling boost and shows the countdown next to the heat bar', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    let boostedRecoveryMs = null;
    let resetRecovery = false;

    scene._weaponDisplayY = 594;
    scene._weapons = {
      maxHeatShots: GAME_CONFIG.PLAYER_HEAT_MAX,
      heatShots: 0,
      getSlots: () => [{ key: 'laser', name: 'LASER', color: 0x00ffff, multiplierLabel: '' }, null],
      setHeatRecoveryStepMs: (value) => {
        boostedRecoveryMs = value;
      },
      resetHeatRecoveryStepMs: () => {
        resetRecovery = true;
      },
    };
    scene._playerHp = 10;
    scene._hudTimeMs = 1200;
    scene._buildStatusBars();
    scene.events = { emit: () => {} };

    scene._applyBonusEffect({
      key: 'coolingBoost',
      kind: 'coolingBoost',
      value: 50,
      recoveryMs: 50,
      durationMs: 30000,
    });

    assert.equal(boostedRecoveryMs, 50);
    assert.equal(scene._coolingBoostEndsAt, 31200);
    assert.equal(scene._heatCountdownText.text, '30s');
    assert.equal(scene._heatCountdownText.visible, true);

    scene._updateTimedBonuses(31200);

    assert.equal(resetRecovery, true);
    assert.equal(scene._heatCountdownText.visible, false);
  });

  it('stacks a laser power bonus on weapon 1 and emits the total multiplier', () => {
    const scene = new GameScene();
    let redrawCalls = 0;
    let weaponEvent = null;

    scene._weapons = {
      multiplyPrimaryDamage: () => 4,
    };
    scene._drawWeaponDisplay = () => {
      redrawCalls++;
    };
    scene._drawStatusBars = () => {};
    scene.events = {
      emit: (event, payload) => {
        weaponEvent = { event, payload };
      },
    };

    scene._applyBonusEffect({
      key: 'laserPower2x',
      kind: 'laserPower',
      value: 2,
      multiplier: 2,
      label: 'LASER x2',
      pending: false,
    });

    assert.equal(redrawCalls, 1);
    assert.deepEqual(weaponEvent, {
      event: EVENTS.WEAPON_CHANGED,
      payload: {
        key: 'laserPower2x',
        kind: 'laserPower',
        value: 2,
        multiplier: 2,
        label: 'LASER x2',
        pending: false,
        slot: 0,
        totalMultiplier: 4,
      },
    });
  });

  it('can redraw the weapon HUD after a bonus equip without breaking text styling', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._weapons = {
      getSlots: () => [{ key: 'laser', name: 'LASER', color: 0x00ffff }, null],
    };

    scene._buildWeaponDisplay();

    scene._weapons = {
      getSlots: () => [{ key: 'tLaser', name: 'T-LASER', color: 0x00ffff }, null],
    };

    assert.doesNotThrow(() => scene._drawWeaponDisplay());
    assert.equal(scene._weaponSlotNameTexts[0].text, 'T-LASER');
    assert.equal(scene._weaponSlotNameTexts[0].style.values.fill, '#00ffff');
  });

  it('shows the stacked slot-1 power multiplier in the weapon box using the weapon color', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._weapons = {
      getSlots: () => [{ key: 'laser', name: 'LASER', color: 0x00ffff, multiplierLabel: 'x4' }, null],
    };

    scene._buildWeaponDisplay();

    assert.doesNotThrow(() => scene._drawWeaponDisplay());
    assert.equal(scene._weaponSlotMultiplierTexts[0].text, 'x4');
    assert.equal(scene._weaponSlotMultiplierTexts[0].style.values.fill, '#00ffff');
  });

  it('applies a life bonus to the HUD and run state', () => {
    RunState.reset();
    const scene = new GameScene();
    let livesText = '';
    scene._playerLives = 2;
    scene._livesText = {
      setText: (value) => { livesText = value; },
    };
    scene.events = { emit: () => {} };
    scene._drawStatusBars = () => {};

    scene._applyBonusEffect({ key: 'extraLife', kind: 'life', value: 1 });

    assert.equal(scene._playerLives, 3);
    assert.equal(RunState.lives, 3);
    assert.equal(livesText, '× 3');
  });

  it('keeps only hp and heat in the bottom-left HUD status bars', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    scene._weaponDisplayY = 594;
    scene._weapons = {
      maxHeatShots: GAME_CONFIG.PLAYER_HEAT_MAX,
      heatShots: 0,
      getSlots: () => [{ key: 'laser' }, null],
    };
    scene._playerHp = 10;
    scene._hudTimeMs = 0;

    scene._buildStatusBars();

    assert.deepEqual(Object.keys(scene._barFills), ['hp', 'heat']);
  });

  it('shows a small cooling flame on the heat bar only while weapon cooling is active', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    const particleCalls = [];
    scene.add.particles = (x, y, texture, config) => {
      const emitter = {
        x,
        y,
        texture,
        config,
        visible: true,
        emitting: false,
        setDepth() { return this; },
        setVisible(value) { this.visible = value; return this; },
        setPosition(nextX, nextY) { this.x = nextX; this.y = nextY; return this; },
        start() { this.emitting = true; return this; },
        stop() { this.emitting = false; return this; },
      };
      particleCalls.push(emitter);
      return emitter;
    };
    scene._weaponDisplayY = 594;
    scene._weapons = {
      maxHeatShots: GAME_CONFIG.PLAYER_HEAT_MAX,
      heatShots: 10,
      isCoolingDown: true,
      getSlots: () => [{ key: 'laser' }, null],
    };
    scene._playerHp = 10;
    scene._hudTimeMs = 0;

    scene._buildStatusBars();

    assert.equal(particleCalls.length, 1);
    assert.equal(scene._heatCoolingFx.texture, 'flares');
    assert.equal(scene._heatCoolingFx.config.frame, 'white');
    assert.equal(scene._heatCoolingFx.visible, true);
    assert.equal(scene._heatCoolingFx.emitting, true);

    scene._weapons.isCoolingDown = false;
    scene._drawStatusBars();

    assert.equal(scene._heatCoolingFx.visible, false);
    assert.equal(scene._heatCoolingFx.emitting, false);
  });

  it('does not collect a shielded bonus until the shield is broken', () => {
    const scene = new GameScene();
    let appliedBonus = null;
    let collectCalls = 0;
    const shieldedBonus = {
      canCollect: () => false,
    };

    scene._bonuses = {
      collectBonus: (bonus) => {
        collectCalls++;
        return bonus.canCollect() ? { kind: 'life', value: 1 } : null;
      },
    };
    scene._applyBonusEffect = (payload) => {
      appliedBonus = payload;
    };

    scene._onPlayerCollectBonus({}, shieldedBonus);

    assert.equal(collectCalls, 1);
    assert.equal(appliedBonus, null);
  });

  it('shows a large floating bonus label when the player collects a pickup', () => {
    const scene = new GameScene();
    let effectCall = null;
    let playedSound = null;
    scene._player = { x: 140, y: 560 };
    scene._bonuses = {
      collectBonus: () => ({
        key: 'extraLife',
        label: '1-Up',
        kind: 'life',
        value: 1,
        pickupSound: 'forceField_001',
      }),
    };
    scene._applyBonusEffect = () => {};
    scene._effects = {
      showDamageNumber: (...args) => {
        effectCall = args;
      },
    };
    scene.sound = {
      play: (key) => {
        playedSound = key;
      },
    };

    scene._onPlayerCollectBonus({}, { x: 90, y: 120 });

    assert.equal(playedSound, 'forceField_001');
    assert.deepEqual(effectCall, [
      140,
      532,
      '1-UP',
      {
        color: '#ffffff',
        fontSize: '18px',
        strokeThickness: 3,
        glowColor: 0xffffff,
        glowStrength: 6,
        lift: 28,
        duration: 520,
        scaleTo: 1.08,
      },
    ]);
  });

  it('shows the synced weapon pickup name when the player collects T-Laser or Y-Laser', () => {
    const scene = new GameScene();
    const effectLabels = [];
    scene._player = { x: 140, y: 560 };
    scene._applyBonusEffect = () => {};
    scene._effects = {
      showDamageNumber: (...args) => {
        effectLabels.push(args[2]);
      },
    };
    scene.sound = { play: () => {} };

    const payloads = [
      { key: 'tLaser', label: 'T-LASER', kind: 'newWeapon', value: 1, pickupSound: 'forceField_001' },
      { key: 'yLaser', label: 'Y-LASER', kind: 'newWeapon', value: 1, pickupSound: 'forceField_001' },
    ];
    scene._bonuses = {
      collectBonus: () => payloads.shift() ?? null,
    };

    scene._onPlayerCollectBonus({}, { x: 90, y: 120 });
    scene._onPlayerCollectBonus({}, { x: 90, y: 120 });

    assert.deepEqual(effectLabels, ['T-LASER', 'Y-LASER']);
  });

  it('lets player bullets break a bonus shield before the player collects the pickup', () => {
    const scene = new GameScene();
    let appliedBonus = null;
    let hiddenBullet = null;
    let collectCalls = 0;
    const bonus = {
      active: true,
      canCollect: () => bonus.shieldPoints <= 0,
      shieldPoints: 12,
      takeDamage: (damage) => {
        bonus.shieldPoints = Math.max(0, bonus.shieldPoints - damage);
      },
    };
    const bullet = {
      active: true,
      _damage: 12,
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: (target) => {
          hiddenBullet = target;
        },
      },
    };
    scene._bonuses = {
      collectBonus: (target) => {
        collectCalls++;
        return target.canCollect()
          ? { key: 'shield50', kind: 'shield', value: 50, label: '+50 Shield', pickupSound: '' }
          : null;
      },
    };
    scene._applyBonusEffect = (payload) => {
      appliedBonus = payload;
    };
    scene._effects = { showDamageNumber: () => {} };

    scene._onPlayerCollectBonus({}, bonus);
    scene._onBulletHitBonus(bullet, bonus);
    scene._onPlayerCollectBonus({}, bonus);

    assert.equal(hiddenBullet, bullet);
    assert.equal(bullet.body.enable, false);
    assert.equal(bonus.shieldPoints, 0);
    assert.equal(collectCalls, 2);
    assert.deepEqual(appliedBonus, {
      key: 'shield50',
      kind: 'shield',
      value: 50,
      label: '+50 Shield',
      pickupSound: '',
    });
  });

  it('does not try to play a pickup sound when the bonus config leaves it empty', () => {
    const scene = new GameScene();
    let playCalls = 0;
    scene.sound = {
      play: () => {
        playCalls++;
      },
    };

    scene._playBonusPickupSound('');

    assert.equal(playCalls, 0);
  });

  it('routes player bullet hits into bonus shields and consumes the bullet', () => {
    const scene = new GameScene();
    let hiddenBullet = null;
    let bonusDamage = 0;
    const bullet = {
      active: true,
      _damage: 14,
      body: {
        enable: true,
        stop: () => {},
      },
    };
    const bonus = {
      active: true,
      takeDamage: (damage) => {
        bonusDamage = damage;
      },
    };

    scene._weapons = {
      damage: 10,
      pool: {
        killAndHide: (target) => {
          hiddenBullet = target;
        },
      },
    };

    scene._onBulletHitBonus(bullet, bonus);

    assert.equal(hiddenBullet, bullet);
    assert.equal(bonusDamage, 14);
    assert.equal(bullet.body.enable, false);
  });
});
