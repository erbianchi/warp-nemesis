import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { EVENTS } = await import('../../config/events.config.js');
const {
  BonusSystem,
  pickWeightedBonusKey,
  rollBonusShieldPoints,
} = await import('../../systems/BonusSystem.js');

describe('pickWeightedBonusKey', () => {
  it('selects the first weighted entry for a very low roll', () => {
    assert.equal(
      pickWeightedBonusKey(() => 0, ['extraLife', 'health50', 'shield50']),
      'extraLife'
    );
  });

  it('can land in the heavier middle of the pool', () => {
    assert.equal(
      pickWeightedBonusKey(() => 0.34, ['extraLife', 'health50', 'shield50']),
      'health50'
    );
  });
});

describe('rollBonusShieldPoints', () => {
  it('returns 0 when the shield chance roll misses', () => {
    assert.equal(
      rollBonusShieldPoints(() => 0.9, { chance: 0.35, minPoints: 100, maxPoints: 200 }),
      0
    );
  });

  it('returns an integer shield value inside the configured range when the roll hits', () => {
    const rngValues = [0.1, 0.45];
    const shieldPoints = rollBonusShieldPoints(
      () => rngValues.shift(),
      { chance: 0.35, minPoints: 100, maxPoints: 200 }
    );

    assert.equal(shieldPoints, 145);
  });
});

describe('BonusSystem', () => {
  let scene;
  let bonusSystem;
  let emitted;

  beforeEach(() => {
    emitted = [];
    scene = createMockScene();
    scene.events.emit = (event, data) => emitted.push({ event, data });
    bonusSystem = new BonusSystem(scene, {
      rng: () => 0,
      effects: { explodeShield: () => {} },
    });
  });

  it('spawns a bonus when the drop roll succeeds', () => {
    const bonus = bonusSystem.spawnRandomDrop(100, 80, 1, { pool: ['health50'] });

    assert.ok(bonus, 'expected a bonus pickup to spawn');
    assert.equal(bonus.bonusKey, 'health50');
    assert.equal(bonusSystem.bonuses.length, 1);
    assert.equal(bonus._shield.points, 100);
  });

  it('does not spawn a bonus when the drop roll fails', () => {
    bonusSystem = new BonusSystem(scene, {
      rng: () => 0.95,
      effects: { explodeShield: () => {} },
    });

    const bonus = bonusSystem.spawnRandomDrop(100, 80, 0.5, { pool: ['health50'] });

    assert.equal(bonus, null);
    assert.equal(bonusSystem.bonuses.length, 0);
  });

  it('emits BONUS_COLLECTED and removes the pickup on collect', () => {
    const bonus = bonusSystem.spawnBonus('shield50', 100, 80, {
      shieldRoll: { chance: 0 },
    });
    const payload = bonusSystem.collectBonus(bonus);

    assert.deepEqual(payload, {
      key: 'shield50',
      kind: 'shield',
      value: 50,
      label: '+50 Shield',
      pickupSound: 'forceField_001',
      pending: false,
      x: 100,
      y: 80,
    });
    assert.equal(bonusSystem.bonuses.length, 0);
    assert.deepEqual(emitted, [{
      event: EVENTS.BONUS_COLLECTED,
      data: payload,
    }]);
  });

  it('does not collect a bonus while its shield is still active', () => {
    const bonus = bonusSystem.spawnBonus('shield50', 100, 80, {
      shieldPoints: 120,
    });

    const payload = bonusSystem.collectBonus(bonus);

    assert.equal(payload, null);
    assert.equal(bonus.active, true);
    assert.equal(bonusSystem.bonuses.length, 1);
  });

  it('allows collection once a bonus shield has been broken', () => {
    const bonus = bonusSystem.spawnBonus('shield50', 100, 80, {
      shieldPoints: 120,
    });

    bonus.takeDamage(120);
    const payload = bonusSystem.collectBonus(bonus);

    assert.deepEqual(payload, {
      key: 'shield50',
      kind: 'shield',
      value: 50,
      label: '+50 Shield',
      pickupSound: 'forceField_001',
      pending: false,
      x: 100,
      y: 80,
    });
  });

  it('culls bonuses that fall off-screen', () => {
    const bonus = bonusSystem.spawnBonus('health50', 100, 681, {
      shieldRoll: { chance: 0 },
    });

    bonusSystem.update(16);

    assert.equal(bonus.active, false);
    assert.equal(bonusSystem.bonuses.length, 0);
  });

  it('can spawn an unshielded bonus when the random shield roll misses', () => {
    bonusSystem = new BonusSystem(scene, {
      rng: () => 0.9,
      effects: { explodeShield: () => {} },
    });

    const bonus = bonusSystem.spawnBonus('health50', 100, 80);

    assert.equal(bonus._shield.points, 0);
  });
});
