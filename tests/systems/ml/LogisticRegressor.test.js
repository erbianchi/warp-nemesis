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

  it('does not mutate regressor state during prediction', () => {
    const regressor = new LogisticRegressor({
      inputSize: 2,
      weights: [2, -1],
      bias: 0.5,
    });
    const before = regressor.getState();

    regressor.predictProbability([0.3, 0.2]);

    assert.deepEqual(regressor.getState(), before);
  });

  it('throws on feature dimension mismatches instead of silently zero-padding at inference time', () => {
    const regressor = new LogisticRegressor({
      inputSize: 2,
      weights: [1, 2],
      bias: 0,
    });

    assert.throws(
      () => regressor.predictProbability([1, 2, 3]),
      /feature dimension mismatch/
    );
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

  it('separates a simple linearly separable batch after batch training', () => {
    const regressor = new LogisticRegressor();
    const vectors = [
      [1, 1],
      [1.2, 0.9],
      [0.8, 1.1],
      [-1, -1],
      [-1.1, -0.8],
      [-0.9, -1.2],
    ];
    const labels = [1, 1, 1, 0, 0, 0];

    regressor.trainBatch(vectors, labels, {
      learningRate: 0.18,
      regularization: 0.0005,
      epochs: 6,
    });

    assert.ok(
      regressor.predictProbability([1, 1]) > 0.8,
      'positive cluster should score as likely positive'
    );
    assert.ok(
      regressor.predictProbability([-1, -1]) < 0.2,
      'negative cluster should score as likely negative'
    );
  });

  it('preserves learned predictions across getState() round-trips', () => {
    const regressor = new LogisticRegressor();
    const vectors = [
      [0],
      [1],
      [2],
      [3],
      [4],
      [5],
    ];
    const labels = [0, 0, 0, 1, 1, 1];

    regressor.trainBatch(vectors, labels, {
      learningRate: 0.18,
      regularization: 0.0005,
      epochs: 6,
    });

    const positiveBefore = regressor.predictProbability([5]);
    const negativeBefore = regressor.predictProbability([0]);
    const reloaded = new LogisticRegressor(regressor.getState());

    assert.equal(reloaded.predictProbability([5]), positiveBefore);
    assert.equal(reloaded.predictProbability([0]), negativeBefore);
  });

  it('learns in the async fallback batch path too', async () => {
    const regressor = new LogisticRegressor();
    const vectors = [
      [1, 1],
      [1.2, 0.9],
      [0.8, 1.1],
      [-1, -1],
      [-1.1, -0.8],
      [-0.9, -1.2],
    ];
    const labels = [1, 1, 1, 0, 0, 0];

    await regressor.trainBatchAsync(vectors, labels, {
      learningRate: 0.18,
      regularization: 0.0005,
      epochs: 6,
    });

    assert.ok(regressor.predictProbability([1, 1]) > 0.8);
    assert.ok(regressor.predictProbability([-1, -1]) < 0.2);
  });

  it('trains a full batch without throwing when the TensorFlow path fails', () => {
    const previousTf = globalThis.tf;
    const previousWarn = globalThis.console?.warn;
    const warnings = [];
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
    globalThis.console = {
      ...(globalThis.console ?? {}),
      warn: (...args) => warnings.push(args.join(' ')),
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
      assert.equal(regressor.lastTrainingBackend, 'math-fallback');
      assert.ok(warnings.some(message => message.includes('TensorFlow batch training failed')));
    } finally {
      if (previousTf === undefined) {
        delete globalThis.tf;
      } else {
        globalThis.tf = previousTf;
      }
      if (globalThis.console) {
        globalThis.console.warn = previousWarn;
      }
    }
  });

  it('uses sample weights to keep a rare positive example learnable', () => {
    const unweighted = new LogisticRegressor();
    const weighted = new LogisticRegressor();
    const vectors = [
      [1, 1],
      [-1, -1],
      [-1, -1],
      [-1, -1],
      [-1, -1],
      [-1, -1],
      [-1, -1],
      [-1, -1],
      [-1, -1],
      [-1, -1],
    ];
    const labels = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    unweighted.trainBatch(vectors, labels, {
      learningRate: 0.18,
      regularization: 0.0005,
      epochs: 6,
    });
    weighted.trainBatch(vectors, labels, {
      learningRate: 0.18,
      regularization: 0.0005,
      epochs: 6,
      sampleWeights: [5, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });

    assert.ok(
      weighted.predictProbability([1, 1]) > unweighted.predictProbability([1, 1]),
      'weighted training should keep the rare positive example more influential'
    );
  });
});
