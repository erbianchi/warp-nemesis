import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStats, resolveFormationPositions, samplePool, WaveSpawner } from '../../systems/WaveSpawner.js';
import { ENEMIES, PLANE_PRESETS } from '../../config/enemies.config.js';
import { EVENTS } from '../../config/events.config.js';
import { LEVELS } from '../../config/levels.config.js';

function makeScene() {
  const emitted = [];
  return {
    scale: { width: 480, height: 640 },
    events: {
      emit: (event, data) => emitted.push({ event, data }),
      _log: emitted,
    },
  };
}

// ─── resolveStats ─────────────────────────────────────────────────────────────
describe('resolveStats', () => {
  it('returns base stats at difficulty 1.0 with standard preset', () => {
    const stats = resolveStats('fighter', 1.0, 1.0, {});
    assert.equal(stats.hp,     Math.round(ENEMIES.fighter.hp));
    assert.equal(stats.damage, Math.round(ENEMIES.fighter.damage));
    assert.equal(stats.speed,  Math.round(ENEMIES.fighter.speed));
  });

  it('scales hp and damage by level difficulty', () => {
    const stats = resolveStats('fighter', 2.0, 1.0, {});
    assert.equal(stats.hp,     Math.round(ENEMIES.fighter.hp     * 2.0));
    assert.equal(stats.damage, Math.round(ENEMIES.fighter.damage * 2.0));
  });

  it('compounds level and wave difficulty', () => {
    const stats = resolveStats('bomber', 2.0, 1.2, {});
    assert.equal(stats.hp,     Math.round(ENEMIES.bomber.hp     * 2.0 * 1.2));
    assert.equal(stats.damage, Math.round(ENEMIES.bomber.damage * 2.0 * 1.2));
  });

  it('does NOT compound speed with difficulty', () => {
    const stats = resolveStats('fighter', 3.0, 2.0, {});
    assert.equal(stats.speed, Math.round(ENEMIES.fighter.speed));
  });

  it('applies heavy preset modifiers', () => {
    const preset = PLANE_PRESETS.heavy;
    const stats  = resolveStats('fighter', 1.0, 1.0, { preset: 'heavy' });
    assert.equal(stats.hp,    Math.round(ENEMIES.fighter.hp     * preset.hpModifier));
    assert.equal(stats.damage,Math.round(ENEMIES.fighter.damage * preset.damageModifier));
    assert.equal(stats.speed, Math.round(ENEMIES.fighter.speed  * preset.speedModifier));
  });

  it('inline modifiers override preset', () => {
    const stats = resolveStats('fighter', 1.0, 1.0, { preset: 'heavy', damageModifier: 0.5 });
    assert.equal(stats.damage, Math.round(ENEMIES.fighter.damage * 0.5));
    assert.equal(stats.hp,     Math.round(ENEMIES.fighter.hp     * PLANE_PRESETS.heavy.hpModifier));
  });

  it('score = base.score × difficultyBase × difficultyFactor', () => {
    const stats = resolveStats('skirm', 1.0, 1.0, {});
    assert.equal(stats.score, Math.round(ENEMIES.skirm.score * 1.0 * 1.0));
  });

  it('score scales with difficulty', () => {
    const stats = resolveStats('skirm', 2.0, 1.5, {});
    assert.equal(stats.score, Math.round(ENEMIES.skirm.score * 2.0 * 1.5));
  });

  it('skirm at level 1 wave 1 is worth 50 points', () => {
    const stats = resolveStats('skirm', 1.0, 1.0, {});
    assert.equal(stats.score, 50);
  });

  it('throws on unknown enemy type', () => {
    assert.throws(() => resolveStats('unknown_type', 1.0, 1.0, {}), /unknown enemy type/);
  });

  it('throws on unknown preset', () => {
    assert.throws(() => resolveStats('fighter', 1.0, 1.0, { preset: 'nope' }), /unknown plane preset/);
  });

  it('skirm at base difficulty → hp=10, damage=10', () => {
    const stats = resolveStats('skirm', 1.0, 1.0, {});
    assert.equal(stats.hp,     10);
    assert.equal(stats.damage, 10);
  });

  it('skirm ±20% damage modifier', () => {
    assert.equal(resolveStats('skirm', 1.0, 1.0, { damageModifier: 1.2 }).damage, 12);
    assert.equal(resolveStats('skirm', 1.0, 1.0, { damageModifier: 0.8 }).damage,  8);
  });
});

