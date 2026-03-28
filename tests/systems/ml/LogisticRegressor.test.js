import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { LogisticRegressor } = await import('../../../systems/ml/LogisticRegressor.js');

describe('LogisticRegressor', () => {
  it('predicts probabilities in the expected range', () => {
    const regressor = new LogisticRegressor({
      weights: [2, -1],
      bias: 0.5,
    });

    const probability = regressor.predictProbability([0.3, 0.2]);

    assert.ok(probability > 0 && probability < 1);
  });

  it('learns toward the positive class with repeated examples', () => {
    const regressor = new LogisticRegressor();
    const features = [1, 0.5, 0.25];
    const before = regressor.predictProbability(features);

    for (let index = 0; index < 20; index += 1) {
      regressor.trainExample(features, 1, {
        learningRate: 0.25,
        regularization: 0,
      });
    }

    const after = regressor.predictProbability(features);
    assert.ok(after > before);
  });

  it('supports soft labels without collapsing them to binary targets', () => {
    const regressor = new LogisticRegressor();
    const features = [0.8, 0.4];

    for (let index = 0; index < 30; index += 1) {
      regressor.trainExample(features, 0.3, {
        learningRate: 0.2,
        regularization: 0,
      });
    }

    const probability = regressor.predictProbability(features);
    assert.ok(probability > 0.1 && probability < 0.7);
  });

  it('trains a full batch without throwing when the TensorFlow path fails', () => {
    const previousTf = globalThis.tf;
    globalThis.tf = {
      tensor2d() {
        throw new Error('tf boom');
      },
      variable() {},
      sigmoid() {},
      train: {
        sgd() {},
      },
    };

    try {
      const regressor = new LogisticRegressor();
      assert.doesNotThrow(() => {
        regressor.trainBatch(
          [
            [1, 0.5],
            [0.2, 0.1],
          ],
          [1, 0],
          {
            learningRate: 0.2,
            regularization: 0,
            epochs: 4,
          }
        );
      });
    } finally {
      if (previousTf === undefined) {
        delete globalThis.tf;
      } else {
        globalThis.tf = previousTf;
      }
    }
  });
});
