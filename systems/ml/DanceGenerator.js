/** @module DanceGenerator
 * Generates Level 2 waves dynamically from the learned dance network.
 *
 * The old generator chose a single mode per wave and translated it into a
 * coarse formation. This version queries the network across several beats per
 * wave, then turns that phrase sequence into a symmetric controller path plus
 * mirrored support squadrons. The result is still TensorFlow-guided, but the
 * authored scaffolding keeps the choreography readable and tense.
 */

import { ACTION_MODES, stripActionModes } from './DanceWaypointNetwork.js';
import { GAME_CONFIG } from '../../config/game.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { clamp } from '../../utils/math.js';

const { WIDTH: W, HEIGHT: H } = GAME_CONFIG;

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, clonePlain(inner)])
    );
  }
  return value;
}

const DEFAULT_PLAYER_STYLE_PROFILE = Object.freeze({
  sampleCount: 0,
  laneBiasX: 0,
  aggression: 0.18,
  dodgeIntensity: 0,
  reversalRate: 0,
  heatGreed: 0.12,
  overheatRate: 0,
  shieldReliance: 0.45,
  hpRatio: 1,
  shieldRatio: 0.6,
  pressureExposure: 0,
  enemyDensity: 0,
  nearestEnemyDistanceNorm: 1,
  preferredWeaponKey: 'laser',
});

function normalizePlayerStyleProfile(profile = {}) {
  return {
    sampleCount: Math.max(0, Math.round(profile?.sampleCount ?? DEFAULT_PLAYER_STYLE_PROFILE.sampleCount)),
    laneBiasX: clamp(profile?.laneBiasX ?? DEFAULT_PLAYER_STYLE_PROFILE.laneBiasX, -1, 1),
    aggression: clamp(profile?.aggression ?? DEFAULT_PLAYER_STYLE_PROFILE.aggression, 0, 1),
    dodgeIntensity: clamp(profile?.dodgeIntensity ?? DEFAULT_PLAYER_STYLE_PROFILE.dodgeIntensity, 0, 1),
    reversalRate: clamp(profile?.reversalRate ?? DEFAULT_PLAYER_STYLE_PROFILE.reversalRate, 0, 1),
    heatGreed: clamp(profile?.heatGreed ?? DEFAULT_PLAYER_STYLE_PROFILE.heatGreed, 0, 1),
    overheatRate: clamp(profile?.overheatRate ?? DEFAULT_PLAYER_STYLE_PROFILE.overheatRate, 0, 1),
    shieldReliance: clamp(profile?.shieldReliance ?? DEFAULT_PLAYER_STYLE_PROFILE.shieldReliance, 0, 1),
    hpRatio: clamp(profile?.hpRatio ?? DEFAULT_PLAYER_STYLE_PROFILE.hpRatio, 0, 1),
    shieldRatio: clamp(profile?.shieldRatio ?? DEFAULT_PLAYER_STYLE_PROFILE.shieldRatio, 0, 1),
    pressureExposure: clamp(profile?.pressureExposure ?? DEFAULT_PLAYER_STYLE_PROFILE.pressureExposure, 0, 1),
    enemyDensity: clamp(profile?.enemyDensity ?? DEFAULT_PLAYER_STYLE_PROFILE.enemyDensity, 0, 1),
    nearestEnemyDistanceNorm: clamp(
      profile?.nearestEnemyDistanceNorm ?? DEFAULT_PLAYER_STYLE_PROFILE.nearestEnemyDistanceNorm,
      0,
      1.5
    ),
    preferredWeaponKey: typeof profile?.preferredWeaponKey === 'string' && profile.preferredWeaponKey.length > 0
      ? profile.preferredWeaponKey
      : DEFAULT_PLAYER_STYLE_PROFILE.preferredWeaponKey,
  };
}

function modeProbability(prediction, mode) {
  const modeIndex = ACTION_MODES.indexOf(mode);
  if (modeIndex < 0) return 0;
  return clamp(prediction?.probabilities?.[modeIndex] ?? 0, 0, 1);
}

function resolveRounded(value, min, max) {
  return Math.round(clamp(value, min, max));
}

function createSkirmPlanes(count, resolver = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'skirm',
    ...resolver(index, count),
  }));
}

function createRaptorPlanes(count, resolver = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'raptor',
    ...resolver(index, count),
  }));
}

function resolveSymmetricPreset(index, count, options = {}) {
  const center = (count - 1) / 2;
  const mirrorDistance = Math.abs(index - center);

  if (mirrorDistance <= (options.aceBand ?? 0.55)) return 'ace';
  if (mirrorDistance >= (options.heavyBand ?? Math.max(2.2, count / 2 - 0.6))) return 'heavy';
  if (((Math.round(mirrorDistance * 10) / 10) % 1) < 0.15 && mirrorDistance >= 1.5) return 'light';
  return null;
}

function buildSymmetricPlanes(count, options = {}) {
  return createSkirmPlanes(count, (index, total) => {
    const preset = resolveSymmetricPreset(index, total, options);
    return preset ? { preset } : {};
  });
}