// ─── resolveFormationPositions ────────────────────────────────────────────────
describe('resolveFormationPositions', () => {
  const W = 480, H = 640;

  function sq(formation, entryEdge, count, extras = {}) {
    return { formation, entryEdge, entryX: 0.5, spacing: 60,
             planes: Array(count).fill({ type: 'skirm' }), ...extras };
  }

  it('line from top: correct count and centred', () => {
    const pos = resolveFormationPositions(sq('line', 'top', 3, { entryX: 0.5, spacing: 60 }), W, H);
    assert.equal(pos.length, 3);
    assert.equal(pos[1].x, W * 0.5);
    assert.equal(pos[0].x, pos[1].x - 60);
    assert.equal(pos[2].x, pos[1].x + 60);
  });

  it('V formation: leader closest to top', () => {
    const pos = resolveFormationPositions(sq('V', 'top', 5), W, H);
    assert.equal(pos.length, 5);
    const leaderY = pos[2].y;
    for (let i = 0; i < 5; i++) {
      if (i !== 2) assert.ok(pos[i].y > leaderY);
    }
  });

  it('spread: evenly distributed across width', () => {
    const pos = resolveFormationPositions(sq('spread', 'top', 4), W, H);
    const step = W / 5;
    pos.forEach((p, i) => assert.ok(Math.abs(p.x - step * (i + 1)) < 1));
  });

  it('left entry: planes start off-screen left', () => {
    const pos = resolveFormationPositions(sq('line', 'left', 3), W, H);
    pos.forEach(p => assert.ok(p.x < 0));
  });

  it('right entry: planes start off-screen right', () => {
    const pos = resolveFormationPositions(sq('line', 'right', 3), W, H);
    pos.forEach(p => assert.ok(p.x > W));
  });

  it('cluster formation uses the injected rng for deterministic jitter', () => {
    const posA = resolveFormationPositions(sq('cluster', 'top', 4), W, H, () => 0.25);
    const posB = resolveFormationPositions(sq('cluster', 'top', 4), W, H, () => 0.25);
    assert.deepEqual(posA, posB);
  });

  it('throws on unknown formation', () => {
    assert.throws(() => resolveFormationPositions(sq('spiral', 'top', 3), W, H), /unknown formation/);
  });

  it('throws on unknown entryEdge', () => {
    assert.throws(() => resolveFormationPositions(sq('line', 'bottom', 3), W, H), /unknown entryEdge/);
  });
});

// ─── samplePool ───────────────────────────────────────────────────────────────
describe('samplePool', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

  it('returns exactly count items', () => {
    assert.equal(samplePool(pool, 6).length, 6);
  });

  it('returns all items when count >= pool size', () => {
    assert.equal(samplePool(pool, 10).length, 10);
    assert.equal(samplePool(pool, 99).length, 10);
  });

  it('does not mutate the original pool', () => {
    const copy = [...pool];
    samplePool(pool, 6);
    assert.deepEqual(pool, copy);
  });

  it('each sampled item comes from the pool', () => {
    const result = samplePool(pool, 6);
    result.forEach(item => assert.ok(pool.includes(item)));
  });

  it('no duplicates in result', () => {
    const result = samplePool(pool, 6);
    assert.equal(new Set(result).size, result.length);
  });

  it('with seeded rng produces deterministic results', () => {
    let seed = 42;
    const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const r1 = samplePool(pool, 6, rng);
    seed = 42;
    const r2 = samplePool(pool, 6, rng);
    assert.deepEqual(r1, r2);
  });
});

