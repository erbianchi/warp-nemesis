/** @module GameServices */

import { ShieldController } from './ShieldController.js';

function resolveDefaultWeaponSnapshot(weapons) {
  return weapons?.getLearningSnapshot?.() ?? {
    primaryWeaponKey: null,
    heatRatio: 0,
    isOverheated: false,
    primaryDamageMultiplier: 1,
  };
}

/**
 * Build the plain runtime services object shared by enemies, formations, and
 * adaptive systems so they do not need to crawl back through `GameScene`.
 *
 * @param {Phaser.Scene} scene
 * @param {{
 *   getPlayer?: () => object|null,
 *   getEnemies?: () => object[],
 *   getWeapons?: () => object|null,
 *   getEffects?: () => object|null,
 *   getAdaptivePolicy?: () => object|null,
 *   getPlayerSnapshot?: () => object|null,
 *   getPlayerBullets?: () => object[],
 * }} [providers={}]
 * @returns {object}
 */
export function createGameServices(scene, providers = {}) {
  const services = {
    scene,
    player: {
      get: providers.getPlayer ?? (() => null),
      getSnapshot: providers.getPlayerSnapshot ?? (() => null),
      getBullets: providers.getPlayerBullets ?? (() => {
        const weapons = services.weapons.get();
        return weapons?.pool?.getChildren?.()?.filter?.(bullet => bullet?.active) ?? [];
      }),
    },
    enemies: {
      get: providers.getEnemies ?? (() => []),
    },
    weapons: {
      get: providers.getWeapons ?? (() => null),
      getSnapshot: () => resolveDefaultWeaponSnapshot(services.weapons.get()),
    },
    effects: {
      get: providers.getEffects ?? (() => null),
    },
    adaptive: {
      getPolicy: providers.getAdaptivePolicy ?? (() => null),
      evaluateSquadDirective: (options = {}) => (
        services.adaptive.getPolicy()?.evaluateSquadDirective?.({
          ...options,
          services,
        }) ?? null
      ),
    },
    shields: {
      create: (target, options = {}) => new ShieldController(scene, target, options),
    },
  };

  services.runtimeContext = {
    getServices: () => services,
    getPlayer: () => services.player.get(),
    getWeapons: () => services.weapons.get(),
    getEffects: () => services.effects.get(),
    getEnemies: () => services.enemies.get(),
    getAdaptivePolicy: () => services.adaptive.getPolicy(),
    getPlayerSnapshot: () => services.player.getSnapshot(),
    getPlayerBullets: () => services.player.getBullets(),
    createShieldController: (target, options = {}) => services.shields.create(target, options),
  };

  return services;
}

