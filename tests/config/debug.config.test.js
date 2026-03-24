import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { readDebugOptions } = await import('../../config/debug.config.js');

describe('readDebugOptions', () => {
  it('enables the ending shortcut when debugEnd is truthy', () => {
    assert.deepEqual(readDebugOptions('?debugEnd=1'), { debugEnd: true });
    assert.deepEqual(readDebugOptions('?debugEnd=true'), { debugEnd: true });
    assert.deepEqual(readDebugOptions('?debugEnd=on'), { debugEnd: true });
  });

  it('keeps the ending shortcut disabled by default', () => {
    assert.deepEqual(readDebugOptions(''), { debugEnd: false });
    assert.deepEqual(readDebugOptions('?debugEnd=0'), { debugEnd: false });
    assert.deepEqual(readDebugOptions('?otherFlag=1'), { debugEnd: false });
  });

  it('accepts the path-style flag form used as /&debugEnd=1', () => {
    assert.deepEqual(
      readDebugOptions({ pathname: '/&debugEnd=1', search: '' }),
      { debugEnd: true }
    );
  });
});
