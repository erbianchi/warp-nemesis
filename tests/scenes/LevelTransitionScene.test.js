import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal, createMockScene } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { LevelTransitionScene } = await import('../../scenes/LevelTransitionScene.js');
const { MetaProgression } = await import('../../systems/MetaProgression.js');

describe('LevelTransitionScene', () => {
  it('shows the current total score and queued next-game bonuses', () => {
    const scene = new LevelTransitionScene();
    Object.assign(scene, createMockScene());

    const originalLoad = MetaProgression.load;
    MetaProgression.load = () => ({
      totalScore: 75000,
      ownedBonuses: { hp: 50, shield: 0 },
    });

    try {
      scene.create({ levelNumber: 1, runScore: 2450 });

      assert.equal(scene._totalScoreText.text, 'TOTAL SCORE  75000');
      assert.equal(scene._ownedHpText.text, 'HP  +50');
      assert.equal(scene._ownedShieldText.text, 'SHIELD  +0');
      assert.equal(scene._storeButtons.length, 2);
    } finally {
      MetaProgression.load = originalLoad;
    }
  });

  it('purchases store items through MetaProgression and refreshes the UI', () => {
    const scene = new LevelTransitionScene();
    Object.assign(scene, createMockScene());

    let currentState = {
      totalScore: 60000,
      ownedBonuses: { hp: 0, shield: 0 },
    };

    const originalLoad = MetaProgression.load;
    const originalPurchase = MetaProgression.purchase;
    MetaProgression.load = () => currentState;
    MetaProgression.purchase = (itemKey) => {
      assert.equal(itemKey, 'hp50');
      currentState = {
        totalScore: 10000,
        ownedBonuses: { hp: 50, shield: 0 },
      };
      return {
        ok: true,
        reason: null,
        item: { label: '+50 HP' },
        ...currentState,
      };
    };

    try {
      scene.create({ levelNumber: 1, runScore: 2450 });
      scene._purchaseItem('hp50');

      assert.equal(scene._statusText.text, '+50 HP PURCHASED');
      assert.equal(scene._totalScoreText.text, 'TOTAL SCORE  10000');
      assert.equal(scene._ownedHpText.text, 'HP  +50');
      assert.equal(scene._ownedShieldText.text, 'SHIELD  +0');
    } finally {
      MetaProgression.load = originalLoad;
      MetaProgression.purchase = originalPurchase;
    }
  });

  it('returns to the configured scene when the player continues', () => {
    const scene = new LevelTransitionScene();
    Object.assign(scene, createMockScene());

    let startedScene = null;
    scene.scene = {
      start: (sceneKey) => {
        startedScene = sceneKey;
      },
    };

    const originalLoad = MetaProgression.load;
    MetaProgression.load = () => ({
      totalScore: 0,
      ownedBonuses: { hp: 0, shield: 0 },
    });

    try {
      scene.create({ returnSceneKey: 'MenuScene', continueLabel: 'BACK TO MENU' });
      scene._continue();

      assert.equal(startedScene, 'MenuScene');
    } finally {
      MetaProgression.load = originalLoad;
    }
  });
});