const MODE_MOTIFS = Object.freeze({
  hold: Object.freeze({
    pair: [0.38, 0.62],
    pairOffsetY: 0.00,
    centerOffsetY: -0.05,
    pairDur: 340,
    centerDur: 260,
    centerEase: 'Sine.easeInOut',
  }),
  press: Object.freeze({
    pair: [0.30, 0.70],
    pairOffsetY: 0.06,
    centerOffsetY: 0.18,
    pairDur: 320,
    centerDur: 360,
    centerEase: 'Cubic.easeInOut',
  }),
  flank: Object.freeze({
    pair: [0.22, 0.78],
    pairOffsetY: 0.02,
    centerOffsetY: 0.10,
    pairDur: 320,
    centerDur: 280,
    centerEase: 'Cubic.easeInOut',
  }),
  evade: Object.freeze({
    pair: [0.18, 0.82],
    pairOffsetY: -0.04,
    centerOffsetY: -0.08,
    pairDur: 280,
    centerDur: 220,
    centerEase: 'Sine.easeOut',
  }),
  retreat: Object.freeze({
    pair: [0.34, 0.66],
    pairOffsetY: -0.06,
    centerOffsetY: -0.10,
    pairDur: 300,
    centerDur: 240,
    centerEase: 'Sine.easeInOut',
  }),
});

const SUPPORT_DANCE_PROGRAMS = Object.freeze({
  hold: Object.freeze([
    Object.freeze({ dance: 'hourglass', entryX: 0.34, spacing: 34 }),
    Object.freeze({ dance: 'whirl', entryX: 0.30, spacing: 34 }),
    Object.freeze({ dance: 'hourglass', entryX: 0.32, spacing: 36 }),
  ]),
  press: Object.freeze([
    Object.freeze({ dance: 'side_cross', entryX: 0.28, spacing: 34 }),
    Object.freeze({ dance: 'fan_out', entryX: 0.26, spacing: 32 }),
    Object.freeze({ dance: 'neural_flow', entryX: 0.30, spacing: 34 }),
  ]),
  flank: Object.freeze([
    Object.freeze({ leftDance: 'sweep_right', rightDance: 'sweep_left', entryX: 0.22, spacing: 30 }),
    Object.freeze({ dance: 'side_cross', entryX: 0.25, spacing: 34 }),
    Object.freeze({ dance: 'fan_out', entryX: 0.28, spacing: 32 }),
  ]),
  evade: Object.freeze([
    Object.freeze({ dance: 'jink_drop', entryX: 0.30, spacing: 30 }),
    Object.freeze({ dance: 'zigzag', entryX: 0.28, spacing: 30 }),
    Object.freeze({ dance: 'neural_flow', entryX: 0.32, spacing: 34 }),
  ]),
  retreat: Object.freeze([
    Object.freeze({ dance: 'drift_drop', entryX: 0.34, spacing: 32 }),
    Object.freeze({ dance: 'hourglass', entryX: 0.32, spacing: 34 }),
    Object.freeze({ dance: 'neural_flow', entryX: 0.34, spacing: 34 }),
  ]),
});

