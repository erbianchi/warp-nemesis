/** @module LogisticRegressor */

function clampScore(score) {
  return Math.max(-60, Math.min(60, score));
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getTensorFlow() {
  const tf = globalThis.tf;
  if (!tf?.tensor2d || !tf?.variable || !tf?.train?.sgd || !tf?.sigmoid) return null;
  return tf;
}

function safeProbability(score) {
  return 1 / (1 + Math.exp(-clampScore(score)));
}

function delayToBackground() {
  return new Promise(resolve => {
    globalThis.setTimeout?.(resolve, 0) ?? resolve();
  });
}

/**
 * Logistic regressor that uses TensorFlow.js in the browser runtime and falls
 * back to a small math-only implementation in non-browser test environments.
 * The stored state shape stays plain JSON so it can live in localStorage.
 */
export class LogisticRegressor {
  /**
   * @param {{weights?: number[], bias?: number}} [state={}]
   */
  constructor(state = {}) {
    this.weights = Array.isArray(state.weights)
      ? state.weights.map(value => normalizeNumber(value, 0))
      : [];
    this.bias = normalizeNumber(state.bias, 0);
  }

  /**
   * Ensure the weight vector matches the feature dimension.
   * @param {number} dimension
   */
  ensureDimensions(dimension) {
    if (this.weights.length > dimension) {
      this.weights = this.weights.slice(0, dimension);
    }
    while (this.weights.length < dimension) {
      this.weights.push(0);
    }
  }

  /**
   * @param {number[]} features
   * @returns {number}
   */
  predictScore(features) {
    this.ensureDimensions(features.length);

    let score = this.bias;
    for (let index = 0; index < features.length; index += 1) {
      score += this.weights[index] * normalizeNumber(features[index], 0);
    }
    return score;
  }

  /**
   * @param {number[]} features
   * @returns {number}
   */
  predictProbability(features) {
    return safeProbability(this.predictScore(features));
  }

  _trainExampleWithFallback(features, label, learningRate, regularization) {
    const probability = this.predictProbability(features);
    const y = clamp(normalizeNumber(label, 0), 0, 1);
    const error = probability - y;

    for (let index = 0; index < features.length; index += 1) {
      const feature = normalizeNumber(features[index], 0);
      const gradient = error * feature + regularization * this.weights[index];
      this.weights[index] -= learningRate * gradient;
    }

    this.bias -= learningRate * error;

    const clipped = Math.min(1 - 1e-9, Math.max(1e-9, probability));
    const loss = -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
    return { probability, loss };
  }

  _trainExampleWithTensorFlow(features, label, learningRate, regularization) {
    return this._trainBatchWithTensorFlow(
      [features],
      [label],
      learningRate,
      regularization,
      1
    );
  }

  _trainBatchWithTensorFlow(vectors, labels, learningRate, regularization, epochs = 1) {
    const tf = getTensorFlow();
    const normalizedVectors = vectors.map(features => features.map(value => normalizeNumber(value, 0)));
    const normalizedLabels = labels.map(label => [clamp(normalizeNumber(label, 0), 0, 1)]);
    const dimension = normalizedVectors[0]?.length ?? 0;

    const x = tf.tensor2d(normalizedVectors, [normalizedVectors.length, dimension], 'float32');
    const target = tf.tensor2d(normalizedLabels, [normalizedLabels.length, 1], 'float32');
    const weights = tf.variable(tf.tensor2d(this.weights, [dimension, 1], 'float32'));
    const bias = tf.variable(tf.scalar(this.bias, 'float32'));
    const optimizer = tf.train.sgd(learningRate);

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const loss = optimizer.minimize(() => {
        const logits = tf.add(tf.matMul(x, weights), bias);
        const probabilities = tf.sigmoid(logits);
        const clipped = tf.clipByValue(probabilities, 1e-7, 1 - 1e-7);
        const inverseTarget = tf.sub(tf.onesLike(target), target);
        const inverseClipped = tf.sub(tf.onesLike(clipped), clipped);
        const crossEntropy = tf.neg(tf.mean(
          tf.add(
            tf.mul(target, tf.log(clipped)),
            tf.mul(inverseTarget, tf.log(inverseClipped))
          )
        ));

        if (regularization <= 0) return crossEntropy;
        return tf.add(crossEntropy, tf.mul(tf.scalar(regularization), tf.mean(tf.square(weights))));
      }, true, [weights, bias]);

      loss?.dispose?.();
    }

    const logits = tf.add(tf.matMul(x, weights), bias);
    const probabilities = tf.sigmoid(logits);
    const clipped = tf.clipByValue(probabilities, 1e-7, 1 - 1e-7);
    const inverseTarget = tf.sub(tf.onesLike(target), target);
    const inverseClipped = tf.sub(tf.onesLike(clipped), clipped);
    const lossTensor = tf.neg(tf.mean(
      tf.add(
        tf.mul(target, tf.log(clipped)),
        tf.mul(inverseTarget, tf.log(inverseClipped))
      )
    ));
    const loss = lossTensor.dataSync()[0];
    const probability = probabilities.dataSync()[0];
    this.weights = Array.from(weights.dataSync());
    this.bias = bias.dataSync()[0];

    logits.dispose();
    probabilities.dispose();
    clipped.dispose();
    inverseTarget.dispose();
    inverseClipped.dispose();
    lossTensor.dispose();
    weights.dispose();
    bias.dispose();
    x.dispose();
    target.dispose();

    return { probability, loss };
  }

  async _trainBatchWithTensorFlowAsync(vectors, labels, learningRate, regularization, epochs = 1) {
    const tf = getTensorFlow();
    const normalizedVectors = vectors.map(features => features.map(value => normalizeNumber(value, 0)));
    const normalizedLabels = labels.map(label => [clamp(normalizeNumber(label, 0), 0, 1)]);
    const dimension = normalizedVectors[0]?.length ?? 0;

    const x = tf.tensor2d(normalizedVectors, [normalizedVectors.length, dimension], 'float32');
    const target = tf.tensor2d(normalizedLabels, [normalizedLabels.length, 1], 'float32');
    const weights = tf.variable(tf.tensor2d(this.weights, [dimension, 1], 'float32'));
    const bias = tf.variable(tf.scalar(this.bias, 'float32'));
    const optimizer = tf.train.sgd(learningRate);

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const loss = optimizer.minimize(() => {
        const logits = tf.add(tf.matMul(x, weights), bias);
        const probabilities = tf.sigmoid(logits);
        const clipped = tf.clipByValue(probabilities, 1e-7, 1 - 1e-7);
        const inverseTarget = tf.sub(tf.onesLike(target), target);
        const inverseClipped = tf.sub(tf.onesLike(clipped), clipped);
        const crossEntropy = tf.neg(tf.mean(
          tf.add(
            tf.mul(target, tf.log(clipped)),
            tf.mul(inverseTarget, tf.log(inverseClipped))
          )
        ));

        if (regularization <= 0) return crossEntropy;
        return tf.add(crossEntropy, tf.mul(tf.scalar(regularization), tf.mean(tf.square(weights))));
      }, true, [weights, bias]);

      loss?.dispose?.();
      if (typeof tf.nextFrame === 'function') {
        await tf.nextFrame();
      } else {
        await delayToBackground();
      }
    }

    const logits = tf.add(tf.matMul(x, weights), bias);
    const probabilities = tf.sigmoid(logits);
    const clipped = tf.clipByValue(probabilities, 1e-7, 1 - 1e-7);
    const inverseTarget = tf.sub(tf.onesLike(target), target);
    const inverseClipped = tf.sub(tf.onesLike(clipped), clipped);
    const lossTensor = tf.neg(tf.mean(
      tf.add(
        tf.mul(target, tf.log(clipped)),
        tf.mul(inverseTarget, tf.log(inverseClipped))
      )
    ));
    const loss = lossTensor.dataSync()[0];
    const probability = probabilities.dataSync()[0];
    this.weights = Array.from(weights.dataSync());
    this.bias = bias.dataSync()[0];

    logits.dispose();
    probabilities.dispose();
    clipped.dispose();
    inverseTarget.dispose();
    inverseClipped.dispose();
    lossTensor.dispose();
    weights.dispose();
    bias.dispose();
    x.dispose();
    target.dispose();

    return { probability, loss };
  }

  /**
   * Train against one labelled example using SGD.
   * Uses TensorFlow.js ops in the browser runtime, following the
   * logistic-regression-with-sigmoid setup from the TensorFlow docs.
   *
   * @param {number[]} features
   * @param {number} label
   * @param {{learningRate?: number, regularization?: number}} [options={}]
   * @returns {{probability: number, loss: number}}
   */
  trainExample(features, label, options = {}) {
    const learningRate = Math.max(0, normalizeNumber(options.learningRate, 0.1));
    const regularization = Math.max(0, normalizeNumber(options.regularization, 0));
    this.ensureDimensions(features.length);

    if (getTensorFlow()) {
      try {
        return this._trainExampleWithTensorFlow(features, label, learningRate, regularization);
      } catch {}
    }

    return this._trainExampleWithFallback(features, label, learningRate, regularization);
  }

  /**
   * @param {number[][]} vectors
   * @param {number[]} labels
   * @param {{learningRate?: number, regularization?: number, epochs?: number}} [options={}]
   * @returns {{probability: number, loss: number}}
   */
  trainBatch(vectors, labels, options = {}) {
    const trainingVectors = Array.isArray(vectors) ? vectors.filter(vector => Array.isArray(vector)) : [];
    if (trainingVectors.length === 0) {
      return { probability: 0.5, loss: 0 };
    }

    const learningRate = Math.max(0, normalizeNumber(options.learningRate, 0.1));
    const regularization = Math.max(0, normalizeNumber(options.regularization, 0));
    const epochs = Math.max(1, Math.round(normalizeNumber(options.epochs, 1)));
    this.ensureDimensions(trainingVectors[0].length);

    if (getTensorFlow()) {
      try {
        return this._trainBatchWithTensorFlow(trainingVectors, labels, learningRate, regularization, epochs);
      } catch {}
    }

    let lastResult = { probability: this.predictProbability(trainingVectors[0]), loss: 0 };
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (let index = 0; index < trainingVectors.length; index += 1) {
        lastResult = this._trainExampleWithFallback(
          trainingVectors[index],
          labels[index] ?? 0,
          learningRate,
          regularization
        );
      }
    }

    return lastResult;
  }

  /**
   * @param {number[][]} vectors
   * @param {number[]} labels
   * @param {{learningRate?: number, regularization?: number, epochs?: number}} [options={}]
   * @returns {Promise<{probability: number, loss: number}>}
   */
  async trainBatchAsync(vectors, labels, options = {}) {
    const trainingVectors = Array.isArray(vectors) ? vectors.filter(vector => Array.isArray(vector)) : [];
    if (trainingVectors.length === 0) {
      return { probability: 0.5, loss: 0 };
    }

    const learningRate = Math.max(0, normalizeNumber(options.learningRate, 0.1));
    const regularization = Math.max(0, normalizeNumber(options.regularization, 0));
    const epochs = Math.max(1, Math.round(normalizeNumber(options.epochs, 1)));
    this.ensureDimensions(trainingVectors[0].length);

    if (getTensorFlow()) {
      try {
        return await this._trainBatchWithTensorFlowAsync(
          trainingVectors,
          labels,
          learningRate,
          regularization,
          epochs
        );
      } catch {}
    }

    return this.trainBatch(trainingVectors, labels, {
      learningRate,
      regularization,
      epochs,
    });
  }

  /**
   * @returns {{weights: number[], bias: number}}
   */
  getState() {
    return {
      weights: [...this.weights],
      bias: this.bias,
    };
  }
}
