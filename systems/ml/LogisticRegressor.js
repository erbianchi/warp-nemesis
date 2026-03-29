/** @module LogisticRegressor */

function clampScore(score) {
  return Math.max(-60, Math.min(60, score));
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
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

function warnTensorFlowFallback(phase, error) {
  globalThis.console?.warn?.(
    `[LogisticRegressor] TensorFlow ${phase} failed; falling back to the math backend.`,
    error
  );
}

function normalizeSampleWeights(sampleWeights, size) {
  const weights = Array.from({ length: size }, (_, index) => (
    Math.max(0, normalizeNumber(sampleWeights?.[index], 1))
  ));
  const meanWeight = weights.reduce((sum, value) => sum + value, 0) / Math.max(1, weights.length);
  if (meanWeight <= 0) return new Array(size).fill(1);
  return weights.map(weight => weight / meanWeight);
}

function shuffleIndices(length, rng = Math.random) {
  const order = Array.from({ length }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }
  return order;
}

function resolveBatchMetrics(probabilities, labels, sampleWeights) {
  let weightedLoss = 0;
  let totalWeight = 0;

  for (let index = 0; index < probabilities.length; index += 1) {
    const probability = clamp(normalizeNumber(probabilities[index], 0.5), 1e-9, 1 - 1e-9);
    const label = clamp(normalizeNumber(labels[index], 0), 0, 1);
    const weight = Math.max(0, normalizeNumber(sampleWeights[index], 1));
    weightedLoss += weight * (-(label * Math.log(probability) + (1 - label) * Math.log(1 - probability)));
    totalWeight += weight;
  }

  return {
    probability: probabilities[0] ?? 0.5,
    loss: totalWeight > 0 ? weightedLoss / totalWeight : 0,
  };
}

/**
 * Logistic regressor that uses TensorFlow.js in the browser runtime and falls
 * back to a small math-only implementation in non-browser test environments.
 * The stored state shape stays plain JSON so it can live in localStorage.
 */
export class LogisticRegressor {
  /**
   * @param {{inputSize?: number, weights?: number[], bias?: number}} [state={}]
   */
  constructor(state = {}) {
    this.weights = Array.isArray(state.weights)
      ? state.weights.map(value => normalizeNumber(value, 0))
      : [];
    this.inputSize = normalizeInteger(state.inputSize, this.weights.length);
    if (this.weights.length > 0) this.inputSize = this.weights.length;
    this.bias = normalizeNumber(state.bias, 0);
    this.lastTrainingBackend = 'none';
    this.lastTrainingError = null;
  }

  _assertFeatureDimension(dimension) {
    const expectedDimension = this.weights.length || this.inputSize;
    if (expectedDimension <= 0) return;
    if (expectedDimension !== dimension) {
      throw new Error(`LogisticRegressor: feature dimension mismatch (expected ${expectedDimension}, got ${dimension})`);
    }
  }

  _ensureTrainingDimensions(dimension) {
    if (dimension <= 0) {
      this.inputSize = 0;
      this.weights = [];
      return;
    }

    const expectedDimension = this.weights.length || this.inputSize;
    if (expectedDimension <= 0) {
      this.inputSize = dimension;
      this.weights = new Array(dimension).fill(0);
      return;
    }

    if (expectedDimension !== dimension) {
      throw new Error(`LogisticRegressor: feature dimension mismatch (expected ${expectedDimension}, got ${dimension})`);
    }

    this.inputSize = expectedDimension;
    if (this.weights.length === 0) {
      this.weights = new Array(expectedDimension).fill(0);
    }
  }

  _normalizeBatch(vectors, labels, sampleWeights) {
    const normalizedVectors = [];
    const normalizedLabels = [];
    const normalizedWeights = [];
    let dimension = null;

    for (let index = 0; index < (Array.isArray(vectors) ? vectors.length : 0); index += 1) {
      const vector = vectors[index];
      if (!Array.isArray(vector)) continue;

      const normalizedVector = vector.map(value => normalizeNumber(value, 0));
      dimension ??= normalizedVector.length;
      if (normalizedVector.length !== dimension) {
        throw new Error(`LogisticRegressor: inconsistent batch feature dimensions (${normalizedVector.length} vs ${dimension})`);
      }

      normalizedVectors.push(normalizedVector);
      normalizedLabels.push(clamp(normalizeNumber(labels?.[index], 0), 0, 1));
      normalizedWeights.push(Math.max(0, normalizeNumber(sampleWeights?.[index], 1)));
    }

    return {
      vectors: normalizedVectors,
      labels: normalizedLabels,
      sampleWeights: normalizeSampleWeights(normalizedWeights, normalizedVectors.length),
      dimension: dimension ?? 0,
    };
  }

  _setTrainingOutcome(backend, error = null) {
    this.lastTrainingBackend = backend;
    this.lastTrainingError = error ?? null;
  }

  /**
   * @param {number[]} features
   * @returns {number}
   */
  predictScore(features) {
    const normalizedFeatures = Array.isArray(features)
      ? features.map(value => normalizeNumber(value, 0))
      : [];

    if (this.weights.length === 0 && this.inputSize === 0) {
      return this.bias;
    }

    this._assertFeatureDimension(normalizedFeatures.length);

    let score = this.bias;
    for (let index = 0; index < normalizedFeatures.length; index += 1) {
      score += (this.weights[index] ?? 0) * normalizedFeatures[index];
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

  _trainExampleWithFallback(features, label, learningRate, regularization, sampleWeight = 1) {
    const probability = this.predictProbability(features);
    const y = clamp(normalizeNumber(label, 0), 0, 1);
    const weight = Math.max(0, normalizeNumber(sampleWeight, 1));
    const error = (probability - y) * weight;

    for (let index = 0; index < features.length; index += 1) {
      const feature = normalizeNumber(features[index], 0);
      const gradient = error * feature + regularization * this.weights[index];
      this.weights[index] -= learningRate * gradient;
    }

    this.bias -= learningRate * error;

    const clipped = Math.min(1 - 1e-9, Math.max(1e-9, probability));
    const loss = weight * (-(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped)));
    return { probability, loss };
  }

  _trainBatchWithFallback(batch, learningRate, regularization, epochs) {
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const order = shuffleIndices(batch.vectors.length);
      for (const index of order) {
        this._trainExampleWithFallback(
          batch.vectors[index],
          batch.labels[index],
          learningRate,
          regularization,
          batch.sampleWeights[index]
        );
      }
    }

    const probabilities = batch.vectors.map(vector => this.predictProbability(vector));
    return resolveBatchMetrics(probabilities, batch.labels, batch.sampleWeights);
  }

  _createTensorFlowBatchResources(tf, vectors, labels, sampleWeights, learningRate) {
    const dimension = vectors[0]?.length ?? 0;
    return {
      x: tf.tensor2d(vectors, [vectors.length, dimension], 'float32'),
      target: tf.tensor2d(labels.map(label => [label]), [labels.length, 1], 'float32'),
      sampleWeightTensor: tf.tensor2d(sampleWeights.map(weight => [weight]), [sampleWeights.length, 1], 'float32'),
      weights: tf.variable(tf.tensor2d(this.weights, [dimension, 1], 'float32')),
      bias: tf.variable(tf.scalar(this.bias, 'float32')),
      optimizer: tf.train.sgd(learningRate),
    };
  }

  _disposeTensorFlowBatchResources(resources) {
    resources?.weights?.dispose?.();
    resources?.bias?.dispose?.();
    resources?.x?.dispose?.();
    resources?.target?.dispose?.();
    resources?.sampleWeightTensor?.dispose?.();
  }

  _createTensorFlowLossTensor(tf, x, target, sampleWeightTensor, weights, bias, regularization) {
    const logits = tf.add(tf.matMul(x, weights), bias);
    const probabilities = tf.sigmoid(logits);
    const clipped = tf.clipByValue(probabilities, 1e-7, 1 - 1e-7);
    const inverseTarget = tf.sub(tf.onesLike(target), target);
    const inverseClipped = tf.sub(tf.onesLike(clipped), clipped);
    const perExampleLoss = tf.neg(
      tf.add(
        tf.mul(target, tf.log(clipped)),
        tf.mul(inverseTarget, tf.log(inverseClipped))
      )
    );
    const weightedLoss = tf.div(
      tf.sum(tf.mul(perExampleLoss, sampleWeightTensor)),
      tf.sum(sampleWeightTensor)
    );

    if (regularization <= 0) return weightedLoss;
    return tf.add(weightedLoss, tf.mul(tf.scalar(regularization), tf.mean(tf.square(weights))));
  }

  _finalizeTensorFlowBatch(tf, x, target, sampleWeightTensor, weights, bias, regularization) {
    const metrics = tf.tidy(() => {
      const logits = tf.add(tf.matMul(x, weights), bias);
      const probabilities = tf.sigmoid(logits);
      return {
        probability: probabilities.slice([0, 0], [1, 1]),
        loss: this._createTensorFlowLossTensor(
          tf,
          x,
          target,
          sampleWeightTensor,
          weights,
          bias,
          regularization
        ),
      };
    });

    const probability = metrics.probability.dataSync()[0];
    const loss = metrics.loss.dataSync()[0];
    metrics.probability.dispose();
    metrics.loss.dispose();

    this.weights = Array.from(weights.dataSync());
    this.inputSize = x.shape?.[1] ?? this.inputSize;
    this.bias = bias.dataSync()[0];
    this._setTrainingOutcome('tensorflow');

    return { probability, loss };
  }

  _trainBatchWithTensorFlow(vectors, labels, sampleWeights, learningRate, regularization, epochs = 1) {
    const tf = getTensorFlow();
    const resources = this._createTensorFlowBatchResources(tf, vectors, labels, sampleWeights, learningRate);
    const {
      x,
      target,
      sampleWeightTensor,
      weights,
      bias,
      optimizer,
    } = resources;

    try {
      for (let epoch = 0; epoch < epochs; epoch += 1) {
        const loss = optimizer.minimize(() => tf.tidy(() => (
          this._createTensorFlowLossTensor(
            tf,
            x,
            target,
            sampleWeightTensor,
            weights,
            bias,
            regularization
          )
        )), true, [weights, bias]);

        loss?.dispose?.();
      }

      return this._finalizeTensorFlowBatch(
        tf,
        x,
        target,
        sampleWeightTensor,
        weights,
        bias,
        regularization
      );
    } finally {
      this._disposeTensorFlowBatchResources(resources);
    }
  }

  async _trainBatchWithTensorFlowAsync(vectors, labels, sampleWeights, learningRate, regularization, epochs = 1) {
    const tf = getTensorFlow();
    const resources = this._createTensorFlowBatchResources(tf, vectors, labels, sampleWeights, learningRate);
    const {
      x,
      target,
      sampleWeightTensor,
      weights,
      bias,
      optimizer,
    } = resources;

    try {
      for (let epoch = 0; epoch < epochs; epoch += 1) {
        const loss = optimizer.minimize(() => tf.tidy(() => (
          this._createTensorFlowLossTensor(
            tf,
            x,
            target,
            sampleWeightTensor,
            weights,
            bias,
            regularization
          )
        )), true, [weights, bias]);

        loss?.dispose?.();
        if (typeof tf.nextFrame === 'function') {
          await tf.nextFrame();
        } else {
          await delayToBackground();
        }
      }

      return this._finalizeTensorFlowBatch(
        tf,
        x,
        target,
        sampleWeightTensor,
        weights,
        bias,
        regularization
      );
    } finally {
      this._disposeTensorFlowBatchResources(resources);
    }
  }

  /**
   * Train against one labelled example using SGD.
   * Single-example updates stay on the math backend to avoid building a full
   * TensorFlow tensor pipeline for one weighted sum.
   *
   * @param {number[]} features
   * @param {number} label
   * @param {{learningRate?: number, regularization?: number, sampleWeight?: number}} [options={}]
   * @returns {{probability: number, loss: number}}
   */
  trainExample(features, label, options = {}) {
    const normalizedFeatures = Array.isArray(features)
      ? features.map(value => normalizeNumber(value, 0))
      : [];
    const learningRate = Math.max(0, normalizeNumber(options.learningRate, 0.1));
    const regularization = Math.max(0, normalizeNumber(options.regularization, 0));
    const sampleWeight = Math.max(0, normalizeNumber(options.sampleWeight, 1));
    this._ensureTrainingDimensions(normalizedFeatures.length);
    this._setTrainingOutcome('math');

    return this._trainExampleWithFallback(
      normalizedFeatures,
      label,
      learningRate,
      regularization,
      sampleWeight
    );
  }

  /**
   * @param {number[][]} vectors
   * @param {number[]} labels
   * @param {{learningRate?: number, regularization?: number, epochs?: number, sampleWeights?: number[]}} [options={}]
   * @returns {{probability: number, loss: number}}
   */
  trainBatch(vectors, labels, options = {}) {
    const batch = this._normalizeBatch(vectors, labels, options.sampleWeights);
    if (batch.vectors.length === 0) {
      this._setTrainingOutcome('math');
      return { probability: 0.5, loss: 0 };
    }

    const learningRate = Math.max(0, normalizeNumber(options.learningRate, 0.1));
    const regularization = Math.max(0, normalizeNumber(options.regularization, 0));
    const epochs = Math.max(1, Math.round(normalizeNumber(options.epochs, 1)));
    this._ensureTrainingDimensions(batch.dimension);

    if (getTensorFlow()) {
      try {
      return this._trainBatchWithTensorFlow(
        batch.vectors,
        batch.labels,
        batch.sampleWeights,
        learningRate,
        regularization,
        epochs
      );
      } catch (error) {
        warnTensorFlowFallback('batch training', error);
        this._setTrainingOutcome('math-fallback', error);
      }
    } else {
      this._setTrainingOutcome('math');
    }

    return this._trainBatchWithFallback(batch, learningRate, regularization, epochs);
  }

  /**
   * @param {number[][]} vectors
   * @param {number[]} labels
   * @param {{learningRate?: number, regularization?: number, epochs?: number, sampleWeights?: number[]}} [options={}]
   * @returns {Promise<{probability: number, loss: number}>}
   */
  async trainBatchAsync(vectors, labels, options = {}) {
    const batch = this._normalizeBatch(vectors, labels, options.sampleWeights);
    if (batch.vectors.length === 0) {
      this._setTrainingOutcome('math');
      return { probability: 0.5, loss: 0 };
    }

    const learningRate = Math.max(0, normalizeNumber(options.learningRate, 0.1));
    const regularization = Math.max(0, normalizeNumber(options.regularization, 0));
    const epochs = Math.max(1, Math.round(normalizeNumber(options.epochs, 1)));
    this._ensureTrainingDimensions(batch.dimension);

    if (getTensorFlow()) {
      try {
      return await this._trainBatchWithTensorFlowAsync(
        batch.vectors,
        batch.labels,
        batch.sampleWeights,
        learningRate,
        regularization,
        epochs
      );
      } catch (error) {
        warnTensorFlowFallback('async batch training', error);
        this._setTrainingOutcome('math-fallback', error);
      }
    } else {
      this._setTrainingOutcome('math');
    }

    return this._trainBatchWithFallback(batch, learningRate, regularization, epochs);
  }

  /**
   * @returns {{inputSize: number, weights: number[], bias: number}}
   */
  getState() {
    return {
      inputSize: this.inputSize || this.weights.length,
      weights: [...this.weights],
      bias: this.bias,
    };
  }
}
