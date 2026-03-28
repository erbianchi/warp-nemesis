import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockScene } from '../../helpers/phaser.mock.js';

const { EnemyLearningSession } = await import('../../../systems/ml/EnemyLearningSession.js');
const { EVENTS } = await import('../../../config/events.config.js');

describe('EnemyLearningSession', () => {
  it('collects per-enemy training examples with attributed pressure and collision labels', () => {
    const scene = createMockScene();
    const enemies = [
      {
        enemyType: 'skirm',
        x: 120,
        y: 90,
        speed: 100,
        active: true,
        alive: true,
        _learningId: 'enemy-1',
        _squadId: 'squad-1',
      },
      {
        enemyType: 'skirm',
        x: 180,
        y: 110,
        speed: 100,
        active: true,
        alive: true,
        _learningId: 'enemy-2',
        _squadId: 'squad-1',
      },
    ];

    const session = new EnemyLearningSession({
      scene,
      getPlayerSnapshot: () => ({
        x: 150,
        y: 500,
        hasShield: true,
        shieldRatio: 0.5,
      }),
      getWeaponSnapshot: () => ({
        primaryWeaponKey: 'laser',
        heatRatio: 0.25,
        isOverheated: false,
      }),
      getEnemies: () => enemies,
    });

    for (const enemy of enemies) {
      scene.events.emit(EVENTS.ENEMY_SPAWNED, {
        enemy,
        type: enemy.enemyType,
        squadId: enemy._squadId,
      });
    }

    scene.events.emit(EVENTS.ENEMY_FIRE, { sourceType: 'skirm', sourceEnemyId: 'enemy-1' });
    scene.events.emit(EVENTS.PLAYER_HIT, {
      sourceType: 'skirm',
      sourceEnemyId: 'enemy-1',
      absorbed: 10,
      hpDamage: 5,
    });
    scene.events.emit(EVENTS.ENEMY_DIED, {
      enemy: enemies[0],
      type: 'skirm',
      cause: 'player_collision',
    });

    session.update(250);

    const [record] = session.buildTrainingRecords('player_win');
    const [squadRecord] = session.buildSquadTrainingRecords();
    const firstExample = record.examples[0];
    const encoder = session._encoder;
    const features = Object.fromEntries(
      encoder.getFeatureNames().map((name, index) => [name, firstExample.vector[index]])
    );

    assert.equal(record.enemyType, 'skirm');
    assert.equal(record.enemyCount, 2);
    assert.equal(record.summary.spawnCount, 2);
    assert.equal(record.summary.playerHitCount, 1);
    assert.equal(record.summary.hpDamageToPlayer, 5);
    assert.equal(record.summary.shieldDamageToPlayer, 10);
    assert.equal(record.summary.collisionDeathCount, 1);
    assert.ok(record.examples.length > 0);
    assert.ok(features.squadXNorm > 0);
    assert.ok(features.distanceNorm > 0);
    assert.ok(firstExample.labels.win > 0.25, 'local pressure should keep win labels above zero even on a player win');
    assert.ok(firstExample.labels.collision > 0.5);
    assert.ok(firstExample.labels.pressure > 0.8);
    assert.ok(firstExample.labels.survival < 0.25);
    assert.equal(features.weapon_laser, 1);
    assert.equal(features.playerShieldUp, 1);
    assert.equal(squadRecord.levelNumber, 1);
    assert.equal(squadRecord.squadId, 'squad-1');
    assert.ok(squadRecord.examples.length > 0);
    assert.equal(squadRecord.examples[0].labels.pressure, 1);
  });

  it('assigns a direct bullet-death label when an enemy is shot down', () => {
    const scene = createMockScene();
    const enemy = {
      enemyType: 'skirm',
      x: 120,
      y: 90,
      speed: 100,
      active: true,
      alive: true,
      _learningId: 'enemy-bullet',
    };

    const session = new EnemyLearningSession({
      scene,
      getPlayerSnapshot: () => ({
        x: 150,
        y: 500,
        hasShield: false,
        shieldRatio: 0,
      }),
      getWeaponSnapshot: () => ({
        primaryWeaponKey: 'laser',
        heatRatio: 0.1,
        isOverheated: false,
      }),
      getEnemies: () => [enemy],
    });

    scene.events.emit(EVENTS.ENEMY_SPAWNED, {
      enemy,
      type: enemy.enemyType,
    });

    session.update(250);
    scene.events.emit(EVENTS.ENEMY_DIED, {
      enemy,
      type: 'skirm',
      cause: 'player_bullet',
    });

    const [record] = session.buildTrainingRecords('player_win');
    const [example] = record.examples;

    assert.ok(example.labels.bullet > 0.95);
    assert.equal(example.labels.collision, 0);
    assert.ok(example.labels.survival < 0.25);
  });
});
