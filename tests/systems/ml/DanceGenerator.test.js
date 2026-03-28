import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  DanceGenerator,
  LEVEL2_WAVE_BLUEPRINTS,
} = await import('../../../systems/ml/DanceGenerator.js');
const {
  ACTION_MODES,
} = await import('../../../systems/ml/DanceWaypointNetwork.js');
const {
  EnemyFeatureEncoder,
} = await import('../../../systems/ml/EnemyFeatureEncoder.js');

function createEncoder() {
  return {
    buildSample(sample) {
      return sample;
    },
    encodeSample() {
      return { vector: new Array(33).fill(0) };
    },
  };
}

function createPrediction(mode, confidence = 0.78) {
  const probabilities = ACTION_MODES.map((actionMode) => (
    actionMode === mode
      ? confidence
      : (1 - confidence) / Math.max(1, ACTION_MODES.length - 1)
  ));

  return {
    mode,
    confidence,
    probabilities,
  };
}

function createNetwork(modes) {
  const calls = [];
  return {
    calls,
    predict(vector) {
      calls.push(vector);
      const mode = modes[(calls.length - 1) % modes.length];
      return createPrediction(mode);
    },
  };
}

function createResponsiveNetwork() {
  return {
    predict(vector) {
      const playerXNorm = vector[0] ?? 0.5;
      const heatRatio = vector[5] ?? 0;
      if (heatRatio > 0.55) return createPrediction('press', 0.84);
      if (playerXNorm < 0.42) return createPrediction('flank', 0.8);
      if (playerXNorm > 0.58) return createPrediction('evade', 0.76);
      return createPrediction('hold', 0.82);
    },
  };
}

function countPlanes(wave) {
  return wave.squadrons.reduce((sum, squadron) => sum + squadron.planes.length, 0);
}

function getCoreSquadron(wave) {
  return wave.squadrons.find((squadron) => squadron.id.includes('_core'));
}

function getSkirmDances(wave) {
  return wave.squadrons
    .filter((squadron) => squadron.planes.every((plane) => plane.type === 'skirm'))
    .map((squadron) => squadron.dance);
}