export const LEVEL2_WAVE_BLUEPRINTS = Object.freeze([
  Object.freeze({
    label: 'mirror_gate',
    diffBase: 1.28,
    interSquadronDelay: 0.52,
    depthStart: 0.24,
    depthStep: 0.11,
    depthMax: 0.60,
    mainCount: Object.freeze({ base: 13, min: 12, max: 14 }),
    supportCountPerSide: Object.freeze({ base: 2, min: 2, max: 2 }),
    cutterCountPerSide: Object.freeze({ base: 0, min: 0, max: 0 }),
    raptorCountPerSide: Object.freeze({ base: 1, min: 1, max: 1 }),
    supportLaneYPct: 0.34,
    controller: Object.freeze({
      speed: 1.04,
      launchStaggerMs: 112,
      cycleMs: 7600,
      slotSpacingX: 50,
      rowYs: Object.freeze([68, 110]),
      pathSpreadX: 18,
      sideLaneSpreadX: 12,
      pathJitterX: 0,
      pathJitterY: 0,
      driftX: 16,
      driftY: 6,
      abruptChance: 0.18,
      abruptOffsetX: 30,
      abruptOffsetY: 8,
      organicPauseMinMs: 60,
      organicPauseMaxMs: 150,
    }),
    beats: Object.freeze([
      Object.freeze({
        role: 'entry',
        defaultMode: 'hold',
        playerBiasX: 0,
        enemyBiasX: 0,
        shieldRatio: 0.62,
        hpRatio: 0.92,
        heatRatio: 0.08,
        bulletThreat: 0.28,
      }),
      Object.freeze({
        role: 'cross',
        defaultMode: 'flank',
        playerBiasX: -0.16,
        enemyBiasX: 0.18,
        shieldRatio: 0.52,
        hpRatio: 0.82,
        heatRatio: 0.16,
        bulletThreat: 0.42,
      }),
      Object.freeze({
        role: 'climax',
        defaultMode: 'press',
        playerBiasX: 0,
        enemyBiasX: 0,
        shieldRatio: 0.36,
        hpRatio: 0.72,
        heatRatio: 0.28,
        bulletThreat: 0.66,
      }),
    ]),
  }),
  Object.freeze({
    label: 'vice_lattice',
    diffBase: 1.40,
    interSquadronDelay: 0.44,
    depthStart: 0.26,
    depthStep: 0.12,
    depthMax: 0.66,
    mainCount: Object.freeze({ base: 15, min: 14, max: 16 }),
    supportCountPerSide: Object.freeze({ base: 2, min: 2, max: 3 }),
    cutterCountPerSide: Object.freeze({ base: 3, min: 3, max: 4 }),
    raptorCountPerSide: Object.freeze({ base: 1, min: 1, max: 1 }),
    supportLaneYPct: 0.42,
    controller: Object.freeze({
      speed: 1.08,
      launchStaggerMs: 100,
      cycleMs: 7100,
      slotSpacingX: 48,
      rowYs: Object.freeze([72, 118]),
      pathSpreadX: 16,
      sideLaneSpreadX: 14,
      pathJitterX: 0,
      pathJitterY: 0,
      driftX: 18,
      driftY: 7,
      abruptChance: 0.22,
      abruptOffsetX: 34,
      abruptOffsetY: 10,
      organicPauseMinMs: 55,
      organicPauseMaxMs: 135,
    }),
    beats: Object.freeze([
      Object.freeze({
        role: 'entry',
        defaultMode: 'evade',
        playerBiasX: 0.14,
        enemyBiasX: -0.16,
        shieldRatio: 0.52,
        hpRatio: 0.80,
        heatRatio: 0.18,
        bulletThreat: 0.42,
      }),
      Object.freeze({
        role: 'cross',
        defaultMode: 'hold',
        playerBiasX: -0.14,
        enemyBiasX: 0.18,
        shieldRatio: 0.44,
        hpRatio: 0.72,
        heatRatio: 0.24,
        bulletThreat: 0.56,
      }),
      Object.freeze({
        role: 'squeeze',
        defaultMode: 'flank',
        playerBiasX: 0.18,
        enemyBiasX: -0.20,
        shieldRatio: 0.30,
        hpRatio: 0.62,
        heatRatio: 0.34,
        bulletThreat: 0.70,
      }),
      Object.freeze({
        role: 'climax',
        defaultMode: 'press',
        playerBiasX: 0,
        enemyBiasX: 0,
        shieldRatio: 0.20,
        hpRatio: 0.56,
        heatRatio: 0.42,
        bulletThreat: 0.82,
      }),
    ]),
  }),
  Object.freeze({
    label: 'crown_siege',
    diffBase: 1.54,
    interSquadronDelay: 0.36,
    depthStart: 0.28,
    depthStep: 0.13,
    depthMax: 0.72,
    mainCount: Object.freeze({ base: 16, min: 16, max: 16 }),
    supportCountPerSide: Object.freeze({ base: 3, min: 3, max: 3 }),
    cutterCountPerSide: Object.freeze({ base: 4, min: 4, max: 4 }),
    raptorCountPerSide: Object.freeze({ base: 2, min: 2, max: 2 }),
    supportLaneYPct: 0.50,
    controller: Object.freeze({
      speed: 1.12,
      launchStaggerMs: 90,
      cycleMs: 6600,
      slotSpacingX: 46,
      rowYs: Object.freeze([74, 122]),
      pathSpreadX: 14,
      sideLaneSpreadX: 16,
      pathJitterX: 0,
      pathJitterY: 0,
      driftX: 20,
      driftY: 8,
      abruptChance: 0.28,
      abruptOffsetX: 36,
      abruptOffsetY: 11,
      organicPauseMinMs: 48,
      organicPauseMaxMs: 120,
    }),
    beats: Object.freeze([
      Object.freeze({
        role: 'entry',
        defaultMode: 'hold',
        playerBiasX: -0.12,
        enemyBiasX: 0.14,
        shieldRatio: 0.42,
        hpRatio: 0.68,
        heatRatio: 0.26,
        bulletThreat: 0.54,
      }),
      Object.freeze({
        role: 'cross',
        defaultMode: 'evade',
        playerBiasX: 0.18,
        enemyBiasX: -0.18,
        shieldRatio: 0.28,
        hpRatio: 0.58,
        heatRatio: 0.36,
        bulletThreat: 0.68,
      }),
      Object.freeze({
        role: 'squeeze',
        defaultMode: 'flank',
        playerBiasX: -0.20,
        enemyBiasX: 0.22,
        shieldRatio: 0.14,
        hpRatio: 0.48,
        heatRatio: 0.46,
        bulletThreat: 0.82,
      }),
      Object.freeze({
        role: 'climax',
        defaultMode: 'press',
        playerBiasX: 0,
        enemyBiasX: 0,
        shieldRatio: 0.05,
        hpRatio: 0.40,
        heatRatio: 0.54,
        bulletThreat: 0.94,
      }),
    ]),
  }),
]);

