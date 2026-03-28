/** @module levels.config */

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, clonePlain(inner)])
    );
  }
  return value;
}

function makeSkirmPlanes(count, resolver = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'skirm',
    ...resolver(index, count),
  }));
}

function makeRaptorPlanes(count, resolver = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'raptor',
    ...resolver(index, count),
  }));
}

function makeMinePlanes(count, resolver = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'mine',
    ...resolver(index, count),
  }));
}

function createLevel1SquadronPool() {
  return [
    {
      id: 'w1_patrol_loop_10',
      dance: 'straight',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 52,
      controller: {
        path: [
          { xPct: 0.50, yPct: 0.23, dur: 480 },
          { xPct: 0.19, yPct: 0.45, dur: 660 },
          { xPct: 0.16, yPct: 0.73, dur: 620 },
          { xPct: 0.45, yPct: 0.85, dur: 540 },
          { xPct: 0.80, yPct: 0.78, dur: 560 },
          { xPct: 0.90, yPct: 0.44, dur: 520 },
          { xPct: 0.65, yPct: 0.13, dur: 440 },
        ],
        pathSpreadX: 18,
        pathJitterX: 10,
        pathJitterY: 6,
        launchStaggerMs: 150,
        cycleMs: 8600,
        shootRate: 2.2,
        shotCadence: {
          pathPattern: 'single',
          idlePattern: 'alternating_rows',
          pathVolleySize: 1,
          idleVolleySize: 2,
          intraVolleyMs: 130,
          modifier: 0.95,
        },
        slotSpacingX: 52,
        rowYs: [70, 114],
        driftX: 22,
        driftY: 7,
        abruptChance: 0.25,
        abruptOffsetX: 36,
        abruptOffsetY: 10,
      },
      planes: makeSkirmPlanes(10, (index, count) => (
        index === Math.floor(count / 2) ? { preset: 'ace' } : {}
      )),
    },
    {
      id: 'w1_hook_spear_14',
      dance: 'straight',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 48,
      controller: {
        path: [
          { xPct: 0.76, yPct: 0.20, dur: 420 },
          { xPct: 0.88, yPct: 0.42, dur: 450, ease: 'Expo.easeOut' },
          { xPct: 0.70, yPct: 0.69, dur: 420 },
          { xPct: 0.42, yPct: 0.83, dur: 460 },
          { xPct: 0.16, yPct: 0.63, dur: 420 },
          { xPct: 0.25, yPct: 0.32, dur: 390 },
          { xPct: 0.50, yPct: 0.14, dur: 350 },
        ],
        mirrorPath: 'random',
        pathSpreadX: 24,
        pathJitterX: 14,
        pathJitterY: 10,
        launchStaggerMs: 120,
        cycleMs: 8200,
        shootRate: 2.6,
        shotCadence: {
          pathPattern: 'sweep',
          idlePattern: 'sweep',
          pathVolleySize: 2,
          idleVolleySize: 2,
          intraVolleyMs: 95,
          modifier: 1.05,
        },
        slotSpacingX: 48,
        rowYs: [68, 110],
        driftX: 18,
        driftY: 7,
        abruptChance: 0.42,
        abruptOffsetX: 40,
        abruptOffsetY: 12,
        organicPauseMinMs: 60,
        organicPauseMaxMs: 180,
      },
      planes: makeSkirmPlanes(14, (index, count) => {
        const center = Math.floor(count / 2);
        if (index === center) return { preset: 'ace' };
        if (index % 5 === 0) return { preset: 'light' };
        return {};
      }),
    },
    {
      id: 'w1_split_breakers_16',
      dance: 'straight',
      formation: 'spread',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 38,
      controller: {
        path: [
          { xPct: 0.52, yPct: 0.19, dur: 430 },
          { xPct: 0.24, yPct: 0.36, dur: 420 },
          { xPct: 0.19, yPct: 0.60, dur: 360, ease: 'Expo.easeOut' },
          { xPct: 0.36, yPct: 0.84, dur: 430 },
          { xPct: 0.64, yPct: 0.86, dur: 430 },
          { xPct: 0.82, yPct: 0.60, dur: 360, ease: 'Expo.easeOut' },
          { xPct: 0.76, yPct: 0.28, dur: 380 },
          { xPct: 0.50, yPct: 0.13, dur: 330 },
        ],
        mirrorPath: 'random',
        pathSpreadX: 20,
        pathJitterX: 12,
        pathJitterY: 8,
        launchStaggerMs: 125,
        cycleMs: 7800,
        shootRate: 2.4,
        shotCadence: {
          pathPattern: 'wings',
          idlePattern: 'wings',
          pathVolleySize: 2,
          idleVolleySize: 2,
          intraVolleyMs: 115,
          modifier: 1,
        },
        slotSpacingX: 46,
        rowYs: [72, 116],
        driftX: 24,
        driftY: 9,
        abruptChance: 0.35,
        abruptOffsetX: 34,
        abruptOffsetY: 12,
      },
      planes: makeSkirmPlanes(16, (index) => {
        if (index % 5 === 0) return { dance: 'jink_drop', preset: 'light' };
        if (index % 4 === 0) return { dance: 'zigzag', preset: 'light' };
        return {};
      }),
    },
    {
      id: 'w1_drift_rain_12',
      dance: 'drift_drop',
      formation: 'spread',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 44,
      planes: makeSkirmPlanes(12, (index) => {
        if (index === 5) return { preset: 'ace' };
        if (index % 2 === 0) return { preset: 'light' };
        return {};
      }),
    },
    {
      id: 'w1_snap_current_16',
      dance: 'jink_drop',
      formation: 'spread',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 28,
      planes: makeSkirmPlanes(16, (index) => (
        index % 3 === 0 ? { preset: 'light' } : {}
      )),
    },
    {
      id: 'w1_fan_cloud_12',
      dance: 'fan_out',
      formation: 'cluster',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 56,
      planes: makeSkirmPlanes(12, (index) => {
        if (index % 4 === 0) return { dance: 'drift_drop', preset: 'light' };
        if (index === 6) return { preset: 'ace' };
        return {};
      }),
    },
    {
      id: 'w1_whirl_guard_10',
      dance: 'whirl',
      formation: 'spread',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 34,
      planes: makeSkirmPlanes(10, (index, count) => {
        if (index === Math.floor(count / 2)) return { preset: 'ace' };
        if (index % 3 === 0) return { preset: 'light' };
        return {};
      }),
    },
    {
      id: 'w1_hourglass_gate_12',
      dance: 'hourglass',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.5,
      spacing: 36,
      planes: makeSkirmPlanes(12, (index) => {
        if (index === 5) return { preset: 'ace' };
        if (index % 4 === 0) return { preset: 'light' };
        return {};
      }),
    },
  ];
}

