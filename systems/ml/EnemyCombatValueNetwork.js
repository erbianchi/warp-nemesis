/** @module EnemyCombatValueNetwork
 * 3-layer MLP with four sigmoid heads: survival, offense, collision risk, and
 * bullet risk.
 *
 * Architecture:
 *   input(N) -> Dense(H0, ReLU) -> Dense(H1, ReLU) -> Dense(H2, ReLU)
 *            -> Dense(1, Sigmoid)  [survival]
 *            -> Dense(1, Sigmoid)  [offense]
 *            -> Dense(1, Sigmoid)  [collision]
 *            -> Dense(1, Sigmoid)  [bullet]
 *
 * Joint loss: BCE over all four outputs.
 * Uses TensorFlow.js (Adam) when available; falls back to hand-rolled SGD
 * backprop. Weights are plain JSON arrays for localStorage persistence. */

function getTF() {
  const tf = globalThis.tf;
  return (tf?.tensor2d && tf?.variable && tf?.train?.adam && tf?.sigmoid) ? tf : null;
}

function normalizeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function relu(x) { return x > 0 ? x : 0; }
function sigmoid(x) { return 1 / (1 + Math.exp(-clamp(x, -60, 60))); }

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * normalizeNum(b[i], 0);
  return s;
}

function heInit(rows, cols) {
  const s = Math.sqrt(2 / Math.max(1, cols));
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (Math.random() * 2 - 1) * s)
  );
}

function heInit1d(n) {
  const s = Math.sqrt(2 / Math.max(1, n));
  return Array.from({ length: n }, () => (Math.random() * 2 - 1) * s);
}

function loadMatrix(arr) {
  return Array.isArray(arr) ? arr.map(row => Array.isArray(row) ? row.map(v => normalizeNum(v)) : []) : [];
}

function loadVector(arr) {
  return Array.isArray(arr) ? arr.map(v => normalizeNum(v)) : [];
}

function normalizeSampleWeights(raw, n) {
  const weights = Array.from({ length: n }, (_, i) => Math.max(0, normalizeNum(raw?.[i], 1)));
  const mean = weights.reduce((sum, value) => sum + value, 0) / Math.max(1, n);
  if (mean <= 0) return new Array(n).fill(1);
  return weights.map(value => value / mean);
}

function shuffleIndices(n) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function yieldFrame() {
  return new Promise(resolve => (globalThis.setTimeout?.(resolve, 0) ?? resolve()));
}

function resolveHeadLabels(options = {}, key, fallbackSize) {
  if (!Array.isArray(options?.[key])) {
    return new Array(fallbackSize).fill(0);
  }
  return options[key].map(value => clamp(normalizeNum(value, 0), 0, 1));
}

const HEAD_DEFS = Object.freeze([
  Object.freeze({ key: 'survival', weightsProp: '_wSurv', biasProp: '_bSurv', stateWeights: 'wSurv', stateBias: 'bSurv' }),
  Object.freeze({ key: 'offense', weightsProp: '_wOff', biasProp: '_bOff', stateWeights: 'wOff', stateBias: 'bOff' }),
  Object.freeze({ key: 'collision', weightsProp: '_wCollision', biasProp: '_bCollision', stateWeights: 'wCollision', stateBias: 'bCollision' }),
  Object.freeze({ key: 'bullet', weightsProp: '_wBullet', biasProp: '_bBullet', stateWeights: 'wBullet', stateBias: 'bBullet' }),
]);

/**
 * 3-layer MLP with survival, offense, collision-risk, and bullet-risk heads.
 */