export class DanceGenerator {
  /**
   * @param {{
   *   network: import('./DanceWaypointNetwork.js').DanceWaypointNetwork,
   *   encoder: import('./EnemyFeatureEncoder.js').EnemyFeatureEncoder,
   *   config?: object,
   *   rng?: Function,
   *   playerStyleProfile?: object,
   * }} options
   */
  constructor({ network, encoder, config = {}, rng = Math.random, playerStyleProfile = null }) {
    this._network = network;
    this._encoder = encoder;
    this._rng = rng;
    this._config = Object.assign({}, ENEMY_LEARNING_CONFIG.neuralDance, config);
    this._playerStyleProfile = normalizePlayerStyleProfile(playerStyleProfile);
  }

  setPlayerStyleProfile(playerStyleProfile = null) {
    this._playerStyleProfile = normalizePlayerStyleProfile(playerStyleProfile);
    return this;
  }

  /**
   * Generate `count` wave config objects for Level 2.
   *
   * @param {number} [count=LEVEL2_WAVE_BLUEPRINTS.length]
   * @returns {object[]}
   */
  generateWaves(count = LEVEL2_WAVE_BLUEPRINTS.length) {
    return Array.from({ length: count }, (_, index) => {
      const blueprint = clonePlain(
        LEVEL2_WAVE_BLUEPRINTS[index] ?? LEVEL2_WAVE_BLUEPRINTS[LEVEL2_WAVE_BLUEPRINTS.length - 1]
      );
      return this._buildWave(index + 1, blueprint, count);
    });
  }

  /**
   * Populate `levelsArray[levelIndex].waves` in place.
   *
   * @param {object[]} levelsArray
   * @param {number} levelIndex
   * @param {number} [count=LEVEL2_WAVE_BLUEPRINTS.length]
   * @returns {object[]}
   */
  generateAndInjectWaves(levelsArray, levelIndex, count = LEVEL2_WAVE_BLUEPRINTS.length) {
    const levelConfig = levelsArray[levelIndex];
    if (!levelConfig) return [];

    const waves = this.generateWaves(count);
    levelConfig.waves = waves;
    return waves;
  }

  _buildWave(waveId, blueprint, totalWaves) {
    const playerStyleProfile = normalizePlayerStyleProfile(this._playerStyleProfile);
    const waveIndex = Math.max(0, waveId - 1);
    const beatPredictions = [];
    blueprint.beats.forEach((beat, beatIndex) => {
      beatPredictions.push(
        this._predictBeat(
          blueprint,
          beat,
          beatIndex,
          waveIndex,
          totalWaves,
          beatPredictions,
          playerStyleProfile
        )
      );
    });
    const metrics = this._applyPlayerStyleToMetrics(
      this._summarizeBeats(beatPredictions),
      playerStyleProfile
    );
    const controller = this._buildController(blueprint, beatPredictions, metrics);
    const formation = this._resolveMainFormation(metrics);
    const mainCount = resolveRounded(
      blueprint.mainCount.base
      + metrics.pressure * 2.2
      + metrics.confidence * 1.2
      - metrics.caution * 0.4
      + metrics.stylePressure * 1.1,
      blueprint.mainCount.min,
      blueprint.mainCount.max
    );
    const cutterCountPerSide = resolveRounded(
      blueprint.cutterCountPerSide.base + metrics.flank * 1.3 + playerStyleProfile.dodgeIntensity * 0.5,
      blueprint.cutterCountPerSide.min,
      blueprint.cutterCountPerSide.max
    );
    const supportCountPerSide = resolveRounded(
      blueprint.supportCountPerSide.base
      + metrics.confidence * 0.8
      + metrics.flank * 0.4
      + Math.abs(playerStyleProfile.laneBiasX) * 0.8,
      blueprint.supportCountPerSide.min,
      blueprint.supportCountPerSide.max
    );
    const raptorCountPerSide = resolveRounded(
      blueprint.raptorCountPerSide.base
      + metrics.pressure * 0.8
      + playerStyleProfile.heatGreed * 0.75
      + (1 - playerStyleProfile.dodgeIntensity) * 0.25,
      blueprint.raptorCountPerSide.min,
      blueprint.raptorCountPerSide.max
    );
    const supportMode = this._resolveSupportMode(beatPredictions);
    const difficultyFactor = Number((
      blueprint.diffBase
      + metrics.pressure * 0.11
      + metrics.confidence * 0.05
      - metrics.caution * 0.03
      + raptorCountPerSide * 0.02
    ).toFixed(3));

    const squadrons = [
      this._buildMainSquadron(waveId, blueprint, mainCount, formation, controller, beatPredictions, metrics),
      ...this._buildMirrorSupportSkirms(waveId, waveIndex, supportMode, supportCountPerSide),
      ...this._buildMirrorCutters(waveId, cutterCountPerSide),
      ...this._buildMirrorRaptors(waveId, blueprint.supportLaneYPct, raptorCountPerSide),
    ];

    return {
      id: waveId,
      difficultyFactor,
      interSquadronDelay: Number(clamp(
        blueprint.interSquadronDelay - metrics.pressure * 0.05 + metrics.caution * 0.02,
        0.28,
        0.60
      ).toFixed(3)),
      squadrons,
      _generatedLabel: blueprint.label,
      _generatedModes: beatPredictions.map(beat => beat.mode),
      _generatedMetrics: {
        pressure: Number(metrics.pressure.toFixed(3)),
        caution: Number(metrics.caution.toFixed(3)),
        confidence: Number(metrics.confidence.toFixed(3)),
      },
      _generatedPlayerStyle: {
        laneBiasX: Number(playerStyleProfile.laneBiasX.toFixed(3)),
        aggression: Number(playerStyleProfile.aggression.toFixed(3)),
        dodgeIntensity: Number(playerStyleProfile.dodgeIntensity.toFixed(3)),
        heatGreed: Number(playerStyleProfile.heatGreed.toFixed(3)),
      },
      _generatedSupportMode: supportMode,
    };
  }

