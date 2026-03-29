import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene, createMockEnemyOptions } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const {
  buildFormationPath,
  calcFormationSlots,
  FormationController,
  getDefaultFormationBehavior,
  resolveFormationBehavior,
  resolveSideAnchorX,
  resolveFormationStep,
} = await import('../../systems/FormationController.js');
const { WingDoctrineController } = await import('../../systems/WingDoctrineController.js');

const { Skirm }        = await import('../../entities/enemies/Skirm.js');
const { Raptor }       = await import('../../entities/enemies/Raptor.js');
const { EVENTS }       = await import('../../config/events.config.js');
const { resolveStats } = await import('../../systems/WaveSpawner.js');
const { RunState }     = await import('../../systems/RunState.js');

const SKIRM_STATS = resolveStats('skirm', 1.0, 1.0, {});
const RAPTOR_STATS = resolveStats('raptor', 1.0, 1.0, {});

const { WEAPONS }     = await import('../../config/weapons.config.js');
const { GAME_CONFIG } = await import('../../config/game.config.js');
const { WIDTH, HEIGHT } = GAME_CONFIG;
const DEFAULT_BEHAVIOR = getDefaultFormationBehavior();

// ---------------------------------------------------------------------------

describe('getDefaultFormationBehavior', () => {
  it('returns a fresh object each time', () => {
    const a = getDefaultFormationBehavior();
    const b = getDefaultFormationBehavior();

    assert.notEqual(a, b);
    assert.notEqual(a.path, b.path);
    assert.notEqual(a.rowYs, b.rowYs);
  });

  it('defines a 7-step path with positive durations', () => {
    assert.equal(DEFAULT_BEHAVIOR.path.length, 7);
    for (const step of DEFAULT_BEHAVIOR.path) {
      assert.equal(typeof step.dur, 'number', `dur must be number: ${JSON.stringify(step)}`);
      assert.ok(step.dur > 0, `dur must be > 0: ${JSON.stringify(step)}`);
      assert.ok(
        typeof step.x === 'number' || typeof step.xPct === 'number',
        `step must define x or xPct: ${JSON.stringify(step)}`
      );
      assert.ok(
        typeof step.y === 'number' || typeof step.yPct === 'number',
        `step must define y or yPct: ${JSON.stringify(step)}`
      );
    }
  });

  it('includes positive firing and timing values', () => {
    assert.ok(DEFAULT_BEHAVIOR.cycleMs >= 5000);
    assert.ok(DEFAULT_BEHAVIOR.shootRate >= 1);
    assert.ok(DEFAULT_BEHAVIOR.pathShootRate >= 1);
    assert.equal(typeof DEFAULT_BEHAVIOR.shotCadence.pathPattern, 'string');
    assert.equal(typeof DEFAULT_BEHAVIOR.shotCadence.idlePattern, 'string');
    assert.ok(DEFAULT_BEHAVIOR.shotCadence.idleVolleySize >= 1);
    assert.ok(DEFAULT_BEHAVIOR.launchStaggerMs > 0);
    assert.ok(DEFAULT_BEHAVIOR.speed >= GAME_CONFIG.SPEED_MIN);
    assert.ok(DEFAULT_BEHAVIOR.speed <= GAME_CONFIG.SPEED_MAX);
  });
});

// ---------------------------------------------------------------------------

describe('resolveFormationBehavior', () => {
  it('merges controller overrides without mutating defaults', () => {
    const behavior = resolveFormationBehavior({
      shootRate: 3,
      shotCadence: {
        idlePattern: 'wings',
        idleVolleySize: 3,
      },
      rowYs: [70, 120],
      path: [{ xPct: 0.5, yPct: 0.2, dur: 100 }],
    });

    assert.equal(behavior.shootRate, 3);
    assert.equal(behavior.shotCadence.idlePattern, 'wings');
    assert.equal(behavior.shotCadence.idleVolleySize, 3);
    assert.equal(behavior.shotCadence.pathPattern, DEFAULT_BEHAVIOR.shotCadence.pathPattern);
    assert.deepEqual(behavior.rowYs, [70, 120]);
    assert.equal(behavior.path.length, 1);
    assert.equal(DEFAULT_BEHAVIOR.path.length, 7);
  });

  it('resolves mirrorPath=\"random\" through the injected rng', () => {
    const mirrored = resolveFormationBehavior({ mirrorPath: 'random' }, () => 0.2);
    const normal = resolveFormationBehavior({ mirrorPath: 'random' }, () => 0.8);

    assert.equal(mirrored.mirrorPath, true);
    assert.equal(normal.mirrorPath, false);
  });
});

