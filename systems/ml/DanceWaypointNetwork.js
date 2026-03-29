/** @module DanceWaypointNetwork
 * 2-layer MLP: state features → action-mode probability distribution.
 * Output classes: hold / press / flank / evade / retreat (5 outputs).
 *
 * Uses TensorFlow.js when available; falls back to hand-rolled forward/backprop
 * so unit tests and server-side tooling work without a browser. */

import {
  ENEMY_ACTION_MODE_COUNT,
  ENEMY_ACTION_MODE_OFFSET,
} from './EnemyFeatureEncoder.js';

export const ACTION_MODES = Object.freeze(['hold', 'press', 'flank', 'evade', 'retreat']);

// Indices of the action-mode one-hot block inside the full EnemyFeatureEncoder
// vector.  These features are STRIPPED from the input to avoid a circular
// dependency (we are predicting the mode, not conditioning on it).
export const ACTION_MODE_OFFSET = ENEMY_ACTION_MODE_OFFSET;
export const ACTION_MODE_COUNT  = ENEMY_ACTION_MODE_COUNT;

const NUM_MODES = ACTION_MODES.length;

// ── Helpers ────────────────────────────────────────────────────────────────────

function getTF() {
  const tf = globalThis.tf;
  return (tf?.tensor2d && tf?.variable && tf?.train?.adam && tf?.softmax) ? tf : null;
}

function normalizeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function relu(x) { return x > 0 ? x : 0; }

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1e-9;
  return exps.map(v => v / sum);
}

/** Temperature-scaled categorical sample.  temperature > 1 → more random. */
function sampleCategorical(probs, temperature) {
  const t = Math.max(temperature, 0.01);
  const scaled = softmax(probs.map(p => Math.log(Math.max(p, 1e-9)) / t));
  let r = Math.random();
  for (let i = 0; i < scaled.length; i++) {
    r -= scaled[i];
    if (r <= 0) return i;
  }
  return scaled.length - 1;
}

function yieldFrame() {
  return new Promise(resolve => (globalThis.setTimeout?.(resolve, 0) ?? resolve()));
}

// ── DanceWaypointNetwork ───────────────────────────────────────────────────────

/**
 * Tiny 2-layer classification network:
 *   input(N) → Dense(hiddenUnits, ReLU) → Dense(5, Softmax)
 *
 * Input vectors must have the ACTION_MODE features stripped out
 * (use stripActionModes(vector) before passing here).
 */
export class DanceWaypointNetwork {
  /**
   * @param {{
   *   inputDim?:     number,
   *   hiddenUnits?:  number,
   *   weights1?:     number[][],
   *   bias1?:        number[],
   *   weights2?:     number[][],
   *   bias2?:        number[],
   *   sampleCount?:  number,
   *   lastAccuracy?: number,
   * }} [state={}]
   */
  constructor(state = {}) {
    this._hiddenUnits = Math.max(1, Math.round(normalizeNum(state.hiddenUnits, 16)));
    this._inputDim    = Math.max(0, Math.round(normalizeNum(state.inputDim, 0)));
    this._w1 = Array.isArray(state.weights1) ? state.weights1.map(r => r.map(v => normalizeNum(v))) : [];
    this._b1 = Array.isArray(state.bias1)    ? state.bias1.map(v => normalizeNum(v)) : [];
    this._w2 = Array.isArray(state.weights2) ? state.weights2.map(r => r.map(v => normalizeNum(v))) : [];
    this._b2 = Array.isArray(state.bias2)    ? state.bias2.map(v => normalizeNum(v)) : [];
    /** Number of training examples seen across all runs. */
    this.sampleCount  = Math.max(0, normalizeNum(state.sampleCount, 0));
    /** Accuracy on the last training batch (0–1). */
    this.lastAccuracy = normalizeNum(state.lastAccuracy, 0);
  }

  /** True when the network has been initialised and is ready to infer. */
  get isTrained() {
    return this._w1.length === this._hiddenUnits && this._inputDim > 0;
  }

  // ── Weight initialisation ──────────────────────────────────────────────────

  _initWeights(inputDim) {
    if (this._inputDim === inputDim && this.isTrained) return;
    this._inputDim = inputDim;
    const s1 = Math.sqrt(2 / (inputDim + this._hiddenUnits));
    const s2 = Math.sqrt(2 / (this._hiddenUnits + NUM_MODES));
    this._w1 = Array.from({ length: this._hiddenUnits }, () =>
      Array.from({ length: inputDim }, () => (Math.random() * 2 - 1) * s1)
    );
    this._b1 = new Array(this._hiddenUnits).fill(0);
    this._w2 = Array.from({ length: NUM_MODES }, () =>
      Array.from({ length: this._hiddenUnits }, () => (Math.random() * 2 - 1) * s2)
    );
    this._b2 = new Array(NUM_MODES).fill(0);
  }