  _buildMainSquadron(waveId, blueprint, mainCount, formation, controller, beatPredictions, metrics) {
    return {
      id: `l2_wave${waveId}_${blueprint.label}_core`,
      dance: 'straight',
      formation,
      entryEdge: 'top',
      entryX: 0.5,
      spacing: clamp(46 + (metrics.caution - metrics.pressure) * 10, 36, 58),
      controller,
      planes: buildSymmetricPlanes(mainCount),
      _generatedMode: beatPredictions.at(-1)?.mode ?? 'hold',
      _generatedModes: beatPredictions.map(beat => beat.mode),
    };
  }

  _buildMirrorCutters(waveId, countPerSide) {
    if (countPerSide <= 0) return [];

    return [
      {
        id: `l2_wave${waveId}_cutters_left`,
        dance: 'sweep_right',
        formation: 'line',
        entryEdge: 'top',
        entryX: 0.22,
        spacing: 30,
        planes: buildSymmetricPlanes(countPerSide, { aceBand: 0.45, heavyBand: 10 }),
        _generatedRole: 'mirror_cutter',
      },
      {
        id: `l2_wave${waveId}_cutters_right`,
        dance: 'sweep_left',
        formation: 'line',
        entryEdge: 'top',
        entryX: 0.78,
        spacing: 30,
        planes: buildSymmetricPlanes(countPerSide, { aceBand: 0.45, heavyBand: 10 }),
        _generatedRole: 'mirror_cutter',
      },
    ];
  }

  _resolveSupportMode(beatPredictions) {
    return beatPredictions.find((beat) => beat.mode !== 'hold' && beat.role !== 'climax')?.mode
      ?? beatPredictions.find((beat) => beat.mode !== 'hold')?.mode
      ?? beatPredictions.at(-1)?.mode
      ?? 'hold';
  }

  _resolveSupportDanceProgram(mode, waveIndex) {
    const programs = SUPPORT_DANCE_PROGRAMS[mode] ?? SUPPORT_DANCE_PROGRAMS.hold;
    return programs[Math.min(waveIndex, programs.length - 1)] ?? programs[0];
  }

  _buildMirrorSupportSkirms(waveId, waveIndex, mode, countPerSide) {
    if (countPerSide <= 0) return [];

    const program = this._resolveSupportDanceProgram(mode, waveIndex);
    const leftDance = program.leftDance ?? program.dance ?? 'hourglass';
    const rightDance = program.rightDance ?? program.dance ?? leftDance;
    const leftEntryX = clamp(program.entryX ?? 0.30, 0.18, 0.42);
    const rightEntryX = Number((1 - leftEntryX).toFixed(3));
    const spacing = program.spacing ?? 34;

    return [
      {
        id: `l2_wave${waveId}_support_left`,
        dance: leftDance,
        formation: 'line',
        entryEdge: 'top',
        entryX: leftEntryX,
        spacing,
        planes: buildSymmetricPlanes(countPerSide, { aceBand: 0.35, heavyBand: 10 }),
        _generatedRole: 'mirror_skirm_support',
        _generatedMode: mode,
      },
      {
        id: `l2_wave${waveId}_support_right`,
        dance: rightDance,
        formation: 'line',
        entryEdge: 'top',
        entryX: rightEntryX,
        spacing,
        planes: buildSymmetricPlanes(countPerSide, { aceBand: 0.35, heavyBand: 10 }),
        _generatedRole: 'mirror_skirm_support',
        _generatedMode: mode,
      },
    ];
  }