// ---------------------------------------------------------------------------

describe('resolveFormationStep / buildFormationPath', () => {
  it('resolves percentage coordinates into world-space waypoints', () => {
    const step = resolveFormationStep(
      { xPct: 0.5, yPct: 0.25, dur: 500 },
      0,
      DEFAULT_BEHAVIOR,
      () => 0.5
    );

    assert.equal(step.x, WIDTH * 0.5);
    assert.equal(step.y, HEIGHT * 0.25);
    assert.equal(step.dur, 500);
  });

  it('mirrors path steps across the playfield when requested', () => {
    const behavior = resolveFormationBehavior({ mirrorPath: true });
    const step = resolveFormationStep(
      { xPct: 0.2, yPct: 0.25, dur: 500 },
      10,
      behavior,
      () => 0.5
    );

    assert.equal(step.x, WIDTH - (WIDTH * 0.2 + 10));
  });

  it('builds a path whose waypoints stay in a readable play area', () => {
    const path = buildFormationPath(DEFAULT_BEHAVIOR, 4, 10, () => 0.5);
    const maxY = Math.max(...path.map(step => step.y));
    const lastY = path.at(-1).y;
    const firstY = path[0].y;

    assert.equal(path.length, DEFAULT_BEHAVIOR.path.length + 2);
    assert.ok(firstY < HEIGHT / 4, `first point should begin near the top side; y = ${firstY}`);
    assert.ok(maxY > HEIGHT / 2, `path should descend below mid-screen; max y = ${maxY}`);
    assert.ok(lastY < HEIGHT / 4, `last point should return near top; y = ${lastY}`);
    path.forEach(step => {
      assert.ok(step.x >= -100 && step.x <= WIDTH + 100, `x out of range: ${step.x}`);
      assert.ok(step.y >= -100 && step.y <= HEIGHT + 100, `y out of range: ${step.y}`);
    });
  });
  
  it('applies pathSpreadX so neighboring ships do not share the exact same line', () => {
    const behavior = resolveFormationBehavior({ pathSpreadX: 24 });
    const left = buildFormationPath(behavior, 0, 5, () => 0.5);
    const right = buildFormationPath(behavior, 4, 5, () => 0.5);

    assert.notEqual(left[1].x, right[1].x);
  });

  it('uses opposite side anchors for launch and return', () => {
    const path = buildFormationPath(DEFAULT_BEHAVIOR, 2, 6, false, () => 0.5);
    const launchX = path[0].x;
    const returnX = path.at(-1).x;

    assert.ok(launchX < WIDTH / 2, `launch anchor should start on the left; x = ${launchX}`);
    assert.ok(returnX > WIDTH / 2, `return anchor should finish on the right; x = ${returnX}`);
  });

  it('resolveSideAnchorX mirrors anchors across left and right sides', () => {
    const leftX = resolveSideAnchorX(DEFAULT_BEHAVIOR, 0, false);
    const rightX = resolveSideAnchorX(DEFAULT_BEHAVIOR, 0, true);

    assert.ok(leftX < WIDTH / 2);
    assert.ok(rightX > WIDTH / 2);
  });
});

// ---------------------------------------------------------------------------

