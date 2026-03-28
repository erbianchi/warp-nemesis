/** @module SquadPolicyNetwork */

import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampScore(score) {
  return Math.max(-60, Math.min(60, score));
}

function sigmoid(score) {
  return 1 / (1 + Math.exp(-clampScore(score)));
}

function getTensorFlow() {
  const tf = globalThis.tf;
  if (!tf?.tensor2d || !tf?.variable || !tf?.train?.adam || !tf?.relu || !tf?.sigmoid) return null;
  return tf;
}

function mean(values) {
  if (!values.length) return 0.5;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function delayToBackground() {
  return new Promise(resolve => {
    globalThis.setTimeout?.(resolve, 0) ?? resolve();
  });
}

export class SquadPolicyNetwork {
  /**
   * @param {{
   *   inputSize?: number,
   *   hiddenUnits?: number,
   *   dense1Kernel?: number[],
   *   dense1Bias?: number[],
   *   dense2Kernel?: number[],
   *   dense2Bias?: number[],
   * }} [state={}]
   */
  constructor(state = {}) {
    this.inputSize = Math.max(0, Math.round(normalizeNumber(state.inputSize, 0)));
    this.hiddenUnits = Math.max(1, Math.round(normalizeNumber(
      state.hiddenUnits,
      ENEMY_LEARNING_CONFIG.squadHiddenUnits
    )));
    this.dense1Kernel = Array.isArray(state.dense1Kernel) ? state.dense1Kernel.map(v => normalizeNumber(v, 0)) : [];
    this.dense1Bias = Array.isArray(state.dense1Bias) ? state.dense1Bias.map(v => normalizeNumber(v, 0)) : [];
    this.dense2Kernel = Array.isArray(state.dense2Kernel) ? state.dense2Kernel.map(v => normalizeNumber(v, 0)) : [];
    this.dense2Bias = Array.isArray(state.dense2Bias) ? state.dense2Bias.map(v => normalizeNumber(v, 0)) : [];
  }

  _ensureDimensions(inputSize) {
    if (this.inputSize !== inputSize) {
      this.inputSize = inputSize;
      this.dense1Kernel = new Array(inputSize * this.hiddenUnits).fill(0);
      this.dense1Bias = new Array(this.hiddenUnits).fill(0);
      this.dense2Kernel = new Array(this.hiddenUnits * 3).fill(0);
      this.dense2Bias = new Array(3).fill(0);
      return;
    }

    while (this.dense1Kernel.length < this.inputSize * this.hiddenUnits) this.dense1Kernel.push(0);
    while (this.dense1Bias.length < this.hiddenUnits) this.dense1Bias.push(0);
    while (this.dense2Kernel.length < this.hiddenUnits * 3) this.dense2Kernel.push(0);
    while (this.dense2Bias.length < 3) this.dense2Bias.push(0);
  }

  predict(features) {
    this._ensureDimensions(features.length);
    const hidden = new Array(this.hiddenUnits).fill(0);

    for (let hiddenIndex = 0; hiddenIndex < this.hiddenUnits; hiddenIndex += 1) {
      let sum = this.dense1Bias[hiddenIndex];
      for (let inputIndex = 0; inputIndex < this.inputSize; inputIndex += 1) {
        sum += normalizeNumber(features[inputIndex], 0) * this.dense1Kernel[inputIndex * this.hiddenUnits + hiddenIndex];
      }
      hidden[hiddenIndex] = Math.max(0, sum);
    }

    const outputs = ['win', 'pressure', 'collision'];
    return outputs.reduce((predictions, key, outputIndex) => {
      let sum = this.dense2Bias[outputIndex];
      for (let hiddenIndex = 0; hiddenIndex < this.hiddenUnits; hiddenIndex += 1) {
        sum += hidden[hiddenIndex] * this.dense2Kernel[hiddenIndex * 3 + outputIndex];
      }
      predictions[key] = sigmoid(sum);
      return predictions;
    }, {});
  }

  _trainWithTensorFlow(vectors, labels, options) {
    const tf = getTensorFlow();
    const learningRate = Math.max(0, normalizeNumber(options.learningRate, ENEMY_LEARNING_CONFIG.squadLearningRate));
    const regularization = Math.max(0, normalizeNumber(options.regularization, ENEMY_LEARNING_CONFIG.squadRegularization));
    const epochs = Math.max(1, Math.round(normalizeNumber(options.epochs, ENEMY_LEARNING_CONFIG.squadTrainingEpochsPerRun)));
    const inputSize = vectors[0]?.length ?? 0;
    this._ensureDimensions(inputSize);

    const x = tf.tensor2d(vectors, [vectors.length, inputSize], 'float32');
    const y = tf.tensor2d(labels, [labels.length, 3], 'float32');
    const dense1Kernel = tf.variable(tf.tensor2d(this.dense1Kernel, [inputSize, this.hiddenUnits], 'float32'));
    const dense1Bias = tf.variable(tf.tensor1d(this.dense1Bias, 'float32'));
    const dense2Kernel = tf.variable(tf.tensor2d(this.dense2Kernel, [this.hiddenUnits, 3], 'float32'));
    const dense2Bias = tf.variable(tf.tensor1d(this.dense2Bias, 'float32'));
    const optimizer = tf.train.adam(learningRate);

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const loss = optimizer.minimize(() => {
        const hidden = tf.relu(tf.add(tf.matMul(x, dense1Kernel), dense1Bias));
        const logits = tf.add(tf.matMul(hidden, dense2Kernel), dense2Bias);
        const probabilities = tf.sigmoid(logits);
        const clipped = tf.clipByValue(probabilities, 1e-7, 1 - 1e-7);
        const inverseLabels = tf.sub(tf.onesLike(y), y);
        const inverseClipped = tf.sub(tf.onesLike(clipped), clipped);
        const crossEntropy = tf.neg(tf.mean(
          tf.add(
            tf.mul(y, tf.log(clipped)),
            tf.mul(inverseLabels, tf.log(inverseClipped))
          )
        ));

        if (regularization <= 0) return crossEntropy;
        const l2Penalty = tf.mul(
          tf.scalar(regularization, 'float32'),
          tf.add(tf.mean(tf.square(dense1Kernel)), tf.mean(tf.square(dense2Kernel)))
        );
        return tf.add(crossEntropy, l2Penalty);
      }, true, [dense1Kernel, dense1Bias, dense2Kernel, dense2Bias]);

      loss?.dispose?.();
    }

    const hidden = tf.relu(tf.add(tf.matMul(x, dense1Kernel), dense1Bias));
    const logits = tf.add(tf.matMul(hidden, dense2Kernel), dense2Bias);
    const probabilities = tf.sigmoid(logits).arraySync();

    this.dense1Kernel = Array.from(dense1Kernel.dataSync());
    this.dense1Bias = Array.from(dense1Bias.dataSync());
    this.dense2Kernel = Array.from(dense2Kernel.dataSync());
    this.dense2Bias = Array.from(dense2Bias.dataSync());

    x.dispose();
    y.dispose();
    hidden.dispose();
    logits.dispose();
    dense1Kernel.dispose();
    dense1Bias.dispose();
    dense2Kernel.dispose();
    dense2Bias.dispose();

    return probabilities;
  }

  async _trainWithTensorFlowAsync(vectors, labels, options) {
    const tf = getTensorFlow();
    const learningRate = Math.max(0, normalizeNumber(options.learningRate, ENEMY_LEARNING_CONFIG.squadLearningRate));
    const regularization = Math.max(0, normalizeNumber(options.regularization, ENEMY_LEARNING_CONFIG.squadRegularization));
    const epochs = Math.max(1, Math.round(normalizeNumber(options.epochs, ENEMY_LEARNING_CONFIG.squadTrainingEpochsPerRun)));
    const inputSize = vectors[0]?.length ?? 0;
    this._ensureDimensions(inputSize);

    const x = tf.tensor2d(vectors, [vectors.length, inputSize], 'float32');
    const y = tf.tensor2d(labels, [labels.length, 3], 'float32');
    const dense1Kernel = tf.variable(tf.tensor2d(this.dense1Kernel, [inputSize, this.hiddenUnits], 'float32'));
    const dense1Bias = tf.variable(tf.tensor1d(this.dense1Bias, 'float32'));
    const dense2Kernel = tf.variable(tf.tensor2d(this.dense2Kernel, [this.hiddenUnits, 3], 'float32'));
    const dense2Bias = tf.variable(tf.tensor1d(this.dense2Bias, 'float32'));
    const optimizer = tf.train.adam(learningRate);

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const loss = optimizer.minimize(() => {
        const hidden = tf.relu(tf.add(tf.matMul(x, dense1Kernel), dense1Bias));
        const logits = tf.add(tf.matMul(hidden, dense2Kernel), dense2Bias);
        const probabilities = tf.sigmoid(logits);
        const clipped = tf.clipByValue(probabilities, 1e-7, 1 - 1e-7);
        const inverseLabels = tf.sub(tf.onesLike(y), y);
        const inverseClipped = tf.sub(tf.onesLike(clipped), clipped);
        const crossEntropy = tf.neg(tf.mean(
          tf.add(
            tf.mul(y, tf.log(clipped)),
            tf.mul(inverseLabels, tf.log(inverseClipped))
          )
        ));

        if (regularization <= 0) return crossEntropy;
        const l2Penalty = tf.mul(
          tf.scalar(regularization, 'float32'),
          tf.add(tf.mean(tf.square(dense1Kernel)), tf.mean(tf.square(dense2Kernel)))
        );
        return tf.add(crossEntropy, l2Penalty);
      }, true, [dense1Kernel, dense1Bias, dense2Kernel, dense2Bias]);

      loss?.dispose?.();
      if (typeof tf.nextFrame === 'function') {
        await tf.nextFrame();
      } else {
        await delayToBackground();
      }
    }

    const hidden = tf.relu(tf.add(tf.matMul(x, dense1Kernel), dense1Bias));
    const logits = tf.add(tf.matMul(hidden, dense2Kernel), dense2Bias);
    const probabilities = tf.sigmoid(logits).arraySync();

    this.dense1Kernel = Array.from(dense1Kernel.dataSync());
    this.dense1Bias = Array.from(dense1Bias.dataSync());
    this.dense2Kernel = Array.from(dense2Kernel.dataSync());
    this.dense2Bias = Array.from(dense2Bias.dataSync());

    x.dispose();
    y.dispose();
    hidden.dispose();
    logits.dispose();
    dense1Kernel.dispose();
    dense1Bias.dispose();
    dense2Kernel.dispose();
    dense2Bias.dispose();

    return probabilities;
  }

  trainBatch(vectors, outputs, options = {}) {
    if (!Array.isArray(vectors) || vectors.length === 0) {
      return {
        win: 0.5,
        pressure: 0.5,
        collision: 0.5,
      };
    }

    const labels = outputs.map(output => [
      output?.win ? 1 : 0,
      output?.pressure ? 1 : 0,
      output?.collision ? 1 : 0,
    ]);

    let predictions;
    if (getTensorFlow()) {
      try {
        predictions = this._trainWithTensorFlow(vectors, labels, options);
      } catch {
        predictions = null;
      }
    }

    if (!predictions) {
      this._ensureDimensions(vectors[0].length);
      predictions = vectors.map(vector => this.predict(vector)).map(prediction => [
        prediction.win,
        prediction.pressure,
        prediction.collision,
      ]);
    }

    return {
      win: mean(predictions.map(prediction => prediction[0])),
      pressure: mean(predictions.map(prediction => prediction[1])),
      collision: mean(predictions.map(prediction => prediction[2])),
    };
  }

  async trainBatchAsync(vectors, outputs, options = {}) {
    if (!Array.isArray(vectors) || vectors.length === 0) {
      return {
        win: 0.5,
        pressure: 0.5,
        collision: 0.5,
      };
    }

    const labels = outputs.map(output => [
      output?.win ? 1 : 0,
      output?.pressure ? 1 : 0,
      output?.collision ? 1 : 0,
    ]);

    let predictions;
    if (getTensorFlow()) {
      try {
        predictions = await this._trainWithTensorFlowAsync(vectors, labels, options);
      } catch {
        predictions = null;
      }
    }

    if (!predictions) {
      return this.trainBatch(vectors, outputs, options);
    }

    return {
      win: mean(predictions.map(prediction => prediction[0])),
      pressure: mean(predictions.map(prediction => prediction[1])),
      collision: mean(predictions.map(prediction => prediction[2])),
    };
  }

  getState() {
    return {
      inputSize: this.inputSize,
      hiddenUnits: this.hiddenUnits,
      dense1Kernel: [...this.dense1Kernel],
      dense1Bias: [...this.dense1Bias],
      dense2Kernel: [...this.dense2Kernel],
      dense2Bias: [...this.dense2Bias],
    };
  }
}