export class EnemyCombatValueNetwork {
  /**
   * @param {{
   *   hiddenUnits?: number[],
   *   inputDim?: number,
   *   weights1?: number[][],  bias1?: number[],
   *   weights2?: number[][],  bias2?: number[],
   *   weights3?: number[][],  bias3?: number[],
   *   wSurv?: number[],       bSurv?: number,
   *   wOff?:  number[],       bOff?:  number,
   *   wCollision?: number[],  bCollision?: number,
   *   wBullet?: number[],     bBullet?: number,
   *   sampleCount?: number,
   * }} [state={}]
   */
  constructor(state = {}) {
    const rawUnits = Array.isArray(state.hiddenUnits) ? state.hiddenUnits : [48, 24, 12];
    this._h = rawUnits.map(u => Math.max(1, Math.round(normalizeNum(u, 16))));
    this._inputDim = Math.max(0, Math.round(normalizeNum(state.inputDim, 0)));
    this._w1 = loadMatrix(state.weights1);
    this._b1 = loadVector(state.bias1);
    this._w2 = loadMatrix(state.weights2);
    this._b2 = loadVector(state.bias2);
    this._w3 = loadMatrix(state.weights3);
    this._b3 = loadVector(state.bias3);
    this._wSurv = loadVector(state.wSurv);
    this._bSurv = normalizeNum(state.bSurv, 0);
    this._wOff = loadVector(state.wOff);
    this._bOff = normalizeNum(state.bOff, 0);
    this._wCollision = loadVector(state.wCollision);
    this._bCollision = normalizeNum(state.bCollision, 0);
    this._wBullet = loadVector(state.wBullet);
    this._bBullet = normalizeNum(state.bBullet, 0);
    this.sampleCount = Math.max(0, normalizeNum(state.sampleCount, 0));
    this._ensureHeadState();
  }

  get isTrained() {
    return (
      this._inputDim > 0
      && this._w1.length === this._h[0]
      && (this._w1[0]?.length ?? 0) === this._inputDim
      && this._wSurv.length === this._h[2]
      && this._wOff.length === this._h[2]
      && this._wCollision.length === this._h[2]
      && this._wBullet.length === this._h[2]
    );
  }

  static fromState(state, inputDim, hiddenUnits = [48, 24, 12]) {
    if (state && normalizeNum(state.inputDim) === inputDim) {
      return new EnemyCombatValueNetwork({ ...state, hiddenUnits });
    }
    return new EnemyCombatValueNetwork({ hiddenUnits });
  }

  _ensureHeadState() {
    const h2 = this._h[2];
    for (const head of HEAD_DEFS) {
      if (!Array.isArray(this[head.weightsProp]) || this[head.weightsProp].length !== h2) {
        this[head.weightsProp] = new Array(h2).fill(0);
      }
      if (!Number.isFinite(this[head.biasProp])) {
        this[head.biasProp] = 0;
      }
    }
  }

  _initWeights(inputDim) {
    if (this._inputDim === inputDim && this.isTrained) return;
    this._inputDim = inputDim;
    const [h0, h1, h2] = this._h;
    this._w1 = heInit(h0, inputDim);
    this._b1 = new Array(h0).fill(0);
    this._w2 = heInit(h1, h0);
    this._b2 = new Array(h1).fill(0);
    this._w3 = heInit(h2, h1);
    this._b3 = new Array(h2).fill(0);
    this._wSurv = heInit1d(h2);
    this._bSurv = 0;
    this._wOff = heInit1d(h2);
    this._bOff = 0;
    this._wCollision = heInit1d(h2);
    this._bCollision = 0;
    this._wBullet = heInit1d(h2);
    this._bBullet = 0;
  }

  _forward(input) {
    const H1 = this._b1.map((bias, index) => relu(bias + dot(this._w1[index], input)));
    const H2 = this._b2.map((bias, index) => relu(bias + dot(this._w2[index], H1)));
    const H3 = this._b3.map((bias, index) => relu(bias + dot(this._w3[index], H2)));
    return {
      H1,
      H2,
      H3,
      survival: sigmoid(this._bSurv + dot(this._wSurv, H3)),
      offense: sigmoid(this._bOff + dot(this._wOff, H3)),
      collision: sigmoid(this._bCollision + dot(this._wCollision, H3)),
      bullet: sigmoid(this._bBullet + dot(this._wBullet, H3)),
    };
  }