  // ── Inference ──────────────────────────────────────────────────────────────

  _forward(input) {
    const hidden = this._b1.map((b, i) =>
      relu(b + this._w1[i].reduce((s, w, j) => s + w * normalizeNum(input[j], 0), 0))
    );
    const logits = this._b2.map((b, i) =>
      b + this._w2[i].reduce((s, w, j) => s + w * hidden[j], 0)
    );
    return { hidden, logits, probabilities: softmax(logits) };
  }

  /**
   * Sample an action mode using the learned distribution.
   * Returns a uniform random sample if the network is untrained.
   * @param {number[]} vector  — stripped feature vector (no action-mode features)
   * @param {number}   [temperature=1.0]
   * @returns {{ mode: string, probabilities: number[] }}
   */
  sample(vector, temperature = 1.0) {
    if (!this.isTrained) {
      const idx = Math.floor(Math.random() * NUM_MODES);
      return { mode: ACTION_MODES[idx], probabilities: ACTION_MODES.map(() => 1 / NUM_MODES) };
    }
    const { probabilities } = this._forward(vector);
    return { mode: ACTION_MODES[sampleCategorical(probabilities, temperature)], probabilities };
  }

  /**
   * Deterministic argmax prediction (for generation, not runtime sampling).
   * @param {number[]} vector  — stripped feature vector
   * @returns {{ mode: string, probabilities: number[], confidence: number }}
   */
  predict(vector) {
    if (!this.isTrained) {
      return { mode: 'hold', probabilities: ACTION_MODES.map(() => 1 / NUM_MODES), confidence: 1 / NUM_MODES };
    }
    const { probabilities } = this._forward(vector);
    const best = probabilities.indexOf(Math.max(...probabilities));
    return { mode: ACTION_MODES[best], probabilities, confidence: probabilities[best] };
  }

  // ── Training ───────────────────────────────────────────────────────────────

  /**
   * @param {number[][]} vectors  — stripped input feature vectors
   * @param {number[][]} labels   — one-hot action-mode targets  [NUM_MODES]
   * @param {{ learningRate?: number, regularization?: number, epochs?: number }} [options={}]
   * @returns {{ accuracy: number }}
   */
  trainBatch(vectors, labels, options = {}) {
    if (!vectors.length) return { accuracy: 0 };
    this._initWeights(vectors[0].length);
    const tf = getTF();
    if (tf) {
      try { return this._trainTF(vectors, labels, options, false); } catch {}
    }
    return this._trainJS(vectors, labels, options);
  }

  /**
   * @param {number[][]} vectors
   * @param {number[][]} labels
   * @param {{ learningRate?: number, regularization?: number, epochs?: number }} [options={}]
   * @returns {Promise<{ accuracy: number }>}
   */
  async trainBatchAsync(vectors, labels, options = {}) {
    if (!vectors.length) return { accuracy: 0 };
    this._initWeights(vectors[0].length);
    const tf = getTF();
    if (tf) {
      try { return await this._trainTF(vectors, labels, options, true); } catch {}
    }
    return this._trainJS(vectors, labels, options);
  }

  _trainJS(vectors, labels, options) {
    const lr     = normalizeNum(options.learningRate, 0.08);
    const reg    = normalizeNum(options.regularization, 0.001);
    const epochs = Math.max(1, Math.round(normalizeNum(options.epochs, 10)));
    const n = vectors.length;

    for (let ep = 0; ep < epochs; ep++) {
      for (let s = 0; s < n; s++) {
        const inp = vectors[s];
        const tgt = labels[s];
        const { hidden, logits } = this._forward(inp);
        const probs = softmax(logits);

        // dL/d(logits) = probs − onehot  (softmax cross-entropy gradient)
        const dL = probs.map((p, i) => p - (tgt[i] ?? 0));

        for (let i = 0; i < NUM_MODES; i++) {
          for (let j = 0; j < this._hiddenUnits; j++) {
            this._w2[i][j] -= lr * (dL[i] * hidden[j] + reg * this._w2[i][j]);
          }
          this._b2[i] -= lr * dL[i];
        }

        const dH = new Array(this._hiddenUnits).fill(0);
        for (let j = 0; j < this._hiddenUnits; j++) {
          for (let i = 0; i < NUM_MODES; i++) dH[j] += dL[i] * this._w2[i][j];
          dH[j] *= hidden[j] > 0 ? 1 : 0; // ReLU derivative
        }

        for (let j = 0; j < this._hiddenUnits; j++) {
          for (let k = 0; k < inp.length; k++) {
            this._w1[j][k] -= lr * (dH[j] * normalizeNum(inp[k], 0) + reg * this._w1[j][k]);
          }
          this._b1[j] -= lr * dH[j];
        }
      }
    }

    return { accuracy: this._accuracy(vectors, labels) };
  }