// ─── WaveSpawner ─────────────────────────────────────────────────────────────
describe('WaveSpawner', () => {
  let scene, spawned;

  function spawnFn(type, x, y, stats, dance) {
    spawned.push({ type, x, y, stats, dance });
  }

  beforeEach(() => {
    scene   = makeScene();
    spawned = [];
  });

  it('throws on invalid level index', () => {
    assert.throws(() => new WaveSpawner(scene, 99, spawnFn), /no level config/);
  });

  it('start() emits WAVE_START', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();
    assert.ok(scene.events._log.find(e => e.event === EVENTS.WAVE_START));
  });

  it('update() spawns skirms on first frame', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();
    spawner.update(16);
    assert.ok(spawned.length > 0);
    spawned.forEach(s => assert.equal(s.type, 'skirm'));
  });

  it('spawned planes carry the squadron dance', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();
    spawner.update(16);
    spawned.forEach(s => assert.ok(typeof s.dance === 'string' && s.dance.length > 0));
  });

  it('roguelike: draws exactly squadronCount squadrons from pool', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();
    assert.equal(spawner._squadronQueue.length, 1);
    spawner.update(16);
    assert.equal(spawner._squadronQueue.length, 0, 'the single selected squadron should have been dispatched');
  });

  it('per-plane dance overrides the squadron default dance', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner._currentWave = { difficultyFactor: 1.0 };
    spawner._spawnSquadron({
      id: 'override_test',
      dance: 'straight',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 60,
      planes: [
        { type: 'skirm' },
        { type: 'skirm', dance: 'jink_drop' },
      ],
    });

    assert.equal(spawned[0].dance, 'straight');
    assert.equal(spawned[1].dance, 'jink_drop');
  });

  it('SQUADRON_SPAWNED includes the full squadron config', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();
    spawner.update(16);

    const event = scene.events._log.find(e => e.event === EVENTS.SQUADRON_SPAWNED);
    assert.ok(event);
    assert.ok(event.data.squadron);
    assert.equal(event.data.count, event.data.squadron.planes.length);
  });

  it('roguelike: different rng values can draw different squadrons', () => {
    const spawnedA = [];
    const spawnedB = [];
    const spawnerA = new WaveSpawner(scene, 0, (...args) => spawnedA.push(args), () => 0.01);
    const spawnerB = new WaveSpawner(scene, 0, (...args) => spawnedB.push(args), () => 0.99);

    spawnerA.start();
    spawnerB.start();
    spawnerA.update(16);
    spawnerB.update(16);

    assert.ok(spawnerA._lastSquadron);
    assert.ok(spawnerB._lastSquadron);
    assert.notEqual(spawnerA._lastSquadron.id, spawnerB._lastSquadron.id);
  });

  it('onWaveCleared() emits WAVE_COMPLETE', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();
    spawner.onWaveCleared();
    assert.ok(scene.events._log.find(e => e.event === EVENTS.WAVE_COMPLETE));
  });

  it('launches the next Level 1 wave in under 2 seconds after a clear', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();

    const waveStartEvents = () => scene.events._log.filter(e => e.event === EVENTS.WAVE_START).length;
    const nextDelayMs = Math.round(LEVELS[0].waves[1].interSquadronDelay * 1000);

    assert.equal(waveStartEvents(), 1);
    spawner.onWaveCleared();
    spawner.update(nextDelayMs - 1);
    assert.equal(waveStartEvents(), 1, 'next wave should not start before the configured delay');

    spawner.update(2);
    assert.equal(waveStartEvents(), 2, 'next wave should start immediately after the short delay');
    assert.ok(nextDelayMs < 2000, 'configured next-wave delay must stay under 2 seconds');
  });

  it('after last wave cleared, emits ALL_WAVES_COMPLETE and stops', () => {
    const spawner = new WaveSpawner(scene, 0, spawnFn);
    spawner.start();
    const waves = LEVELS[0].waves;

    for (let i = 0; i < waves.length - 1; i++) {
      spawner.onWaveCleared();
      spawner.update(Math.ceil(waves[i + 1].interSquadronDelay * 1000) + 1);
    }

    spawner.onWaveCleared();
    assert.ok(scene.events._log.find(e => e.event === EVENTS.ALL_WAVES_COMPLETE));

    const countBefore = scene.events._log.length;
    spawner.update(5000);
    spawner.onWaveCleared();
    assert.equal(scene.events._log.length, countBefore, 'no events after done');
  });
});
