import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { BONUSES } = await import('../../config/bonuses.config.js');
const { BonusPickup } = await import('../../entities/BonusPickup.js');

describe('BonusPickup', () => {
  it('uses the slower default fall speed and drifts downward over time', () => {
    const scene = createMockScene();
    const bonus = new BonusPickup(scene, 120, 80, BONUSES.health50);

    bonus.update(1000);

    assert.equal(bonus.fallSpeed, 64);
    assert.equal(bonus.y, 144);
  });

  it('cannot be collected while its shield is active', () => {
    const scene = createMockScene();
    const bonus = new BonusPickup(scene, 120, 80, BONUSES.health50, {
      shieldPoints: 120,
      effects: { explodeShield: () => {} },
    });

    assert.equal(bonus.canCollect(), false);

    bonus.takeDamage(120);

    assert.equal(bonus.active, true);
    assert.equal(bonus.canCollect(), true);
  });
});