  /**
   * Predict probabilities for a feature vector.
   * Returns neutral probabilities when the network is untrained.
   * @param {number[]} features
   * @returns {{ survival: number, offense: number, collision: number, bullet: number }}
   */
  predict(features) {
    if (!this.isTrained) {
      return {
        survival: 0.5,
        offense: 0.5,
        collision: 0.5,
        bullet: 0.5,
      };
    }
    const input = Array.isArray(features) ? features.map(v => normalizeNum(v, 0)) : [];
    const { survival, offense, collision, bullet } = this._forward(input);
    return { survival, offense, collision, bullet };
  }

  /**
   * Synchronous batch training. Uses TF.js (Adam) when available, falls back
   * to hand-rolled SGD.
   *
   * `collisionLabels` and `bulletLabels` live in `options` to preserve the
   * original public call signature.
   *
   * @param {number[][]} vectors
   * @param {number[]} survivalLabels
   * @param {number[]} offenseLabels
   * @param {number[]} [sampleWeights]
   * @param {{ learningRate?: number, regularization?: number, epochs?: number, collisionLabels?: number[], bulletLabels?: number[] }} [options={}]
   * @returns {{ survivalLoss: number, offenseLoss: number, collisionLoss: number, bulletLoss: number }}
   */
  trainBatch(vectors, survivalLabels, offenseLabels, sampleWeights, options = {}) {
    if (!vectors?.length) {
      return {
        survivalLoss: 0,
        offenseLoss: 0,
        collisionLoss: 0,
        bulletLoss: 0,
      };
    }

    this._initWeights(vectors[0].length);
    const collisionLabels = resolveHeadLabels(options, 'collisionLabels', vectors.length);
    const bulletLabels = resolveHeadLabels(options, 'bulletLabels', vectors.length);
    const tf = getTF();
    if (tf) {
      try {
        return this._trainTFSync(
          vectors,
          survivalLabels,
          offenseLabels,
          collisionLabels,
          bulletLabels,
          sampleWeights,
          options,
          tf
        );
      } catch (err) {
        globalThis.console?.warn?.('[EnemyCombatValueNetwork] TF training failed; using JS fallback.', err);
      }
    }
    return this._trainJS(
      vectors,
      survivalLabels,
      offenseLabels,
      collisionLabels,
      bulletLabels,
      sampleWeights,
      options
    );
  }

  /**
   * Async batch training.
   * @param {number[][]} vectors
   * @param {number[]} survivalLabels
   * @param {number[]} offenseLabels
   * @param {number[]} [sampleWeights]
   * @param {{ learningRate?: number, regularization?: number, epochs?: number, collisionLabels?: number[], bulletLabels?: number[] }} [options={}]
   * @returns {Promise<{ survivalLoss: number, offenseLoss: number, collisionLoss: number, bulletLoss: number }>}
   */
  async trainBatchAsync(vectors, survivalLabels, offenseLabels, sampleWeights, options = {}) {
    if (!vectors?.length) {
      return {
        survivalLoss: 0,
        offenseLoss: 0,
        collisionLoss: 0,
        bulletLoss: 0,
      };
    }

    this._initWeights(vectors[0].length);
    const collisionLabels = resolveHeadLabels(options, 'collisionLabels', vectors.length);
    const bulletLabels = resolveHeadLabels(options, 'bulletLabels', vectors.length);
    const tf = getTF();
    if (tf) {
      try {
        return await this._trainTFAsync(
          vectors,
          survivalLabels,
          offenseLabels,
          collisionLabels,
          bulletLabels,
          sampleWeights,
          options,
          tf
        );
      } catch (err) {
        globalThis.console?.warn?.('[EnemyCombatValueNetwork] TF async training failed; using JS fallback.', err);
      }
    }
    return this._trainJS(
      vectors,
      survivalLabels,
      offenseLabels,
      collisionLabels,
      bulletLabels,
      sampleWeights,
      options
    );
  }