describe('calcFormationSlots', () => {
  it('returns 8 slots for 8 ships (matches SLOTS length)', () => {
    assert.equal(calcFormationSlots(8).length, 8);
  });

  it('returns correct count for any n (1–16)', () => {
    for (let n = 1; n <= 16; n++) {
      assert.equal(calcFormationSlots(n).length, n, `expected ${n} slots for n=${n}`);
    }
  });

  it('returns empty array for 0', () => {
    assert.equal(calcFormationSlots(0).length, 0);
  });

  it('every slot has numeric x and y', () => {
    for (const s of calcFormationSlots(5)) {
      assert.equal(typeof s.x, 'number');
      assert.equal(typeof s.y, 'number');
    }
  });

  it('all slots stay within canvas bounds', () => {
    for (let n = 1; n <= 16; n++) {
      for (const s of calcFormationSlots(n)) {
        assert.ok(s.x >= 0 && s.x <= WIDTH,  `x=${s.x} out of bounds for n=${n}`);
        assert.ok(s.y >= 0 && s.y <= HEIGHT, `y=${s.y} out of bounds for n=${n}`);
      }
    }
  });

  it('uses at most 2 rows', () => {
    for (let n = 1; n <= 16; n++) {
      const rows = new Set(calcFormationSlots(n).map(s => s.y));
      assert.ok(rows.size <= 2, `n=${n} produced ${rows.size} rows`);
    }
  });

  it('rows differ by y (when 2 rows)', () => {
    const slots = calcFormationSlots(8);
    const ys = [...new Set(slots.map(s => s.y))];
    assert.equal(ys.length, 2);
    assert.notEqual(ys[0], ys[1]);
  });

  it('slots are near the top of the screen (y < HEIGHT/4)', () => {
    for (const s of calcFormationSlots(16)) {
      assert.ok(s.y < HEIGHT / 4, `y=${s.y} is not in top quarter`);
    }
  });

  it('no duplicate (x, y) positions', () => {
    for (let n = 1; n <= 16; n++) {
      const seen = new Set();
      for (const s of calcFormationSlots(n)) {
        const key = `${s.x},${s.y}`;
        assert.ok(!seen.has(key), `duplicate slot at ${key} for n=${n}`);
        seen.add(key);
      }
    }
  });

  it('16 ships distribute evenly into two 8-ship rows', () => {
    const counts = {};
    for (const slot of calcFormationSlots(16)) counts[slot.y] = (counts[slot.y] ?? 0) + 1;
    assert.deepEqual(Object.values(counts).sort((a, b) => a - b), [8, 8]);
  });

  it('slots are horizontally centered (mean x ≈ WIDTH/2)', () => {
    for (let n = 1; n <= 16; n++) {
      const slots = calcFormationSlots(n);
      const meanX = slots.reduce((s, p) => s + p.x, 0) / slots.length;
      assert.ok(
        Math.abs(meanX - WIDTH / 2) < 35,
        `n=${n}: mean x=${meanX.toFixed(1)} is not centered on WIDTH/2=${WIDTH / 2}`
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe('DRIFT_RANGE_X / DRIFT_RANGE_Y', () => {
  it('both are positive numbers', () => {
    assert.ok(typeof DEFAULT_BEHAVIOR.driftX === 'number' && DEFAULT_BEHAVIOR.driftX > 0);
    assert.ok(typeof DEFAULT_BEHAVIOR.driftY === 'number' && DEFAULT_BEHAVIOR.driftY > 0);
  });

  it('drift ranges are small enough not to leave the top quarter of the screen', () => {
    const topQuarter = HEIGHT / 4;
    const maxSlotY = Math.max(...calcFormationSlots(16).map(s => s.y));
    assert.ok(maxSlotY + DEFAULT_BEHAVIOR.driftY < topQuarter,
      `max slot y (${maxSlotY}) + drift (${DEFAULT_BEHAVIOR.driftY}) would exit top quarter (${topQuarter})`);
  });
});

// ---------------------------------------------------------------------------

describe('default Skirm durability against the player laser', () => {
  it('laser kills a base skirm in exactly one hit', () => {
    assert.ok(
      WEAPONS.laser.damage >= SKIRM_STATS.hp,
      `laser damage (${WEAPONS.laser.damage}) should be >= skirm hp (${SKIRM_STATS.hp})`
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: FormationController must forward scoreMultiplier through its
// onDeath monkey-patch. Without opts forwarding the multiplier is silently
// dropped and every formation kill scores at 1× regardless of heat level.
// ---------------------------------------------------------------------------

describe('FormationController — scoreMultiplier forwarding through onDeath', () => {
  function makeFormationSkirm(statsOverride = {}) {
    const scene = createMockScene();
    const emitted = [];
    scene.events.emit = (event, data) => emitted.push({ event, data });
    const skirm = new Skirm(scene, 120, 50, { ...SKIRM_STATS, ...statsOverride }, 'straight', createMockEnemyOptions(scene));
    new FormationController(scene, [skirm]);
    return { skirm, scene, emitted };
  }

  it('forwards scoreMultiplier=1.3 from a hot kill to ENEMY_DIED', () => {
    const { skirm, emitted } = makeFormationSkirm();
    skirm.takeDamage(skirm.hp, 1.3);
    const died = emitted.find(e => e.event === EVENTS.ENEMY_DIED);
    assert.ok(died, 'ENEMY_DIED must be emitted');
    assert.equal(died.data.scoreMultiplier, 1.3);
  });

  it('forwards scoreMultiplier=2.0 (max overheat) to ENEMY_DIED', () => {
    const { skirm, emitted } = makeFormationSkirm();
    skirm.takeDamage(skirm.hp, 2.0);
    const died = emitted.find(e => e.event === EVENTS.ENEMY_DIED);
    assert.ok(died, 'ENEMY_DIED must be emitted');
    assert.equal(died.data.scoreMultiplier, 2.0);
  });

  it('defaults scoreMultiplier to 1 when formation ship is killed with no multiplier', () => {
    const { skirm, emitted } = makeFormationSkirm();
    skirm.die();
    const died = emitted.find(e => e.event === EVENTS.ENEMY_DIED);
    assert.ok(died, 'ENEMY_DIED must be emitted');
    assert.equal(died.data.scoreMultiplier, 1);
  });

  it('a formation Skirm killed with 1.3× shot awards 65 points (= round(50 × 1.3))', () => {
    RunState.reset();
    const scene = createMockScene();
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) {
        RunState.addScore(Math.round(data.score * (data.scoreMultiplier ?? 1)));
        RunState.kills++;
      }
    };
    const skirm = new Skirm(scene, 120, 50, SKIRM_STATS, 'straight', createMockEnemyOptions(scene));
    new FormationController(scene, [skirm]);

    skirm.takeDamage(skirm.hp, 1.3);

    assert.equal(RunState.score, 65);
    assert.equal(RunState.kills, 1);
  });

  it('a formation Skirm killed with 2.0× shot awards 100 points (= round(50 × 2.0))', () => {
    RunState.reset();
    const scene = createMockScene();
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) {
        RunState.addScore(Math.round(data.score * (data.scoreMultiplier ?? 1)));
        RunState.kills++;
      }
    };
    const skirm = new Skirm(scene, 120, 50, SKIRM_STATS, 'straight', createMockEnemyOptions(scene));
    new FormationController(scene, [skirm]);

    skirm.takeDamage(skirm.hp, 2.0);

    assert.equal(RunState.score, 100);
    assert.equal(RunState.kills, 1);
  });

  it('killing the same formation Skirm twice only awards score once', () => {
    RunState.reset();
    const scene = createMockScene();
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_DIED) {
        RunState.addScore(Math.round(data.score * (data.scoreMultiplier ?? 1)));
        RunState.kills++;
      }
    };
    const skirm = new Skirm(scene, 120, 50, SKIRM_STATS, 'straight', createMockEnemyOptions(scene));
    new FormationController(scene, [skirm]);

    skirm.takeDamage(skirm.hp, 1.5);  // kills it
    skirm.takeDamage(skirm.hp, 1.5);  // dead — must be ignored

    assert.equal(RunState.kills, 1);
    assert.equal(RunState.score, 75);  // round(50 × 1.5) = 75, only once
  });
});

describe('FormationController — hard speed cap', () => {
  it('clamps path tween durations so formation travel cannot outrun the ship class cap', () => {
    const scene = createMockScene();
    const tweens = [];
    const delayed = [];
    scene.tweens.add = (config) => {
      tweens.push({
        startX: config.targets.x,
        startY: config.targets.y,
        x: config.x,
        y: config.y,
        duration: config.duration,
      });
      return config;
    };
    scene.time.delayedCall = (delay, callback) => {
      delayed.push({ delay, callback });
      return { remove: () => {} };
    };
    scene.time.addEvent = () => ({ remove: () => {} });

    const skirm = new Skirm(scene, 120, 50, SKIRM_STATS, 'straight', createMockEnemyOptions(scene));
    new FormationController(scene, [skirm], {
      speed: 4,
      launchStaggerMs: 1,
      path: [{ xPct: 0.84, yPct: 0.78, dur: 90 }],
      returnToSideMs: 70,
      exitToSlotMs: 70,
    });
    delayed.reduce((best, entry) => (
      !best || entry.delay < best.delay ? entry : best
    ), null)?.callback?.();

    const firstTravelTween = tweens[0];
    assert.ok(firstTravelTween, 'expected an initial formation travel tween');

    const distance = Math.hypot(
      firstTravelTween.x - firstTravelTween.startX,
      firstTravelTween.y - firstTravelTween.startY
    );
    const minDuration = Math.ceil((distance / skirm.getMaxMovementSpeed()) * 1000);

    assert.ok(
      firstTravelTween.duration >= minDuration,
      `expected >= ${minDuration}ms for ${distance.toFixed(2)}px at ${skirm.getMaxMovementSpeed()}px/s, got ${firstTravelTween.duration}ms`
    );
  });
});

function primeFormationControllerFleet(controller) {
  controller._fleet.forEach((data) => {
    data.ship.x = data.slot.x;
    data.ship.y = data.slot.y;
    data.ship._fireCooldown = Math.max(data.ship.fireRate ?? 0, 1000);
  });
}

describe('FormationController firing cadence', () => {
  it('suppresses autonomous straight-formation firing so the controller owns squad cadence', () => {
    const scene = createMockScene();
    const fired = [];
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_FIRE) fired.push(data);
    };

    const skirm = new Skirm(scene, 120, 120, { ...SKIRM_STATS, fireRate: 100 }, 'straight', createMockEnemyOptions(scene));
    skirm._formationFireControlled = true;
    skirm._fireCooldown = 100;

    skirm.update(16);

    assert.equal(fired.length, 0);
    assert.equal(skirm._fireCooldown, 116);
  });

  it('fires bounded volleys instead of letting the whole squad beam at once', () => {
    const scene = createMockScene();
    const fired = [];
    const delayed = [];
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_FIRE) fired.push(data);
    };
    scene.time.delayedCall = (delay, callback) => {
      delayed.push({ delay, callback });
      return { remove() {} };
    };
    scene.tweens.add = () => ({ stop() {} });

    const ships = Array.from({ length: 4 }, (_, index) => {
      const ship = new Skirm(scene, 120 + index * 18, 120, { ...SKIRM_STATS, fireRate: 200 }, 'straight', createMockEnemyOptions(scene));
      ship._fireCooldown = 200;
      return ship;
    });

    const controller = new FormationController(scene, ships, {
      shotCadence: {
        idlePattern: 'sweep',
        idleVolleySize: 2,
        intraVolleyMs: 90,
      },
    });
    controller._inIdle = true;
    controller._setAssaultPhase('attack');
    ships.forEach((ship, index) => {
      ship.x = 210 + index * 18;
      ship.y = 390;
    });
    delayed.length = 0;

    controller._fireNext();

    assert.equal(delayed.length, 2);
    delayed.forEach(entry => entry.callback());
    assert.equal(fired.length, 2);
  });

  it('uses each ship fireRate as a cadence eligibility modifier inside the squad volley', () => {
    const scene = createMockScene();
    const fired = [];
    const delayed = [];
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_FIRE) fired.push(data);
    };
    scene.time.delayedCall = (delay, callback) => {
      delayed.push({ delay, callback });
      return { remove() {} };
    };
    scene.tweens.add = () => ({ stop() {} });

    const readyShip = new Skirm(scene, 140, 120, { ...SKIRM_STATS, fireRate: 250 }, 'straight', createMockEnemyOptions(scene));
    readyShip._fireCooldown = 300;
    const coolingShip = new Skirm(scene, 220, 120, { ...SKIRM_STATS, fireRate: 900 }, 'straight', createMockEnemyOptions(scene));
    coolingShip._fireCooldown = 300;

    const controller = new FormationController(scene, [readyShip, coolingShip], {
      shotCadence: {
        idlePattern: 'single',
        idleVolleySize: 1,
      },
    });
    controller._inIdle = true;
    controller._setAssaultPhase('attack');
    readyShip.x = WIDTH / 2;
    readyShip.y = 390;
    coolingShip.x = WIDTH / 2 + 56;
    coolingShip.y = 390;
    delayed.length = 0;

    controller._fireNext();

    assert.equal(delayed.length, 1);
    delayed[0].callback();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].sourceEnemy, readyShip);
    assert.equal(readyShip._fireCooldown, 0);
    assert.equal(coolingShip._fireCooldown, 300);
  });

  it('allows straight formations to fire during the approach path when ships are ready', () => {
    const scene = createMockScene();
    const fired = [];
    const delayed = [];
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_FIRE) fired.push(data);
    };
    scene.time.delayedCall = (delay, callback) => {
      delayed.push({ delay, callback });
      return { remove() {} };
    };
    scene.tweens.add = () => ({ stop() {} });

    const ships = Array.from({ length: 3 }, (_, index) => {
      const ship = new Skirm(
        scene,
        120 + index * 40,
        120,
        { ...SKIRM_STATS, fireRate: 200 },
        'straight',
        createMockEnemyOptions(scene)
      );
      ship._fireCooldown = 200;
      ship.x = 150 + index * 36;
      ship.y = 110 + index * 18;
      return ship;
    });

    const controller = new FormationController(scene, ships, {
      shotCadence: {
        pathPattern: 'single',
        pathVolleySize: 1,
        intraVolleyMs: 90,
      },
    });
    delayed.length = 0;

    controller._fireMovingNext();

    assert.equal(delayed.length, 1);
    delayed[0].callback();
    assert.equal(fired.length, 1);
  });

  it('queries the adaptive squad directive at runtime and applies its cadence/spread overrides', () => {
    const scene = createMockScene();
    let queried = false;
    scene._enemyAdaptivePolicy = {
      evaluateSquadDirective() {
        queried = true;
        return {
          cadenceModifier: 0.85,
          spreadMultiplier: 1.3,
          driftMultiplier: 1.15,
          verticalBiasPx: 18,
          volleySizeBonus: 1,
          pathPattern: 'single',
          idlePattern: 'wings',
        };
      },
    };

    const ship = new Skirm(scene, 160, 120, {
      ...SKIRM_STATS,
      adaptive: {
        enabled: true,
        minSpeedScalar: 0.9,
        maxSpeedScalar: 1.1,
      },
    }, 'straight', createMockEnemyOptions(scene));
    ship.unlockAdaptiveBehavior();

    const controller = new FormationController(scene, [ship], {
      shotCadence: {
        idlePattern: 'alternating_rows',
        idleVolleySize: 1,
      },
    });

    controller._refreshSquadDirective('idle');
    const behavior = controller._getEffectiveBehavior('idle');
    const cadence = controller._resolveShotCadence('idle');

    assert.equal(queried, true);
    assert.equal(cadence.pattern, 'wings');
    assert.equal(cadence.volleySize, 2);
    assert.ok(behavior.slotSpacingX > DEFAULT_BEHAVIOR.slotSpacingX);
    assert.ok(behavior.rowYs[0] > DEFAULT_BEHAVIOR.rowYs[0]);
  });
});