describe('DanceGenerator', () => {
  it('queries the network across multiple beats and returns static Level 2 waves', () => {
    const network = createNetwork(['hold', 'flank', 'press']);
    const generator = new DanceGenerator({
      network,
      encoder: createEncoder(),
      rng: () => 0.5,
    });

    const waves = generator.generateWaves();

    assert.equal(waves.length, LEVEL2_WAVE_BLUEPRINTS.length);
    assert.ok(network.calls.length > waves.length, 'expected multi-beat network queries per wave');
    waves.forEach((wave, index) => {
      assert.equal(wave.id, index + 1);
      assert.ok(Array.isArray(wave.squadrons) && wave.squadrons.length >= 1);
    });
  });

  it('builds a mirrored controller path for the main squadron', () => {
    const generator = new DanceGenerator({
      network: createNetwork(['hold', 'flank', 'press']),
      encoder: createEncoder(),
      rng: () => 0.5,
    });

    const [wave] = generator.generateWaves(1);
    const core = getCoreSquadron(wave);
    const nonCenterSteps = core.controller.path.filter((step) => Math.abs(step.xPct - 0.5) > 0.001);

    assert.ok(nonCenterSteps.length >= 4);
    assert.ok(core.controller.path.some((step) => Math.abs(step.xPct - 0.5) < 0.001));

    nonCenterSteps.forEach((step) => {
      const mirrored = nonCenterSteps.find((candidate) => (
        candidate !== step
        && Math.abs((candidate.xPct + step.xPct) - 1) < 0.002
        && Math.abs(candidate.yPct - step.yPct) < 0.002
      ));
      assert.ok(
        mirrored,
        `missing mirrored step for (${step.xPct}, ${step.yPct})`
      );
    });
  });

  it('escalates total enemy counts across the three generated waves', () => {
    const generator = new DanceGenerator({
      network: createNetwork(['press']),
      encoder: createEncoder(),
      rng: () => 0.5,
    });

    const waves = generator.generateWaves();
    const totals = waves.map(countPlanes);

    assert.ok(totals[0] < totals[1], `expected wave 2 to exceed wave 1: ${totals.join(', ')}`);
    assert.ok(totals[1] < totals[2], `expected wave 3 to exceed wave 2: ${totals.join(', ')}`);
    assert.ok(waves[0].squadrons.some((squadron) => squadron.id.includes('support_left')));
    assert.ok(waves[1].squadrons.some((squadron) => squadron.id.includes('cutters_left')));
    assert.ok(waves[2].squadrons.some((squadron) => squadron.id.includes('raptors_right')));
  });

  it('does not reuse the exact same visible skirm dance family in all three waves', () => {
    const generator = new DanceGenerator({
      network: createNetwork(['press']),
      encoder: createEncoder(),
      rng: () => 0.5,
    });

    const waves = generator.generateWaves();
    const nonStraightSupportDances = waves.flatMap((wave) => (
      getSkirmDances(wave).filter((dance) => dance !== 'straight')
    ));

    waves.forEach((wave) => {
      assert.ok(
        getSkirmDances(wave).some((dance) => dance !== 'straight'),
        `expected wave ${wave.id} to include a non-straight skirm dance`
      );
    });
    assert.ok(
      new Set(nonStraightSupportDances).size >= 3,
      `expected at least three distinct support dances, got ${nonStraightSupportDances.join(', ')}`
    );
  });

  it('turns press-heavy predictions into more aggressive controllers than cautious predictions', () => {
    const pressGenerator = new DanceGenerator({
      network: createNetwork(['press']),
      encoder: createEncoder(),
      rng: () => 0.5,
    });
    const cautiousGenerator = new DanceGenerator({
      network: createNetwork(['retreat', 'evade']),
      encoder: createEncoder(),
      rng: () => 0.5,
    });

    const pressCore = getCoreSquadron(pressGenerator.generateWaves(1)[0]);
    const cautiousCore = getCoreSquadron(cautiousGenerator.generateWaves(1)[0]);
    const pressWave = pressGenerator.generateWaves(1)[0];
    const cautiousWave = cautiousGenerator.generateWaves(1)[0];

    assert.equal(pressCore.controller.shotCadence.pathPattern, 'wings');
    assert.equal(cautiousCore.controller.shotCadence.pathPattern, 'single');
    assert.ok(pressCore.controller.shootRate > cautiousCore.controller.shootRate);
    assert.ok(pressWave.difficultyFactor > cautiousWave.difficultyFactor);
  });

  it('injects generated waves into the target level config', () => {
    const levels = [
      { id: 1, waves: [{}] },
      { id: 2, runtimeWaveSource: 'dance_generator', waves: [] },
    ];
    const generator = new DanceGenerator({
      network: createNetwork(['hold', 'press', 'flank']),
      encoder: createEncoder(),
      rng: () => 0.5,
    });

    const waves = generator.generateAndInjectWaves(levels, 1);

    assert.equal(levels[1].waves, waves);
    assert.equal(levels[1].waves.length, LEVEL2_WAVE_BLUEPRINTS.length);
  });

  it('conditions Level 2 wave generation on the player style profile', () => {
    const encoder = new EnemyFeatureEncoder();
    const aggressiveLeft = new DanceGenerator({
      network: createResponsiveNetwork(),
      encoder,
      rng: () => 0.5,
      playerStyleProfile: {
        sampleCount: 24,
        laneBiasX: -0.72,
        aggression: 0.56,
        dodgeIntensity: 0.48,
        reversalRate: 0.32,
        heatGreed: 0.82,
        overheatRate: 0.24,
        shieldReliance: 0.3,
        hpRatio: 0.72,
        shieldRatio: 0.24,
        pressureExposure: 0.58,
        enemyDensity: 0.44,
        nearestEnemyDistanceNorm: 0.42,
        preferredWeaponKey: 'laser',
      },
    });
    const calmCenter = new DanceGenerator({
      network: createResponsiveNetwork(),
      encoder,
      rng: () => 0.5,
      playerStyleProfile: {
        sampleCount: 24,
        laneBiasX: 0,
        aggression: 0.14,
        dodgeIntensity: 0.08,
        reversalRate: 0.04,
        heatGreed: 0.1,
        overheatRate: 0,
        shieldReliance: 0.76,
        hpRatio: 0.94,
        shieldRatio: 0.82,
        pressureExposure: 0.1,
        enemyDensity: 0.2,
        nearestEnemyDistanceNorm: 0.92,
        preferredWeaponKey: 'laser',
      },
    });

    const aggressiveWave = aggressiveLeft.generateWaves(1)[0];
    const calmWave = calmCenter.generateWaves(1)[0];

    assert.notDeepEqual(aggressiveWave._generatedModes, calmWave._generatedModes);
    assert.ok(aggressiveWave.difficultyFactor > calmWave.difficultyFactor);
    assert.ok(countPlanes(aggressiveWave) >= countPlanes(calmWave));
    assert.equal(aggressiveWave._generatedPlayerStyle.laneBiasX, -0.72);
    assert.equal(calmWave._generatedPlayerStyle.laneBiasX, 0);
  });
});