  _buildMirrorRaptors(waveId, laneYPct, countPerSide) {
    if (countPerSide <= 0) return [];

    return [
      {
        id: `l2_wave${waveId}_raptors_left`,
        dance: 'side_left',
        formation: 'line',
        entryEdge: 'left',
        entryX: laneYPct,
        spacing: 84,
        planes: createRaptorPlanes(countPerSide),
        _generatedRole: 'mirror_raptor',
      },
      {
        id: `l2_wave${waveId}_raptors_right`,
        dance: 'side_right',
        formation: 'line',
        entryEdge: 'right',
        entryX: laneYPct,
        spacing: 84,
        planes: createRaptorPlanes(countPerSide),
        _generatedRole: 'mirror_raptor',
      },
    ];
  }

  _resolveMainFormation(metrics) {
    if (metrics.caution >= 0.56) return 'spread';
    if (metrics.pressure >= 0.62) return 'V';
    if (metrics.flank >= 0.42) return 'wedge';
    return 'line';
  }

  _buildController(blueprint, beatPredictions, metrics) {
    const base = blueprint.controller ?? {};
    const cadenceModifier = clamp(
      0.94 + metrics.pressure * 0.24 + metrics.confidence * 0.10 - metrics.caution * 0.08,
      0.88,
      1.28
    );
    const pathVolleySize = resolveRounded(1 + metrics.pressure * 1.6, 1, 3);
    const idleVolleySize = resolveRounded(2 + metrics.pressure * 1.8 - metrics.caution * 0.5, 2, 4);

    return {
      ...clonePlain(base),
      path: this._buildSymmetricPath(blueprint, beatPredictions, metrics),
      mirrorPath: false,
      speed: Number((base.speed + metrics.pressure * 0.06).toFixed(3)),
      cycleMs: Math.round(base.cycleMs * (1 - metrics.pressure * 0.08)),
      shootRate: Number((2.1 + metrics.pressure * 0.65 + metrics.confidence * 0.12).toFixed(3)),
      pathShootRate: Number((1.45 + metrics.pressure * 0.55).toFixed(3)),
      slotSpacingX: Math.round(base.slotSpacingX * (1 + metrics.caution * 0.06)),
      pathSpreadX: Math.round(base.pathSpreadX * (1 + metrics.caution * 0.12)),
      driftX: Math.round(base.driftX * (1 + metrics.caution * 0.10)),
      driftY: Math.round(base.driftY * (1 + metrics.caution * 0.12)),
      abruptChance: Number(clamp(base.abruptChance + metrics.flank * 0.12 + metrics.caution * 0.08, 0.12, 0.48).toFixed(3)),
      shotCadence: {
        pathPattern: metrics.pressure >= 0.60
          ? 'wings'
          : (metrics.caution >= 0.54 ? 'single' : 'sweep'),
        idlePattern: metrics.caution >= 0.55
          ? 'alternating_rows'
          : (metrics.pressure >= 0.58 ? 'wings' : 'sweep'),
        pathVolleySize,
        idleVolleySize,
        intraVolleyMs: Math.round(118 - metrics.pressure * 18 + metrics.caution * 12),
        modifier: Number(cadenceModifier.toFixed(3)),
      },
    };
  }

  _buildSymmetricPath(blueprint, beatPredictions, metrics) {
    const path = [{
      xPct: 0.50,
      yPct: clamp(blueprint.depthStart - 0.08, 0.14, 0.24),
      dur: 260,
    }];

    beatPredictions.forEach((beat, beatIndex) => {
      const motif = MODE_MOTIFS[beat.mode] ?? MODE_MOTIFS.hold;
      const baseDepth = clamp(
        blueprint.depthStart
        + beatIndex * blueprint.depthStep
        + metrics.pressure * 0.04
        - metrics.caution * 0.03,
        0.18,
        blueprint.depthMax
      );
      const mirroredShiftXPct = (this._rng() - 0.5) * 0.06;
      const depthShiftPct = (this._rng() - 0.5) * 0.04;
      const pairLeftXPct = clamp(motif.pair[0] - mirroredShiftXPct, 0.14, 0.48);
      const pairRightXPct = Number((1 - pairLeftXPct).toFixed(3));
      const pairY = clamp(baseDepth + motif.pairOffsetY + depthShiftPct, 0.16, blueprint.depthMax);
      const centerY = clamp(baseDepth + motif.centerOffsetY - depthShiftPct * 0.4, 0.14, blueprint.depthMax + 0.08);
      const tempoScale = clamp(
        1.05 - metrics.pressure * 0.15 + metrics.caution * 0.05 + (this._rng() - 0.5) * 0.08,
        0.82,
        1.08
      );

      path.push({
        xPct: pairLeftXPct,
        yPct: pairY,
        dur: Math.round(motif.pairDur * tempoScale),
      });
      path.push({
        xPct: pairRightXPct,
        yPct: pairY,
        dur: Math.round(motif.pairDur * tempoScale),
      });
      path.push({
        xPct: 0.50,
        yPct: centerY,
        dur: Math.round(motif.centerDur * tempoScale),
        ease: motif.centerEase,
      });
    });

    path.push({
      xPct: 0.50,
      yPct: clamp(blueprint.depthStart - 0.10 + metrics.caution * 0.02, 0.12, 0.22),
      dur: 300,
    });

    return path.map(step => ({
      ...step,
      xPct: Number(step.xPct.toFixed(3)),
      yPct: Number(step.yPct.toFixed(3)),
      dur: Math.max(180, Math.round(step.dur)),
    }));
  }