describe('FormationController tactical doctrines', () => {
  function createDoctrineController(playerX = WIDTH / 2) {
    const scene = createMockScene();
    scene._getEnemyLearningPlayerSnapshot = () => ({
      x: playerX,
      y: 500,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    });
    const ships = Array.from({ length: 5 }, (_, index) => {
      const ship = new Skirm(
        scene,
        80 + index * 50,
        120,
        { ...SKIRM_STATS, fireRate: 200 },
        'straight',
        createMockEnemyOptions(scene)
      );
      ship.unlockAdaptiveBehavior();
      return ship;
    });
    const controller = new FormationController(scene, ships, {
      shotCadence: {
        idlePattern: 'single',
        idleVolleySize: 2,
      },
    });
    primeFormationControllerFleet(controller);
    return controller;
  }

  it('pushes doctrine state into straight formations before adaptive unlock', () => {
    const scene = createMockScene();
    scene._getEnemyLearningPlayerSnapshot = () => ({
      x: 240,
      y: 500,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    });
    scene._enemyAdaptivePolicy = {
      evaluateSquadDirective() {
        return {
          doctrine: 'collapse',
          cadenceModifier: 1.1,
          focusX: 240,
          focusPull: 0.62,
          flankOffsetPx: 72,
          aggression: 0.74,
          caution: 0.22,
          spreadMultiplier: 0.96,
          driftMultiplier: 0.98,
          verticalBiasPx: 16,
          volleySizeBonus: 1,
          pathPattern: 'collapse',
          idlePattern: 'collapse',
        };
      },
    };

    const ships = Array.from({ length: 3 }, (_, index) => new Skirm(
      scene,
      110 + index * 56,
      120,
      {
        ...SKIRM_STATS,
        adaptive: {
          enabled: true,
          minSpeedScalar: 0.9,
          maxSpeedScalar: 1.18,
        },
      },
      'straight',
      createMockEnemyOptions(scene)
    ));
    const controller = new FormationController(scene, ships);
    const centerState = ships[1].getSquadDoctrineState();
    const centerSlot = controller._fleet[1].slot;

    assert.equal(centerState?.doctrine, 'collapse');
    assert.ok(centerState?.anchorWeight > 0.45, `expected meaningful doctrine pull, got ${centerState?.anchorWeight}`);
    assert.ok(centerState?.anchorY > centerSlot.y, `formation doctrine should press lower than slot y=${centerSlot.y}, got anchorY=${centerState?.anchorY}`);
  });

  it('keeps the authored formation path readable while doctrine only biases the slot plan', () => {
    const scene = createMockScene();
    scene._getEnemyLearningPlayerSnapshot = () => ({
      x: 240,
      y: 500,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    });
    scene._enemyAdaptivePolicy = {
      evaluateSquadDirective() {
        return {
          doctrine: 'collapse',
          cadenceModifier: 1.1,
          focusX: 240,
          focusPull: 0.62,
          flankOffsetPx: 72,
          aggression: 0.74,
          caution: 0.22,
          spreadMultiplier: 0.96,
          driftMultiplier: 0.98,
          verticalBiasPx: 16,
          volleySizeBonus: 1,
          pathPattern: 'collapse',
          idlePattern: 'collapse',
        };
      },
    };

    const ship = new Skirm(
      scene,
      140,
      120,
      {
        ...SKIRM_STATS,
        adaptive: {
          enabled: true,
          minSpeedScalar: 0.9,
          maxSpeedScalar: 1.18,
        },
      },
      'straight',
      createMockEnemyOptions(scene)
    );
    const controller = new FormationController(scene, [ship], { mirrorPath: false });
    const behavior = controller._getEffectiveBehavior('path');
    const expectedPath = buildFormationPath(
      behavior,
      0,
      1,
      false,
      () => 0.5,
      controller._fleet[0].speed / Math.max(0.01, behavior.speed)
    );

    assert.equal(controller._fleet[0].path[1].x, expectedPath[1].x);
    assert.equal(controller._fleet[0].path[1].y, expectedPath[1].y);
    assert.equal(controller._fleet[0].path.at(-1).x, expectedPath.at(-1).x);
    assert.equal(controller._fleet[0].path.at(-1).y, expectedPath.at(-1).y);
  });

  it('uses the crossfire doctrine to split volleys across both wings', () => {
    const controller = createDoctrineController(200);
    controller._squadDirective = {
      ...controller._createNeutralSquadDirective(),
      doctrine: 'crossfire',
      focusX: 200,
      flankOffsetPx: 96,
    };

    const volley = controller._selectVolleyCandidates('idle', () => true, {
      pattern: 'crossfire',
      volleySize: 2,
    });
    const sides = volley.map(data => controller._resolveShipRole(data).side).sort();

    assert.equal(volley.length, 2);
    assert.deepEqual(sides, ['left', 'right']);
  });

  it('uses the encircle doctrine to widen wings around the player lane', () => {
    const controller = createDoctrineController(220);
    controller._squadDirective = {
      ...controller._createNeutralSquadDirective(),
      doctrine: 'encircle',
      aggression: 0.72,
      focusX: 220,
      flankOffsetPx: 84,
      focusPull: 0.5,
    };

    const orderedFleet = [...controller._fleet].sort((left, right) => (
      (left.slot?.x ?? 0) - (right.slot?.x ?? 0)
    ));
    const leftAnchor = controller._resolveTacticalAnchor(orderedFleet[0], controller._getEffectiveBehavior('idle'));
    const centerAnchor = controller._resolveTacticalAnchor(orderedFleet[2], controller._getEffectiveBehavior('idle'));
    const rightAnchor = controller._resolveTacticalAnchor(orderedFleet.at(-1), controller._getEffectiveBehavior('idle'));

    assert.ok(leftAnchor.x <= 140, `left wing should widen left of the player lane, got x=${leftAnchor.x}`);
    assert.equal(centerAnchor.x, 220);
    assert.ok(rightAnchor.x >= 300, `right wing should widen right of the player lane, got x=${rightAnchor.x}`);
    assert.ok(centerAnchor.y > leftAnchor.y);
    assert.ok(centerAnchor.y > rightAnchor.y);
    assert.ok(centerAnchor.y >= 170, `encircle should press meaningfully lower, got y=${centerAnchor.y}`);
  });
});