function selectSquadrons(pool, ids) {
  const poolById = Object.fromEntries(pool.map(squadron => [squadron.id, squadron]));
  return ids.map((id) => {
    const squadron = poolById[id];
    if (!squadron) throw new Error(`levels.config: unknown squadron template "${id}"`);
    return clonePlain(squadron);
  });
}

function createLevel1Waves() {
  const pool = createLevel1SquadronPool();
  const waveSpecs = [
    { difficultyFactor: 1.00, interSquadronDelay: 0.70, ids: ['w1_patrol_loop_10', 'w1_drift_rain_12'] },
    { difficultyFactor: 1.02, interSquadronDelay: 0.85, ids: ['w1_patrol_loop_10', 'w1_fan_cloud_12'] },
    { difficultyFactor: 1.05, interSquadronDelay: 0.90, ids: ['w1_drift_rain_12', 'w1_whirl_guard_10'] },
    { difficultyFactor: 1.08, interSquadronDelay: 1.00, ids: ['w1_patrol_loop_10', 'w1_hook_spear_14'] },
    { difficultyFactor: 1.10, interSquadronDelay: 0.95, ids: ['w1_hook_spear_14', 'w1_hourglass_gate_12'] },
    { difficultyFactor: 1.13, interSquadronDelay: 1.10, ids: ['w1_snap_current_16', 'w1_whirl_guard_10'] },
    { difficultyFactor: 1.16, interSquadronDelay: 1.00, ids: ['w1_patrol_loop_10', 'w1_snap_current_16'] },
    { difficultyFactor: 1.20, interSquadronDelay: 1.15, ids: ['w1_hourglass_gate_12', 'w1_fan_cloud_12'] },
    { difficultyFactor: 1.24, interSquadronDelay: 1.20, ids: ['w1_split_breakers_16', 'w1_whirl_guard_10'] },
    { difficultyFactor: 1.28, interSquadronDelay: 1.05, ids: ['w1_snap_current_16', 'w1_drift_rain_12'] },
    { difficultyFactor: 1.32, interSquadronDelay: 1.25, ids: ['w1_hourglass_gate_12', 'w1_split_breakers_16'] },
    { difficultyFactor: 1.36, interSquadronDelay: 1.15, ids: ['w1_hook_spear_14', 'w1_whirl_guard_10'] },
    { difficultyFactor: 1.40, interSquadronDelay: 1.30, ids: ['w1_split_breakers_16', 'w1_hourglass_gate_12'] },
    { difficultyFactor: 1.45, interSquadronDelay: 1.20, ids: ['w1_hook_spear_14', 'w1_split_breakers_16', 'w1_whirl_guard_10'] },
    { difficultyFactor: 1.50, interSquadronDelay: 1.35, ids: ['w1_snap_current_16', 'w1_hourglass_gate_12'] },
    { difficultyFactor: 1.56, interSquadronDelay: 1.40, ids: ['w1_hook_spear_14', 'w1_snap_current_16', 'w1_split_breakers_16', 'w1_whirl_guard_10', 'w1_hourglass_gate_12'] },
  ];

  return waveSpecs.map((spec, index) => ({
    id: index + 1,
    difficultyFactor: spec.difficultyFactor,
    interSquadronDelay: spec.interSquadronDelay,
    squadronCount: 1,
    squadronPool: selectSquadrons(pool, spec.ids),
  }));
}

