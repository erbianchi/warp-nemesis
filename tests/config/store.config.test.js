import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { STORE_ITEMS, STORE_ITEMS_BY_KEY } = await import('../../config/store.config.js');

describe('STORE_ITEMS', () => {
  it('defines the two starter store items', () => {
    assert.deepEqual(
      STORE_ITEMS.map(item => item.key),
      ['hp50', 'shield50']
    );
  });

  it('prices both starter items at 50000', () => {
    assert.equal(STORE_ITEMS_BY_KEY.hp50.price, 50000);
    assert.equal(STORE_ITEMS_BY_KEY.shield50.price, 50000);
  });

  it('uses queued next-game effects for the starter items', () => {
    assert.deepEqual(STORE_ITEMS_BY_KEY.hp50.effect, {
      type: 'starting_hp',
      value: 50,
    });
    assert.deepEqual(STORE_ITEMS_BY_KEY.shield50.effect, {
      type: 'starting_shield',
      value: 50,
    });
  });
});