  _summarizeBeats(beatPredictions) {
    return {
      confidence: average(beatPredictions.map(beat => beat.confidence ?? 0)),
      pressure: clamp(average(beatPredictions.map(beat => (
        modeProbability(beat, 'press') + modeProbability(beat, 'flank') * 0.55
      ))), 0, 1),
      caution: clamp(average(beatPredictions.map(beat => (
        modeProbability(beat, 'evade') + modeProbability(beat, 'retreat') * 0.75
      ))), 0, 1),
      flank: clamp(average(beatPredictions.map(beat => modeProbability(beat, 'flank'))), 0, 1),
    };
  }

  _applyPlayerStyleToMetrics(metrics, playerStyleProfile) {
    const stylePressure = clamp(
      playerStyleProfile.aggression * 0.34
      + playerStyleProfile.heatGreed * 0.32
      + playerStyleProfile.pressureExposure * 0.46
      + (1 - Math.min(1, playerStyleProfile.nearestEnemyDistanceNorm)) * 0.14,
      0,
      1
    );
    const styleCaution = clamp(
      playerStyleProfile.dodgeIntensity * 0.40
      + playerStyleProfile.reversalRate * 0.34
      + (1 - playerStyleProfile.shieldReliance) * 0.16,
      0,
      1
    );

    return {
      ...metrics,
      confidence: clamp(
        metrics.confidence * 0.86
        + playerStyleProfile.dodgeIntensity * 0.07
        + playerStyleProfile.heatGreed * 0.04
        + Math.abs(playerStyleProfile.laneBiasX) * 0.03,
        0,
        1
      ),
      pressure: clamp(metrics.pressure * 0.74 + stylePressure * 0.26, 0, 1),
      caution: clamp(metrics.caution * 0.74 + styleCaution * 0.26, 0, 1),
      flank: clamp(
        metrics.flank * 0.82
        + playerStyleProfile.dodgeIntensity * 0.10
        + Math.abs(playerStyleProfile.laneBiasX) * 0.08,
        0,
        1
      ),
      stylePressure,
      styleCaution,
    };
  }

  _sampleModeFromProbabilities(probabilities, temperature = 1) {
    const safeTemperature = clamp(temperature, 0.75, 1.25);
    const logits = probabilities.map(probability => (
      Math.log(Math.max(1e-9, clamp(probability ?? 0, 0, 1))) / safeTemperature
    ));
    const maxLogit = Math.max(...logits);
    const scaled = logits.map(logit => Math.exp(logit - maxLogit));
    const total = scaled.reduce((sum, value) => sum + value, 0) || 1;
    let remaining = this._rng() * total;

    for (let index = 0; index < scaled.length; index++) {
      remaining -= scaled[index];
      if (remaining <= 0) return ACTION_MODES[index] ?? 'hold';
    }

    return ACTION_MODES[scaled.length - 1] ?? 'hold';
  }

  _pickRunnerUpMode(probabilities, currentMode) {
    const currentIndex = ACTION_MODES.indexOf(currentMode);
    return probabilities
      .map((probability, index) => ({ probability, mode: ACTION_MODES[index], index }))
      .filter(({ index }) => index !== currentIndex)
      .sort((left, right) => right.probability - left.probability)[0]
      ?.mode ?? currentMode;
  }

  _resolvePredictedBeatMode(prediction, beat, priorBeats = []) {
    const probabilities = Array.isArray(prediction?.probabilities) && prediction.probabilities.length === ACTION_MODES.length
      ? prediction.probabilities
      : ACTION_MODES.map(() => 1 / ACTION_MODES.length);
    const confidence = clamp(prediction?.confidence ?? 0, 0, 1);
    const priorMode = priorBeats.at(-1)?.mode ?? null;

    let mode = prediction?.mode ?? beat.defaultMode ?? 'hold';

    if (confidence < 0.72) {
      const temperature = clamp(1.08 + (0.72 - confidence) * 0.45, 0.95, 1.18);
      mode = this._sampleModeFromProbabilities(probabilities, temperature);
    }

    if (priorMode === mode && confidence < 0.66 && beat.role !== 'climax') {
      mode = this._pickRunnerUpMode(probabilities, mode);
    }

    return {
      mode,
      confidence,
      probabilities,
    };
  }