  _trainJS(vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels, sampleWeights, options) {
    const learningRate = Math.max(0, normalizeNum(options.learningRate, 0.001));
    const regularization = Math.max(0, normalizeNum(options.regularization, 0.0005));
    const epochs = Math.max(1, Math.round(normalizeNum(options.epochs, 8)));
    const sampleCount = vectors.length;
    const [h0, h1, h2] = this._h;
    const normalizedWeights = normalizeSampleWeights(sampleWeights, sampleCount);

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (const sampleIndex of shuffleIndices(sampleCount)) {
        const input = vectors[sampleIndex].map(v => normalizeNum(v, 0));
        const labels = {
          survival: clamp(normalizeNum(survivalLabels[sampleIndex], 0), 0, 1),
          offense: clamp(normalizeNum(offenseLabels[sampleIndex], 0), 0, 1),
          collision: clamp(normalizeNum(collisionLabels[sampleIndex], 0), 0, 1),
          bullet: clamp(normalizeNum(bulletLabels[sampleIndex], 0), 0, 1),
        };
        const sampleWeight = normalizedWeights[sampleIndex];
        const { H1, H2, H3, survival, offense, collision, bullet } = this._forward(input);
        const deltas = {
          survival: (survival - labels.survival) * sampleWeight,
          offense: (offense - labels.offense) * sampleWeight,
          collision: (collision - labels.collision) * sampleWeight,
          bullet: (bullet - labels.bullet) * sampleWeight,
        };

        for (const head of HEAD_DEFS) {
          const weights = this[head.weightsProp];
          const delta = deltas[head.key];
          for (let index = 0; index < h2; index += 1) {
            weights[index] -= learningRate * (delta * H3[index] + regularization * weights[index]);
          }
          this[head.biasProp] -= learningRate * delta;
        }

        const dH3 = Array.from({ length: h2 }, (_, hiddenIndex) => (
          (
            deltas.survival * this._wSurv[hiddenIndex]
            + deltas.offense * this._wOff[hiddenIndex]
            + deltas.collision * this._wCollision[hiddenIndex]
            + deltas.bullet * this._wBullet[hiddenIndex]
          ) * (H3[hiddenIndex] > 0 ? 1 : 0)
        ));

        for (let i = 0; i < h2; i += 1) {
          for (let j = 0; j < h1; j += 1) {
            this._w3[i][j] -= learningRate * (dH3[i] * H2[j] + regularization * this._w3[i][j]);
          }
          this._b3[i] -= learningRate * dH3[i];
        }

        const dH2 = Array.from({ length: h1 }, (_, hiddenIndex) => {
          let gradient = 0;
          for (let i = 0; i < h2; i += 1) gradient += dH3[i] * this._w3[i][hiddenIndex];
          return gradient * (H2[hiddenIndex] > 0 ? 1 : 0);
        });

        for (let i = 0; i < h1; i += 1) {
          for (let j = 0; j < h0; j += 1) {
            this._w2[i][j] -= learningRate * (dH2[i] * H1[j] + regularization * this._w2[i][j]);
          }
          this._b2[i] -= learningRate * dH2[i];
        }

        const dH1 = Array.from({ length: h0 }, (_, hiddenIndex) => {
          let gradient = 0;
          for (let i = 0; i < h1; i += 1) gradient += dH2[i] * this._w2[i][hiddenIndex];
          return gradient * (H1[hiddenIndex] > 0 ? 1 : 0);
        });

        for (let i = 0; i < h0; i += 1) {
          for (let j = 0; j < input.length; j += 1) {
            this._w1[i][j] -= learningRate * (dH1[i] * input[j] + regularization * this._w1[i][j]);
          }
          this._b1[i] -= learningRate * dH1[i];
        }
      }
    }