describe('WingDoctrineController tactical doctrines', () => {
  function createRaptorWing(directiveOverrides = {}) {
    const scene = createMockScene();
    scene._getEnemyLearningPlayerSnapshot = () => ({
      x: 220,
      y: 500,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    });

    const stats = {
      ...RAPTOR_STATS,
      fireRate: 220,
      adaptive: {
        enabled: true,
        minSpeedScalar: 0.85,
        maxSpeedScalar: 1.25,
      },
    };
    const options = createMockEnemyOptions(scene, {
      getPlayerSnapshot: () => scene._getEnemyLearningPlayerSnapshot(),
      evaluateSquadDirective: () => ({
        predictions: { win: 0.5, pressure: 0.5, collision: 0.5 },
        doctrine: 'crossfire',
        cadenceModifier: 1,
        focusX: 220,
        focusPull: 0.48,
        flankOffsetPx: 96,
        aggression: 0.72,
        caution: 0.22,
        idlePattern: 'crossfire',
        volleySizeBonus: 0,
        ...directiveOverrides,
      }),
    });

    const left = new Raptor(scene, 120, 180, stats, 'side_left', options);
    const right = new Raptor(scene, 320, 180, stats, 'side_right', createMockEnemyOptions(scene));
    left.x = 140;
    left.y = 180;
    left._entryTargetX = 140;
    left._anchorX = 140;
    left._anchorY = 180;
    left._sideDir = 1;
    left.unlockAdaptiveBehavior();
    right.x = 300;
    right.y = 180;
    right._entryTargetX = 300;
    right._anchorX = 300;
    right._anchorY = 180;
    right._sideDir = -1;
    right.unlockAdaptiveBehavior();

    const controller = new WingDoctrineController(scene, [left, right], {
      dance: 'side_left',
      formation: 'line',
      overlay: true,
    });
    return { controller, left, right, scene };
  }

  it('assigns mirrored crossfire anchors to each raptor wing', () => {
    const { controller, left, right } = createRaptorWing();

    controller._refreshWingDoctrine();

    const leftState = left.getSquadDoctrineState();
    const rightState = right.getSquadDoctrineState();

    assert.equal(leftState.doctrine, 'crossfire');
    assert.ok(leftState.anchorX < 220, `left wing should stage left of player lane, got x=${leftState.anchorX}`);
    assert.ok(rightState.anchorX > 220, `right wing should stage right of player lane, got x=${rightState.anchorX}`);
    assert.ok(leftState.anchorY >= 260, `left wing should press well below its entry lane, got y=${leftState.anchorY}`);
    assert.ok(rightState.anchorY >= 260, `right wing should press well below its entry lane, got y=${rightState.anchorY}`);
    assert.ok(leftState.anchorWeight > 0.4);
    assert.ok(rightState.anchorWeight > 0.4);
  });

  it('fires native raptor star bursts through doctrine-controlled volleys', () => {
    const { controller, left, right, scene } = createRaptorWing();
    const delayed = [];
    const fired = [];
    scene.time.delayedCall = (delay, callback) => {
      delayed.push({ delay, callback });
      return { remove() {} };
    };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_FIRE) fired.push(data);
    };
    left._fireCooldown = left.fireRate;
    right._fireCooldown = right.fireRate;
    left.x = 150;
    left.y = 372;
    right.x = 290;
    right.y = 372;
    delayed.length = 0;
    controller._setObjectivePhase('attack', controller._squadDirective, scene._getEnemyLearningPlayerSnapshot());
    const shotDelays = delayed.filter((entry) => (
      entry.delay === 0 || entry.delay === (controller._behavior.intraVolleyMs ?? 120)
    ));

    assert.equal(shotDelays.length, 2);
    shotDelays.forEach(entry => entry.callback());
    assert.equal(fired.length, 16);
    assert.equal(new Set(fired.map(shot => shot.sourceEnemy)).size, 2);
  });

  it('lets wings fire during commit once the pair is visible and adaptive-ready', () => {
    const scene = createMockScene();
    scene._getEnemyLearningPlayerSnapshot = () => ({
      x: 220,
      y: 500,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    });
    const options = createMockEnemyOptions(scene, {
      getPlayerSnapshot: () => scene._getEnemyLearningPlayerSnapshot(),
      evaluateSquadDirective: () => ({
        predictions: { win: 0.5, pressure: 0.5, collision: 0.5 },
        doctrine: 'crossfire',
        cadenceModifier: 1,
        focusX: 220,
        focusPull: 0.48,
        flankOffsetPx: 96,
        aggression: 0.72,
        caution: 0.22,
        idlePattern: 'crossfire',
        volleySizeBonus: 0,
      }),
    });
    const left = new Raptor(scene, 140, 180, { ...RAPTOR_STATS, fireRate: 200 }, 'side_left', options);
    const right = new Raptor(scene, 300, 180, { ...RAPTOR_STATS, fireRate: 200 }, 'side_right', createMockEnemyOptions(scene));
    const controller = new WingDoctrineController(scene, [left, right], {
      dance: 'side_left',
      formation: 'line',
      overlay: true,
    });
    const delayed = [];
    const fired = [];
    scene.time.delayedCall = (delay, callback) => {
      delayed.push({ delay, callback });
      return { remove() {} };
    };
    scene.events.emit = (event, data) => {
      if (event === EVENTS.ENEMY_FIRE) fired.push(data);
    };
    left._fireCooldown = left.fireRate;
    right._fireCooldown = right.fireRate;
    left.unlockAdaptiveBehavior();
    right.unlockAdaptiveBehavior();
    left.x = 150;
    left.y = 320;
    right.x = 290;
    right.y = 320;
    delayed.length = 0;
    controller._refreshWingDoctrine();
    controller._fireNext();

    const shotDelays = delayed.filter(entry => entry.delay <= (controller._behavior.intraVolleyMs ?? 120));
    assert.equal(shotDelays.length, 2);
    shotDelays.forEach(entry => entry.callback());
    assert.equal(fired.length, 16);
  });
});