  _predictBeat(blueprint, beat, beatIndex, waveIndex, totalWaves, priorBeats = [], playerStyleProfile) {
    const vector = this._buildInputVector(waveIndex, totalWaves, beat, playerStyleProfile);
    const prediction = this._network?.predict?.(vector) ?? {
      mode: beat.defaultMode ?? 'hold',
      probabilities: ACTION_MODES.map(() => 1 / ACTION_MODES.length),
      confidence: 1 / ACTION_MODES.length,
    };
    const resolvedPrediction = this._resolvePredictedBeatMode(prediction, beat, priorBeats);
    let mode = resolvedPrediction.mode;
    const confidence = resolvedPrediction.confidence;

    if (confidence < 0.38) {
      mode = beat.defaultMode ?? mode;
    }

    if (beat.role === 'climax' && confidence < 0.62 && (mode === 'hold' || mode === 'retreat')) {
      mode = 'press';
    }

    if (beat.role === 'entry' && confidence < 0.46 && mode === 'press') {
      mode = beat.defaultMode ?? 'hold';
    }

    return {
      ...prediction,
      probabilities: resolvedPrediction.probabilities,
      mode,
      role: beat.role,
      beatIndex,
    };
  }

  /**
   * Build a synthetic context vector for the given wave beat.
   *
   * @param {number} waveIndex
   * @param {number} totalWaves
   * @param {object} beat
   * @param {object} playerStyleProfile
   * @returns {number[]}
   */
  _buildInputVector(waveIndex, totalWaves, beat = {}, playerStyleProfile = this._playerStyleProfile) {
    const t = totalWaves > 1 ? waveIndex / (totalWaves - 1) : 0;
    const style = normalizePlayerStyleProfile(playerStyleProfile);
    const laneAmplitude = clamp(0.55 + style.dodgeIntensity * 0.55 + style.reversalRate * 0.22, 0.45, 1.18);
    const playerLaneBias = clamp(
      style.laneBiasX * 0.22 + (beat.playerBiasX ?? 0) * laneAmplitude,
      -0.34,
      0.34
    );
    const playerX = W * clamp(0.5 + playerLaneBias, 0.14, 0.86);
    const playerYNorm = clamp(
      0.82
      - style.aggression * 0.18
      + (beat.role === 'entry' ? 0.01 : 0)
      - (beat.role === 'climax' ? style.aggression * 0.03 : 0),
      0.58,
      0.88
    );
    const playerY = H * playerYNorm;
    const hpRatio = clamp(
      (beat.hpRatio ?? (0.9 - t * 0.25)) * 0.58
      + style.hpRatio * 0.42
      - style.pressureExposure * 0.05,
      0.18,
      1
    );
    const shieldRatio = clamp(
      (beat.shieldRatio ?? (0.55 - t * 0.20)) * 0.44
      + (style.shieldRatio * (0.68 + style.shieldReliance * 0.32)) * 0.56,
      0,
      1
    );
    const heatRatio = clamp(
      (beat.heatRatio ?? (t * 0.35)) * 0.42
      + style.heatGreed * 0.58
      + style.overheatRate * 0.12,
      0,
      1
    );

    const enemyX = W * clamp(0.5 + (beat.enemyBiasX ?? 0) - style.laneBiasX * 0.08, 0.16, 0.84);
    const enemyY = H * clamp((beat.enemyYPct ?? 0.16) + style.aggression * 0.05, 0.12, 0.24);
    const bulletLaneThreat = clamp(
      (beat.bulletThreat ?? (0.35 + t * 0.2)) * 0.58
      + style.pressureExposure * 0.22
      + style.dodgeIntensity * 0.12
      + (1 - Math.min(1, style.nearestEnemyDistanceNorm)) * 0.08,
      0,
      1
    );
    const nearestBulletDistance = (
      1 - bulletLaneThreat * 0.58
    ) * ENEMY_LEARNING_CONFIG.normalization.maxBulletThreatDistance;
    const bulletTimeToImpactMs = (
      1 - bulletLaneThreat * 0.48
    ) * ENEMY_LEARNING_CONFIG.normalization.maxBulletTimeToImpactMs;

    const sample = this._encoder.buildSample({
      enemyType: 'skirm',
      player: {
        x: playerX,
        y: playerY,
        hasShield: shieldRatio > 0,
        shieldRatio,
        hpRatio,
      },
      weapon: {
        primaryWeaponKey: style.preferredWeaponKey,
        heatRatio,
        isOverheated: style.overheatRate > 0.16 && heatRatio > 0.62,
        primaryDamageMultiplier: clamp(1 + style.aggression * 0.24 + style.heatGreed * 0.12, 1, 1.5),
      },
      enemyX,
      enemyY,
      speed: 80 + style.aggression * 14 + style.heatGreed * 10 - style.dodgeIntensity * 6,
      squad: {
        centroidX: enemyX,
        centroidY: enemyY,
        width: W * clamp(0.44 + Math.abs(style.laneBiasX) * 0.06 + style.enemyDensity * 0.04, 0.34, 0.58),
        aliveRatio: 1,
      },
      threat: {
        nearestBulletDistance,
        bulletLaneThreat,
        bulletTimeToImpactMs,
        suggestedSafeX: clamp(enemyX + (beat.enemyBiasX ?? 0) * -W * 0.8, 40, W - 40),
        suggestedSafeY: clamp(enemyY - 22, 24, H - 96),
      },
      actionMode: 'hold',
    });

    const encoded = this._encoder.encodeSample(sample);
    return stripActionModes(encoded.vector);
  }
}