function createLevel1RaptorOverlayPool() {
  return [
    {
      id: 'w1_raptor_pair_upper_left',
      dance: 'side_left',
      formation: 'line',
      entryEdge: 'left',
      entryX: 0.34,
      spacing: 84,
      planes: makeRaptorPlanes(2),
    },
    {
      id: 'w1_raptor_pair_upper_right',
      dance: 'side_right',
      formation: 'line',
      entryEdge: 'right',
      entryX: 0.34,
      spacing: 84,
      planes: makeRaptorPlanes(2),
    },
    {
      id: 'w1_raptor_pair_mid_left',
      dance: 'side_left',
      formation: 'line',
      entryEdge: 'left',
      entryX: 0.56,
      spacing: 88,
      planes: makeRaptorPlanes(2),
    },
    {
      id: 'w1_raptor_pair_mid_right',
      dance: 'side_right',
      formation: 'line',
      entryEdge: 'right',
      entryX: 0.56,
      spacing: 88,
      planes: makeRaptorPlanes(2),
    },
  ];
}

function createLevel1OverlaySquadrons() {
  return [
    ...createLevel1RaptorOverlaySquadrons(),
    ...createLevel1MineOverlaySquadrons(),
  ];
}

function createLevel1RaptorOverlaySquadrons() {
  const pool = createLevel1RaptorOverlayPool();

  return [
    {
      id: 'l1_raptor_raid_1',
      triggerWaveId: 3,
      delay: 0.30,
      squadronCount: 1,
      squadronPool: selectSquadrons(pool, [
        'w1_raptor_pair_upper_left',
        'w1_raptor_pair_upper_right',
      ]),
    },
    {
      id: 'l1_raptor_raid_2',
      triggerWaveId: 9,
      delay: 0.45,
      squadronCount: 1,
      squadronPool: selectSquadrons(pool, [
        'w1_raptor_pair_mid_left',
        'w1_raptor_pair_mid_right',
      ]),
    },
  ];
}

function createLevel1MineOverlayPool() {
  return [
    {
      id: 'w1_mine_outer_left',
      dance: 'creep_drop',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.18,
      spacing: 0,
      planes: makeMinePlanes(1),
    },
    {
      id: 'w1_mine_mid_left',
      dance: 'creep_drop',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.34,
      spacing: 0,
      planes: makeMinePlanes(1),
    },
    {
      id: 'w1_mine_inner_left',
      dance: 'creep_drop',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.44,
      spacing: 0,
      planes: makeMinePlanes(1),
    },
    {
      id: 'w1_mine_inner_right',
      dance: 'creep_drop',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.56,
      spacing: 0,
      planes: makeMinePlanes(1),
    },
    {
      id: 'w1_mine_mid_right',
      dance: 'creep_drop',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.66,
      spacing: 0,
      planes: makeMinePlanes(1),
    },
    {
      id: 'w1_mine_outer_right',
      dance: 'creep_drop',
      formation: 'line',
      entryEdge: 'top',
      entryX: 0.82,
      spacing: 0,
      planes: makeMinePlanes(1),
    },
  ];
}

function createLevel1MineOverlaySquadrons() {
  const pool = createLevel1MineOverlayPool();

  return [
    {
      id: 'l1_mine_drop_1',
      triggerWaveId: 4,
      delay: 0.20,
      squadronCount: 1,
      squadronPool: selectSquadrons(pool, [
        'w1_mine_outer_left',
        'w1_mine_mid_right',
      ]),
    },
    {
      id: 'l1_mine_drop_2',
      triggerWaveId: 7,
      delay: 0.50,
      squadronCount: 1,
      squadronPool: selectSquadrons(pool, [
        'w1_mine_mid_left',
        'w1_mine_outer_right',
      ]),
    },
    {
      id: 'l1_mine_drop_3',
      triggerWaveId: 10,
      delay: 0.30,
      squadronCount: 1,
      squadronPool: selectSquadrons(pool, [
        'w1_mine_inner_left',
        'w1_mine_mid_right',
      ]),
    },
    {
      id: 'l1_mine_drop_4',
      triggerWaveId: 13,
      delay: 0.55,
      squadronCount: 1,
      squadronPool: selectSquadrons(pool, [
        'w1_mine_inner_right',
        'w1_mine_outer_left',
      ]),
    },
  ];
}

export const LEVELS = [
  {
    id: 1,
    theme: 'Asteroid Belt',
    scrollSpeed: 80,
    difficultyBase: 1.0,
    midBoss: null,
    boss: null,

    waves: createLevel1Waves(),
    overlaySquadrons: createLevel1OverlaySquadrons(),
  },
];
