import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { EnemyFeatureEncoder } = await import('../../../systems/ml/EnemyFeatureEncoder.js');

describe('EnemyFeatureEncoder', () => {
  it('encodes a live enemy state/action sample into a fixed vector', () => {
    const encoder = new EnemyFeatureEncoder();
    const sample = encoder.buildSample({
      enemyType: 'skirm',
      player: {
        x: 150,
        y: 500,
        hasShield: true,
        shieldRatio: 0.5,
        hpRatio: 0.75,
      },
      weapon: {
        primaryWeaponKey: 'spreadShot',
        heatRatio: 0.25,
        isOverheated: false,
        primaryDamageMultiplier: 2,
      },
      enemyX: 180,
      enemyY: 120,
      speed: 100,
      squad: {
        centroidX: 170,
        centroidY: 130,
        width: 60,
        aliveRatio: 0.5,
      },
    });

    const encoded = encoder.encode(sample);
    const features = Object.fromEntries(
      encoded.featureNames.map((name, index) => [name, encoded.vector[index]])
    );

    assert.equal(features.playerShieldUp, 1);
    assert.equal(features.playerShieldRatio, 0.5);
    assert.equal(features.playerHpRatio, 0.75);
    assert.ok(features.enemyXNorm > 0);
    assert.ok(features.proximityNorm > 0);
    assert.ok(features.shotAlignment > 0);
    assert.ok(features.shieldedLaneRisk >= 0);
    assert.equal(features.bulletLaneThreat, 0);
    assert.equal(features.actionModeHold, 1);
    assert.equal(features.weapon_spreadShot, 1);
    assert.equal(features.weapon_laser, 0);
    assert.ok(!('distanceNorm' in features));
    assert.ok(!('absDxNorm' in features));
    assert.ok(!('sameLane' in features));
    assert.ok(!('abovePlayer' in features));
  });
});