  async _trainTF(vectors, labels, options, isAsync) {
    const tf  = getTF();
    const lr  = normalizeNum(options.learningRate, 0.08);
    const reg = normalizeNum(options.regularization, 0.001);
    const epochs = Math.max(1, Math.round(normalizeNum(options.epochs, 10)));
    const dim = vectors[0].length;

    const normV = vectors.map(v => v.map(vv => normalizeNum(vv, 0)));
    const x  = tf.tensor2d(normV.flat(), [vectors.length, dim], 'float32');
    const y  = tf.tensor2d(labels.flat(), [labels.length, NUM_MODES], 'float32');
    const w1 = tf.variable(tf.tensor2d(this._w1.flat(), [this._hiddenUnits, dim], 'float32'));
    const b1 = tf.variable(tf.tensor1d(this._b1, 'float32'));
    const w2 = tf.variable(tf.tensor2d(this._w2.flat(), [NUM_MODES, this._hiddenUnits], 'float32'));
    const b2 = tf.variable(tf.tensor1d(this._b2, 'float32'));

    const opt = tf.train.adam(lr);

    for (let ep = 0; ep < epochs; ep++) {
      const loss = opt.minimize(() => {
        const h      = tf.relu(tf.add(tf.matMul(x, tf.transpose(w1)), b1));
        const logits = tf.add(tf.matMul(h, tf.transpose(w2)), b2);
        h.dispose();
        const ce = tf.mean(tf.losses.softmaxCrossEntropy(y, logits));
        logits.dispose();
        if (reg <= 0) return ce;
        const r = tf.mul(tf.scalar(reg), tf.add(tf.mean(tf.square(w1)), tf.mean(tf.square(w2))));
        return tf.add(ce, r);
      }, true, [w1, b1, w2, b2]);
      loss?.dispose?.();
      if (isAsync) await (typeof tf.nextFrame === 'function' ? tf.nextFrame() : yieldFrame());
    }

    const w1d = Array.from(w1.dataSync());
    const w2d = Array.from(w2.dataSync());
    this._w1 = Array.from({ length: this._hiddenUnits }, (_, i) =>
      Array.from(w1d.slice(i * dim, (i + 1) * dim)));
    this._b1 = Array.from(b1.dataSync());
    this._w2 = Array.from({ length: NUM_MODES }, (_, i) =>
      Array.from(w2d.slice(i * this._hiddenUnits, (i + 1) * this._hiddenUnits)));
    this._b2 = Array.from(b2.dataSync());

    const accuracy = this._accuracy(vectors, labels);
    [x, y, w1, b1, w2, b2].forEach(t => t?.dispose?.());
    return { accuracy };
  }

  _accuracy(vectors, labels) {
    let correct = 0;
    for (let s = 0; s < vectors.length; s++) {
      const { probabilities } = this._forward(vectors[s]);
      if (probabilities.indexOf(Math.max(...probabilities)) ===
          labels[s].indexOf(Math.max(...labels[s]))) correct++;
    }
    return correct / vectors.length;
  }

  // ── Serialisation ──────────────────────────────────────────────────────────

  /** @returns {object} Plain-JSON state suitable for localStorage. */
  getState() {
    return {
      inputDim:     this._inputDim,
      hiddenUnits:  this._hiddenUnits,
      weights1:     this._w1.map(r => [...r]),
      bias1:        [...this._b1],
      weights2:     this._w2.map(r => [...r]),
      bias2:        [...this._b2],
      sampleCount:  this.sampleCount,
      lastAccuracy: this.lastAccuracy,
    };
  }
}

/**
 * Strip the action-mode one-hot block from a full EnemyFeatureEncoder vector.
 * @param {number[]} vector
 * @returns {number[]}
 */
export function stripActionModes(vector) {
  return [
    ...vector.slice(0, ACTION_MODE_OFFSET),
    ...vector.slice(ACTION_MODE_OFFSET + ACTION_MODE_COUNT),
  ];
}
