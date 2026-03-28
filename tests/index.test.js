import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('index.html', () => {
  it('loads TensorFlow.js with a script tag before the game module bootstrap', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    assert.match(
      html,
      /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@tensorflow\/tfjs@latest\/dist\/tf\.min\.js"><\/script>/
    );
    assert.ok(
      html.indexOf('@tensorflow/tfjs@latest/dist/tf.min.js') < html.indexOf('type="module" src="main.js"'),
      'TensorFlow.js should load before main.js'
    );
  });
});
