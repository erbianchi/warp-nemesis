/** @module store.config
 * Meta-progression store inventory. Keep this file data-driven so future
 * categories and effects can be added without rewriting the scene. */

export const STORE_ITEMS = [
  {
    key: 'hp50',
    label: '+50 HP',
    description: 'Permanent starting HP for future games.',
    price: 50000,
    effect: {
      type: 'starting_hp',
      value: 50,
    },
  },
  {
    key: 'shield50',
    label: '+50 SHIELD',
    description: 'Permanent starting shield for future games.',
    price: 50000,
    effect: {
      type: 'starting_shield',
      value: 50,
    },
  },
];

export const STORE_ITEMS_BY_KEY = Object.fromEntries(
  STORE_ITEMS.map(item => [item.key, item])
);