    return this._computeLosses(vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels);
  }

  _buildTFResources(tf, vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels, sampleWeights) {
    const sampleCount = vectors.length;
    const dim = vectors[0].length;
    const [h0, h1, h2] = this._h;
    const normalizedVectors = vectors.map(v => v.map(vv => normalizeNum(vv, 0)));
    const normalizedWeights = normalizeSampleWeights(sampleWeights, sampleCount);
    return {
      x: tf.tensor2d(normalizedVectors.flat(), [sampleCount, dim], 'float32'),
      yS: tf.tensor2d(survivalLabels.map(label => [clamp(normalizeNum(label, 0), 0, 1)]), [sampleCount, 1], 'float32'),
      yO: tf.tensor2d(offenseLabels.map(label => [clamp(normalizeNum(label, 0), 0, 1)]), [sampleCount, 1], 'float32'),
      yC: tf.tensor2d(collisionLabels.map(label => [clamp(normalizeNum(label, 0), 0, 1)]), [sampleCount, 1], 'float32'),
      yB: tf.tensor2d(bulletLabels.map(label => [clamp(normalizeNum(label, 0), 0, 1)]), [sampleCount, 1], 'float32'),
      sw: tf.tensor2d(normalizedWeights.map(weight => [weight]), [sampleCount, 1], 'float32'),
      W1: tf.variable(tf.tensor2d(this._w1.flat(), [h0, dim], 'float32')),
      B1: tf.variable(tf.tensor1d(this._b1, 'float32')),
      W2: tf.variable(tf.tensor2d(this._w2.flat(), [h1, h0], 'float32')),
      B2: tf.variable(tf.tensor1d(this._b2, 'float32')),
      W3: tf.variable(tf.tensor2d(this._w3.flat(), [h2, h1], 'float32')),
      B3: tf.variable(tf.tensor1d(this._b3, 'float32')),
      WS: tf.variable(tf.tensor2d(this._wSurv.map(value => [value]), [h2, 1], 'float32')),
      BS: tf.variable(tf.scalar(this._bSurv, 'float32')),
      WO: tf.variable(tf.tensor2d(this._wOff.map(value => [value]), [h2, 1], 'float32')),
      BO: tf.variable(tf.scalar(this._bOff, 'float32')),
      WC: tf.variable(tf.tensor2d(this._wCollision.map(value => [value]), [h2, 1], 'float32')),
      BC: tf.variable(tf.scalar(this._bCollision, 'float32')),
      WB: tf.variable(tf.tensor2d(this._wBullet.map(value => [value]), [h2, 1], 'float32')),
      BB: tf.variable(tf.scalar(this._bBullet, 'float32')),
    };
  }

  _disposeTFResources(resources) {
    for (const tensor of Object.values(resources)) tensor?.dispose?.();
  }

  _weightedBce(tf, prediction, labels, sampleWeights) {
    const clipped = tf.clipByValue(prediction, 1e-7, 1 - 1e-7);
    const ones = tf.onesLike(labels);
    const bce = tf.neg(tf.add(
      tf.mul(labels, tf.log(clipped)),
      tf.mul(tf.sub(ones, labels), tf.log(tf.sub(ones, clipped)))
    ));
    return tf.div(tf.sum(tf.mul(bce, sampleWeights)), tf.sum(sampleWeights));
  }

  _buildTFLoss(tf, resources, regularization) {
    return tf.tidy(() => {
      const {
        x, yS, yO, yC, yB, sw,
        W1, B1, W2, B2, W3, B3,
        WS, BS, WO, BO, WC, BC, WB, BB,
      } = resources;
      const H1 = tf.relu(tf.add(tf.matMul(x, tf.transpose(W1)), B1));
      const H2 = tf.relu(tf.add(tf.matMul(H1, tf.transpose(W2)), B2));
      const H3 = tf.relu(tf.add(tf.matMul(H2, tf.transpose(W3)), B3));
      const predS = tf.sigmoid(tf.add(tf.matMul(H3, WS), BS));
      const predO = tf.sigmoid(tf.add(tf.matMul(H3, WO), BO));
      const predC = tf.sigmoid(tf.add(tf.matMul(H3, WC), BC));
      const predB = tf.sigmoid(tf.add(tf.matMul(H3, WB), BB));
      let total = tf.addN([
        this._weightedBce(tf, predS, yS, sw),
        this._weightedBce(tf, predO, yO, sw),
        this._weightedBce(tf, predC, yC, sw),
        this._weightedBce(tf, predB, yB, sw),
      ]);
      if (regularization > 0) {
        const regTerm = tf.mul(tf.scalar(regularization), tf.addN([
          tf.mean(tf.square(W1)),
          tf.mean(tf.square(W2)),
          tf.mean(tf.square(W3)),
          tf.mean(tf.square(WS)),
          tf.mean(tf.square(WO)),
          tf.mean(tf.square(WC)),
          tf.mean(tf.square(WB)),
        ]));
        total = tf.add(total, regTerm);
      }
      return total;
    });
  }

  _extractTFWeights(resources) {
    const [h0, h1, h2] = this._h;
    const dim = this._inputDim;
    const w1d = Array.from(resources.W1.dataSync());
    const w2d = Array.from(resources.W2.dataSync());
    const w3d = Array.from(resources.W3.dataSync());
    this._w1 = Array.from({ length: h0 }, (_, index) => Array.from(w1d.slice(index * dim, (index + 1) * dim)));
    this._b1 = Array.from(resources.B1.dataSync());
    this._w2 = Array.from({ length: h1 }, (_, index) => Array.from(w2d.slice(index * h0, (index + 1) * h0)));
    this._b2 = Array.from(resources.B2.dataSync());
    this._w3 = Array.from({ length: h2 }, (_, index) => Array.from(w3d.slice(index * h1, (index + 1) * h1)));
    this._b3 = Array.from(resources.B3.dataSync());
    this._wSurv = Array.from(resources.WS.dataSync());
    this._bSurv = resources.BS.dataSync()[0];
    this._wOff = Array.from(resources.WO.dataSync());
    this._bOff = resources.BO.dataSync()[0];
    this._wCollision = Array.from(resources.WC.dataSync());
    this._bCollision = resources.BC.dataSync()[0];
    this._wBullet = Array.from(resources.WB.dataSync());
    this._bBullet = resources.BB.dataSync()[0];
  }

  _trainTFSync(vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels, sampleWeights, options, tf) {
    const learningRate = Math.max(0, normalizeNum(options.learningRate, 0.001));
    const regularization = Math.max(0, normalizeNum(options.regularization, 0.0005));
    const epochs = Math.max(1, Math.round(normalizeNum(options.epochs, 8)));
    const resources = this._buildTFResources(
      tf,
      vectors,
      survivalLabels,
      offenseLabels,
      collisionLabels,
      bulletLabels,
      sampleWeights
    );
    const allVars = [
      resources.W1, resources.B1,
      resources.W2, resources.B2,
      resources.W3, resources.B3,
      resources.WS, resources.BS,
      resources.WO, resources.BO,
      resources.WC, resources.BC,
      resources.WB, resources.BB,
    ];
    const optimizer = tf.train.adam(learningRate);
    try {
      for (let epoch = 0; epoch < epochs; epoch += 1) {
        const loss = optimizer.minimize(() => this._buildTFLoss(tf, resources, regularization), true, allVars);
        loss?.dispose?.();
      }
      this._extractTFWeights(resources);
    } finally {
      this._disposeTFResources(resources);
    }
    return this._computeLosses(vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels);
  }

  async _trainTFAsync(vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels, sampleWeights, options, tf) {
    const learningRate = Math.max(0, normalizeNum(options.learningRate, 0.001));
    const regularization = Math.max(0, normalizeNum(options.regularization, 0.0005));
    const epochs = Math.max(1, Math.round(normalizeNum(options.epochs, 8)));
    const resources = this._buildTFResources(
      tf,
      vectors,
      survivalLabels,
      offenseLabels,
      collisionLabels,
      bulletLabels,
      sampleWeights
    );
    const allVars = [
      resources.W1, resources.B1,
      resources.W2, resources.B2,
      resources.W3, resources.B3,
      resources.WS, resources.BS,
      resources.WO, resources.BO,
      resources.WC, resources.BC,
      resources.WB, resources.BB,
    ];
    const optimizer = tf.train.adam(learningRate);
    try {
      for (let epoch = 0; epoch < epochs; epoch += 1) {
        const loss = optimizer.minimize(() => this._buildTFLoss(tf, resources, regularization), true, allVars);
        loss?.dispose?.();
        await (typeof tf.nextFrame === 'function' ? tf.nextFrame() : yieldFrame());
      }
      this._extractTFWeights(resources);
    } finally {
      this._disposeTFResources(resources);
    }
    return this._computeLosses(vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels);
  }

  _computeLosses(vectors, survivalLabels, offenseLabels, collisionLabels, bulletLabels) {
    let survivalLoss = 0;
    let offenseLoss = 0;
    let collisionLoss = 0;
    let bulletLoss = 0;
    const sampleCount = vectors.length;

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const {
        survival,
        offense,
        collision,
        bullet,
      } = this._forward(vectors[sampleIndex].map(v => normalizeNum(v, 0)));
      const labels = {
        survival: clamp(normalizeNum(survivalLabels[sampleIndex], 0), 0, 1),
        offense: clamp(normalizeNum(offenseLabels[sampleIndex], 0), 0, 1),
        collision: clamp(normalizeNum(collisionLabels[sampleIndex], 0), 0, 1),
        bullet: clamp(normalizeNum(bulletLabels[sampleIndex], 0), 0, 1),
      };
      const probs = {
        survival: clamp(survival, 1e-9, 1 - 1e-9),
        offense: clamp(offense, 1e-9, 1 - 1e-9),
        collision: clamp(collision, 1e-9, 1 - 1e-9),
        bullet: clamp(bullet, 1e-9, 1 - 1e-9),
      };
      survivalLoss += -(labels.survival * Math.log(probs.survival) + (1 - labels.survival) * Math.log(1 - probs.survival));
      offenseLoss += -(labels.offense * Math.log(probs.offense) + (1 - labels.offense) * Math.log(1 - probs.offense));
      collisionLoss += -(labels.collision * Math.log(probs.collision) + (1 - labels.collision) * Math.log(1 - probs.collision));
      bulletLoss += -(labels.bullet * Math.log(probs.bullet) + (1 - labels.bullet) * Math.log(1 - probs.bullet));
    }

    return {
      survivalLoss: survivalLoss / sampleCount,
      offenseLoss: offenseLoss / sampleCount,
      collisionLoss: collisionLoss / sampleCount,
      bulletLoss: bulletLoss / sampleCount,
    };
  }

  /**
   * Plain-JSON state suitable for localStorage.
   * @returns {object}
   */
  getState() {
    return {
      inputDim: this._inputDim,
      hiddenUnits: [...this._h],
      weights1: this._w1.map(row => [...row]),
      bias1: [...this._b1],
      weights2: this._w2.map(row => [...row]),
      bias2: [...this._b2],
      weights3: this._w3.map(row => [...row]),
      bias3: [...this._b3],
      wSurv: [...this._wSurv],
      bSurv: this._bSurv,
      wOff: [...this._wOff],
      bOff: this._bOff,
      wCollision: [...this._wCollision],
      bCollision: this._bCollision,
      wBullet: [...this._wBullet],
      bBullet: this._bBullet,
      sampleCount: this.sampleCount,
    };
  }
}
