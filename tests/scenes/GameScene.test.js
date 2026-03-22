import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { GAME_CONFIG } = await import('../../config/game.config.js');
const { RunState } = await import('../../systems/RunState.js');
const { EVENTS } = await import('../../config/events.config.js');
const { resolveStats } = await import('../../systems/WaveSpawner.js');
const { Skirm } = await import('../../entities/enemies/Skirm.js');
const {
  GameScene,
  isHeatWarningActive,
  resolveHeatBarStyle,
} = await import('../../scenes/GameScene.js');
const SKIRM_STATS = resolveStats('skirm', 1.0, 1.0, {});

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
});

describe('GameScene bullet damage', () => {
  it('uses the bullet stored damage and score multiplier when a warning shot hits an enemy', () => {
    const scene = new GameScene();
    let hitDamage = 0;
    let hitScoreMultiplier = 0;
    let hiddenBullet = null;
    const bullet = {
      _damage: 12,
      _scoreMultiplier: 1.2,
      body: {
        enable: true,
        stop: () => {},
      },
    };
    const enemy = {
      alive: true,
      takeDamage: (damage, scoreMultiplier) => {
        hitDamage = damage;
        hitScoreMultiplier = scoreMultiplier;
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
    assert.equal(hitScoreMultiplier, 1.2);
    assert.equal(bullet.body.enable, false);
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
      body: {
        enable: true,
        stop: () => {},
      },
    };

    scene._onBulletHitEnemy(bullet, skirm);

    assert.equal(RunState.score, 55);
    assert.equal(RunState.kills, 1);
  });
});

describe('GameScene player explosion placeholder', () => {
  it('uses the skirm blast without playing the skirm enemy sound', () => {
    const scene = new GameScene();
    let explodeArgs = null;
    scene._effects = {
      explodeForType: (...args) => {
        explodeArgs = args;
      },
    };
    scene._enemies = [];
    scene._eBullets = [];

    scene._explode(120, 240);

    assert.deepEqual(explodeArgs, [
      120,
      240,
      'skirm',
      0,
      0,
      scene._enemies,
      scene._eBullets,
      { playSound: false },
    ]);
  });
});
