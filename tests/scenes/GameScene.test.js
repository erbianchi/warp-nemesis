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
    let hitScoreMultiplier = 0;
    let hiddenBullet = null;
    const enemy = {
      alive: true,
      takeDamage: (damage, scoreMultiplier) => {
        hitDamage = damage;
        hitScoreMultiplier = scoreMultiplier;
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
    assert.equal(hitScoreMultiplier, 1.2);
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

  it('spawns an enemy laser with the configured damage and culls it after it leaves the screen', () => {
    const scene = new GameScene();
    Object.assign(scene, createMockScene());
    const tweenConfigs = [];

    scene._eBullets = [];
    scene.tweens = {
      add: (config) => {
        tweenConfigs.push(config);
        return { stop: () => {} };
      },
    };

    scene._onEnemyFire({ x: 120, y: 90, vy: 220, damage: 14 });

    assert.equal(scene._eBullets.length, 1);
    assert.equal(scene._eBullets[0]._damage, 14);
    assert.equal(scene._eBullets[0].x, 120);
    assert.equal(scene._eBullets[0].y, 90);
    assert.equal(tweenConfigs.length, 1);
    assert.equal(tweenConfigs[0].duration, Math.round(((GAME_CONFIG.HEIGHT + 30 - 90) / 220) * 1000));

    scene._eBullets[0].active = true;
    tweenConfigs[0].onComplete();

    assert.equal(scene._eBullets.length, 0);
    assert.equal(scene._eBullets[0], undefined);
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
      label: 'T-Laser',
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
        label: 'T-Laser',
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
      label: 'Laser x2',
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
        label: 'Laser x2',
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
