import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { EnemyCombatValueNetwork } = await import('../../../systems/ml/EnemyCombatValueNetwork.js');

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeVectors(n, dim) {
  return Array.from({ length: n }, () =>
    Array.from({ length: dim }, () => (Math.random() * 2 - 1))
  );
}

function meanOf(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('EnemyCombatValueNetwork', () => {

  // ── Construction and cold-start ────────────────────────────────────────────

  it('returns 0.5 / 0.5 when untrained', () => {
    const net = new EnemyCombatValueNetwork();
    const result = net.predict([0.1, 0.2, 0.3]);
    assert.strictEqual(result.survival, 0.5);
    assert.strictEqual(result.offense, 0.5);
  });

  it('isTrained is false before first training call', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    assert.strictEqual(net.isTrained, false);
  });

  it('isTrained becomes true after trainBatch', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    const vectors = makeVectors(3, 5);
    net.trainBatch(vectors, [1, 0, 1], [0, 1, 0]);
    assert.strictEqual(net.isTrained, true);
  });

  // ── Prediction range ───────────────────────────────────────────────────────

  it('predict() outputs are in (0, 1) for arbitrary finite input', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    net.trainBatch(makeVectors(4, 6), [1, 0, 1, 0], [0, 1, 0, 1]);
    const result = net.predict([100, -100, 0.5, -0.5, 1, 0]);
    assert.ok(result.survival > 0 && result.survival < 1, `survival ${result.survival} out of range`);
    assert.ok(result.offense  > 0 && result.offense  < 1, `offense ${result.offense} out of range`);
  });

  it('predict() tolerates NaN/undefined features — replaces with 0', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    net.trainBatch(makeVectors(2, 3), [1, 0], [0, 1]);
    const result = net.predict([undefined, NaN, 0.5]);
    assert.ok(result.survival >= 0 && result.survival <= 1);
    assert.ok(result.offense  >= 0 && result.offense  <= 1);
  });

  // ── Training convergence ───────────────────────────────────────────────────

  it('survival head converges toward 1 when all survival labels are 1', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [8, 8, 4] });
    const vectors = makeVectors(10, 4);
    const survival = new Array(10).fill(1);
    const offense  = new Array(10).fill(0.5);
    net.trainBatch(vectors, survival, offense, undefined, { learningRate: 0.05, epochs: 40 });
    const preds = vectors.map(v => net.predict(v).survival);
    assert.ok(meanOf(preds) > 0.6, `mean survival ${meanOf(preds)} did not converge toward 1`);
  });

  it('offense head converges toward 1 when all offense labels are 1', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [8, 8, 4] });
    const vectors = makeVectors(10, 4);
    const survival = new Array(10).fill(0.5);
    const offense  = new Array(10).fill(1);
    net.trainBatch(vectors, survival, offense, undefined, { learningRate: 0.05, epochs: 40 });
    const preds = vectors.map(v => net.predict(v).offense);
    assert.ok(meanOf(preds) > 0.6, `mean offense ${meanOf(preds)} did not converge toward 1`);
  });

  it('loss decreases over training epochs on a consistent dataset', () => {
    // Use a simple separable dataset so the trend is stable instead of relying on
    // a random draw that can occasionally wobble on a single head.
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [8, 8, 4] });
    const vectors = [
      [1, 1, 0.9, 0.8, 1],
      [0.9, 1, 0.8, 0.7, 0.9],
      [1, 0.8, 1, 0.9, 0.8],
      [0.8, 0.9, 0.7, 1, 0.9],
      [-1, -1, -0.9, -0.8, -1],
      [-0.9, -1, -0.8, -0.7, -0.9],
      [-1, -0.8, -1, -0.9, -0.8],
      [-0.8, -0.9, -0.7, -1, -0.9],
    ];
    const survLabels = [1, 1, 1, 1, 0, 0, 0, 0];
    const offLabels  = [1, 1, 1, 1, 0, 0, 0, 0];

    const firstPass = net.trainBatch(vectors, survLabels, offLabels, undefined, {
      learningRate: 0.03, epochs: 1,
    });
    const laterPass = net.trainBatch(vectors, survLabels, offLabels, undefined, {
      learningRate: 0.03, epochs: 24,
    });
    const initialLoss = firstPass.survivalLoss + firstPass.offenseLoss;
    const laterLoss = laterPass.survivalLoss + laterPass.offenseLoss;

    assert.ok(
      laterLoss < initialLoss,
      `later loss ${laterLoss} should be < first-pass loss ${initialLoss}`
    );
  });

  it('heads improve independently — training offense does not collapse survival to 0', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [8, 8, 4] });
    const vectors = makeVectors(10, 4);
    const survival = new Array(10).fill(0.8);
    const offense  = new Array(10).fill(0.9);
    net.trainBatch(vectors, survival, offense, undefined, { learningRate: 0.05, epochs: 30 });
    const survivalPreds = vectors.map(v => net.predict(v).survival);
    const offensePreds  = vectors.map(v => net.predict(v).offense);
    assert.ok(meanOf(survivalPreds) > 0.5, 'survival head should not collapse when offense also trained');
    assert.ok(meanOf(offensePreds)  > 0.5, 'offense head should not collapse when survival also trained');
  });

  // ── Separable clusters ─────────────────────────────────────────────────────

  it('learns that positive cluster has higher offense than negative cluster', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [16, 8, 4] });
    const posVectors = Array.from({ length: 6 }, () => [1, 0.9, 1]);
    const negVectors = Array.from({ length: 6 }, () => [0.05, 0.1, 0.05]);
    const vectors = [...posVectors, ...negVectors];
    const survLabels = [...new Array(6).fill(1), ...new Array(6).fill(0)];
    const offLabels  = [...new Array(6).fill(1), ...new Array(6).fill(0)];

    net.trainBatch(vectors, survLabels, offLabels, undefined, { learningRate: 0.04, epochs: 50 });

    const posOffense  = net.predict([1, 0.9, 1]).offense;
    const negOffense  = net.predict([0.05, 0.1, 0.05]).offense;
    const posSurvival = net.predict([1, 0.9, 1]).survival;
    const negSurvival = net.predict([0.05, 0.1, 0.05]).survival;

    assert.ok(posOffense  > negOffense,  `pos offense ${posOffense} should exceed neg ${negOffense}`);
    assert.ok(posSurvival > negSurvival, `pos survival ${posSurvival} should exceed neg ${negSurvival}`);
  });

  // ── Serialisation roundtrip ────────────────────────────────────────────────

  it('getState() / constructor roundtrip preserves predict() output', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    net.trainBatch(makeVectors(4, 5), [1, 0, 1, 0], [0, 1, 0, 1]);

    const state = net.getState();
    const net2  = new EnemyCombatValueNetwork(state);

    const input = [0.3, -0.1, 0.7, 0.0, 0.5];
    const r1 = net.predict(input);
    const r2 = net2.predict(input);

    assert.ok(Math.abs(r1.survival - r2.survival) < 1e-6, 'survival mismatch after roundtrip');
    assert.ok(Math.abs(r1.offense  - r2.offense)  < 1e-6, 'offense mismatch after roundtrip');
  });

  it('getState() result is plain JSON-serialisable', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    net.trainBatch(makeVectors(2, 3), [1, 0], [0, 1]);
    const state = net.getState();
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json);
    assert.ok(Array.isArray(parsed.weights1));
    assert.ok(Array.isArray(parsed.wSurv));
    assert.ok(Array.isArray(parsed.wOff));
    assert.strictEqual(typeof parsed.bSurv, 'number');
    assert.strictEqual(typeof parsed.bOff,  'number');
  });

  // ── fromState factory ──────────────────────────────────────────────────────

  it('fromState restores from a valid state', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    net.trainBatch(makeVectors(2, 3), [1, 0], [0, 1]);
    const state = net.getState();

    const restored = EnemyCombatValueNetwork.fromState(state, 3, [4, 4, 4]);
    const input = [0.1, 0.2, 0.3];
    const r1 = net.predict(input);
    const r2 = restored.predict(input);

    assert.ok(Math.abs(r1.survival - r2.survival) < 1e-6);
    assert.ok(Math.abs(r1.offense  - r2.offense)  < 1e-6);
  });

  it('fromState cold-starts when inputDim does not match', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    net.trainBatch(makeVectors(2, 3), [1, 0], [0, 1]);
    const state = net.getState();

    const cold = EnemyCombatValueNetwork.fromState(state, 10 /* different dim */, [4, 4, 4]);
    // Not yet trained for this input size — should return 0.5
    const result = cold.predict(new Array(10).fill(0));
    assert.strictEqual(result.survival, 0.5);
    assert.strictEqual(result.offense,  0.5);
  });

  // ── trainBatch with empty input ────────────────────────────────────────────

  it('trainBatch with empty vectors returns zero losses without throwing', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    const result = net.trainBatch([], [], []);
    assert.strictEqual(result.survivalLoss, 0);
    assert.strictEqual(result.offenseLoss,  0);
  });

  // ── sampleCount ────────────────────────────────────────────────────────────

  it('sampleCount is updated by caller and persisted in getState()', () => {
    const net = new EnemyCombatValueNetwork({ hiddenUnits: [4, 4, 4] });
    net.trainBatch(makeVectors(5, 3), [1, 0, 1, 0, 1], [0, 1, 0, 1, 0]);
    net.sampleCount = 5;
    const state = net.getState();
    assert.strictEqual(state.sampleCount, 5);
  });

});
