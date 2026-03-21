import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installPhaserGlobal } from '../helpers/phaser.mock.js';

installPhaserGlobal();

const { GAME_CONFIG } = await import('../../config/game.config.js');
const { resolveHeatBarStyle } = await import('../../scenes/GameScene.js');

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
