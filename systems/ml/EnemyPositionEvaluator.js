/** @module EnemyPositionEvaluator */

import {
  DEFAULT_ENEMY_ACTION_MODE,
  ENEMY_LEARNING_CONFIG,
} from '../../config/enemyLearning.config.js';
import { buildPlayerBulletThreatSnapshot, buildSquadSnapshot } from './EnemyPolicyMath.js';
import { clamp } from '../../utils/math.js';

const ACTION_MODE_BIASES = Object.freeze({
  hold: Object.freeze({ survival: 0, offense: 0, collision: 0, bullet: 0 }),
  press: Object.freeze({ survival: -0.08, offense: 0.18, collision: 0.10, bullet: 0.08 }),
  flank: Object.freeze({ survival: 0.03, offense: 0.15, collision: 0.02, bullet: -0.03 }),
  evade: Object.freeze({ survival: 0.20, offense: -0.14, collision: -0.12, bullet: -0.22 }),
  retreat: Object.freeze({ survival: 0.12, offense: -0.22, collision: -0.08, bullet: -0.10 }),
});

function blendValue(fallback, learned, weight) {
  return fallback + ((learned - fallback) * weight);
}

function resolveHeuristicBlendWeight(config, modelState) {
  const policy = config.runtimePolicy ?? {};
  const minSamples = Math.max(1, policy.heuristicBlendMinSamples ?? 18);
  const maxSamples = Math.max(minSamples, policy.heuristicBlendMaxSamples ?? 180);
  const sampleCount = Math.max(0, Math.round(modelState?.sampleCount ?? 0));
  if (maxSamples === minSamples) return sampleCount >= maxSamples ? 1 : 0;
  return clamp((sampleCount - minSamples) / (maxSamples - minSamples), 0, 1);
}

function resolveHeuristicPredictions(sample = {}, candidate = {}, player = {}, threat = {}) {
  const actionMode = candidate.actionMode ?? DEFAULT_ENEMY_ACTION_MODE;
  const modeBias = ACTION_MODE_BIASES[actionMode] ?? ACTION_MODE_BIASES.hold;
  const shotAlignment = clamp(sample.shotAlignment ?? 0, 0, 1);
  const proximity = clamp(sample.proximityNorm ?? 0, 0, 1);
  const shieldedLaneRisk = clamp(sample.shieldedLaneRisk ?? 0, 0, 1);
  const bulletLaneThreat = clamp(sample.bulletLaneThreat ?? 0, 0, 1);
  const bulletUrgency = clamp(1 - (sample.bulletTimeToImpactNorm ?? 1), 0, 1);
  const bulletDistanceThreat = clamp(1 - (sample.nearestBulletDistanceNorm ?? 1), 0, 1);
  const playerShieldTax = player?.hasShield ? 0.10 : 0;

  const bullet = clamp(
    bulletLaneThreat * 0.62
    + bulletUrgency * 0.48
    + bulletDistanceThreat * 0.24
    + modeBias.bullet,
    0,
    1
  );

  const collision = clamp(
    proximity * 0.56
    + shieldedLaneRisk * 0.58
    + playerShieldTax
    + modeBias.collision,
    0,
    1
  );

  const offense = clamp(
    shotAlignment * 0.54
    + proximity * 0.24
    + clamp(sample.squadAliveNorm ?? 1, 0, 1) * 0.08
    - bullet * 0.14
    - collision * 0.10
    - playerShieldTax * 0.45
    + modeBias.offense,
    0,
    1
  );

  const survival = clamp(
    0.60
    - bullet * 0.52
    - collision * 0.38
    + (1 - clamp(sample.playerDamageMultiplierNorm ?? 0, 0, 1.5)) * 0.08
    + modeBias.survival,
    0,
    1
  );

  return {
    survival,
    offense,
    collision,
    bullet,
    pressure: offense,
    enemyWinRate: offense,
    threat: {
      bulletLaneThreat,
      bulletUrgency,
      bulletDistanceThreat,
    },
  };
}

function resolveCornerPenalty(x, y, normalization, cornerDistancePx) {
  const width = normalization.width ?? 0;
  const height = normalization.height ?? 0;
  const distanceToNearestCorner = Math.min(
    Math.hypot(x, y),
    Math.hypot(width - x, y),
    Math.hypot(x, height - y),
    Math.hypot(width - x, height - y)
  );

  return clamp(1 - distanceToNearestCorner / Math.max(1, cornerDistancePx), 0, 1);
}

function resolveSpatialPenalties(candidate, enemy, liveEnemies, config) {
  const policy = config.runtimePolicy ?? {};
  const normalization = config.normalization ?? {};
  const spacingRadiusPx = Math.max(1, policy.sameTypeSpacingPx ?? 88);
  const laneCrowdingPx = Math.max(1, policy.laneCrowdingPx ?? 72);
  const cornerPenaltyDistancePx = Math.max(1, policy.cornerPenaltyDistancePx ?? 112);
  const sameTypeEnemies = (liveEnemies ?? []).filter(other => (
    other
    && other !== enemy
    && other.active !== false
    && other.alive !== false
    && other.enemyType === enemy?.enemyType
  ));

  let spacingPenalty = 0;
  let crowdedNeighbors = 0;

  for (const other of sameTypeEnemies) {
    const dx = (candidate.x ?? 0) - (other?.x ?? 0);
    const dy = (candidate.y ?? 0) - (other?.y ?? 0);
    const distance = Math.hypot(dx, dy);
    spacingPenalty = Math.max(
      spacingPenalty,
      clamp(1 - distance / spacingRadiusPx, 0, 1)
    );

    if (Math.abs(dx) <= laneCrowdingPx && Math.abs(dy) <= laneCrowdingPx * 1.5) {
      crowdedNeighbors += 1;
    }
  }

  return {
    spacingPenalty,
    laneCrowdingPenalty: clamp(
      crowdedNeighbors / Math.max(1, sameTypeEnemies.length || 1),
      0,
      1
    ),
    cornerPenalty: resolveCornerPenalty(
      candidate.x ?? 0,
      candidate.y ?? 0,
      normalization,
      cornerPenaltyDistancePx
    ),
  };
}

function resolveEnemyRuntimeContext(enemy) {
  return enemy?.getRuntimeContext?.() ?? null;
}

function resolveEnemyPlayerSnapshot(enemy, runtimeContext) {
  if (typeof enemy?._getPlayerSnapshot === 'function') {
    return enemy._getPlayerSnapshot();
  }

  const snapshot = runtimeContext?.getPlayerSnapshot?.();
  if (snapshot) return snapshot;

  const normalization = ENEMY_LEARNING_CONFIG.normalization ?? {};
  return {
    x: (normalization.width ?? 0) / 2,
    y: (normalization.height ?? 0) - 80,
    hasShield: false,
    shieldRatio: 0,
    hpRatio: 1,
  };
}

function resolveEnemyThreatSnapshot(enemy, runtimeContext, policyApi) {
  if (typeof enemy?._getPlayerBulletThreatSnapshot === 'function') {
    return enemy._getPlayerBulletThreatSnapshot();
  }

  const playerBullets = runtimeContext?.getPlayerBullets?.() ?? [];
  return buildPlayerBulletThreatSnapshot(
    playerBullets,
    enemy,
    policyApi?._config?.normalization ?? ENEMY_LEARNING_CONFIG.normalization ?? {}
  );
}

function buildFallbackMovePlan(enemy, baseX, options = {}) {
  const config = ENEMY_LEARNING_CONFIG.normalization ?? {};
  const rangePx = Math.max(0, options.rangePx ?? 0);
  const yRangePx = Math.max(0, options.yRangePx ?? Math.round(rangePx * 0.7));
  const marginPx = Math.max(0, options.marginPx ?? 24);
  const topMarginPx = Math.max(0, options.topMarginPx ?? 24);
  const bottomMarginPx = Math.max(
    topMarginPx,
    options.bottomMarginPx ?? ((config.height ?? 0) - 24)
  );
  const candidateY = options.candidateY ?? enemy?.y ?? 0;
  const commit = options.commit !== false;
  const canUseAdaptiveBehavior = typeof enemy?.canUseAdaptiveBehavior === 'function'
    ? enemy.canUseAdaptiveBehavior()
    : false;
  const speedScalar = canUseAdaptiveBehavior
    ? clamp(
        enemy?.adaptiveProfile?.currentSpeedScalar ?? 1,
        enemy?.adaptiveProfile?.minSpeedScalar ?? 1,
        enemy?.adaptiveProfile?.maxSpeedScalar ?? 1
      )
    : 1;

  if (commit && typeof enemy?._applyAdaptiveSpeedScalar === 'function') {
    enemy._applyAdaptiveSpeedScalar(speedScalar);
  }

  return {
    x: clamp(baseX, marginPx, (config.width ?? 0) - marginPx),
    y: clamp(candidateY, topMarginPx, bottomMarginPx),
    speedScalar,
    predictedEnemyWinRate: enemy?.adaptiveProfile?.predictedEnemyWinRate ?? 0.5,
    predictedSurvival: enemy?.adaptiveProfile?.predictedSurvival ?? 0.5,
    predictedPressure: enemy?.adaptiveProfile?.predictedPressure ?? 0.5,
    predictedCollisionRisk: enemy?.adaptiveProfile?.predictedCollisionRisk ?? 0.5,
    predictedBulletRisk: enemy?.adaptiveProfile?.predictedBulletRisk ?? 0.5,
    score: 0,
    actionMode: enemy?._adaptiveActionMode ?? DEFAULT_ENEMY_ACTION_MODE,
  };
}

function buildAdaptiveAnchors(enemy, policyApi, baseX, candidateY, rangePx, yRangePx, bounds) {
  const runtimeContext = resolveEnemyRuntimeContext(enemy);
  const player = resolveEnemyPlayerSnapshot(enemy, runtimeContext);
  const threat = resolveEnemyThreatSnapshot(enemy, runtimeContext, policyApi);
  const config = policyApi?._config?.normalization ?? ENEMY_LEARNING_CONFIG.normalization ?? {};
  const viewportWidth = config.width ?? 0;

  const anchors = [
    {
      mode: DEFAULT_ENEMY_ACTION_MODE,
      x: baseX,
      y: candidateY,
    },
    {
      mode: 'press',
      x: player.x ?? baseX,
      y: clamp(
        Math.min((player.y ?? candidateY) - 90, candidateY + yRangePx),
        bounds.topMarginPx,
        bounds.bottomMarginPx
      ),
    },
    {
      mode: 'retreat',
      x: baseX,
      y: clamp(candidateY - yRangePx, bounds.topMarginPx, bounds.bottomMarginPx),
    },
    {
      mode: 'evade',
      x: clamp(threat.suggestedSafeX ?? baseX, bounds.marginPx, viewportWidth - bounds.marginPx),
      y: clamp(threat.suggestedSafeY ?? candidateY, bounds.topMarginPx, bounds.bottomMarginPx),
    },
  ];

  const playerX = player.x ?? baseX;
  const flankOffset = Math.max(rangePx, 40);
  anchors.push({
    mode: 'flank',
    x: clamp(
      playerX + (baseX <= playerX ? -flankOffset : flankOffset),
      bounds.marginPx,
      viewportWidth - bounds.marginPx
    ),
    y: clamp(candidateY + yRangePx * 0.25, bounds.topMarginPx, bounds.bottomMarginPx),
  });

  return anchors;
}

function buildAdaptiveCandidates(policyApi, anchors, options = {}) {
  const config = policyApi?._config?.normalization ?? ENEMY_LEARNING_CONFIG.normalization ?? {};
  const viewportWidth = config.width ?? 0;
  const viewportHeight = config.height ?? 0;
  const rangePx = Math.max(0, options.rangePx ?? 0);
  const yRangePx = Math.max(0, options.yRangePx ?? 0);
  const marginPx = Math.max(0, options.marginPx ?? 0);
  const topMarginPx = Math.max(0, options.topMarginPx ?? 0);
  const bottomMarginPx = Math.max(topMarginPx, options.bottomMarginPx ?? viewportHeight);
  const xOffsets = Array.isArray(options.xOffsets) && options.xOffsets.length > 0 ? options.xOffsets : [0];
  const yOffsets = Array.isArray(options.yOffsets) && options.yOffsets.length > 0 ? options.yOffsets : [0];
  const speedScalars = Array.isArray(options.speedScalars) && options.speedScalars.length > 0 ? options.speedScalars : [1];
  const xScale = options.xScale ?? 0.45;
  const yScale = options.yScale ?? 0.45;
  const candidates = [];

  for (const anchor of anchors) {
    for (const xOffset of xOffsets) {
      const candidateX = clamp(
        anchor.x + (xOffset * rangePx * xScale),
        marginPx,
        viewportWidth - marginPx
      );
      for (const yOffset of yOffsets) {
        const candidateY = clamp(
          anchor.y + (yOffset * yRangePx * yScale),
          topMarginPx,
          bottomMarginPx
        );
        for (const speedScalar of speedScalars) {
          candidates.push({
            x: candidateX,
            y: candidateY,
            speedScalar,
            actionMode: anchor.mode,
          });
        }
      }
    }
  }

  return candidates;
}

function buildFineAdaptiveCandidates(policyApi, enemy, coarseChoices, speedScalars, bounds, rangePx, yRangePx) {
  const config = policyApi?._config?.normalization ?? ENEMY_LEARNING_CONFIG.normalization ?? {};
  const viewportWidth = config.width ?? 0;
  const viewportHeight = config.height ?? 0;
  const marginPx = Math.max(0, bounds.marginPx ?? 0);
  const topMarginPx = Math.max(0, bounds.topMarginPx ?? 0);
  const bottomMarginPx = Math.max(topMarginPx, bounds.bottomMarginPx ?? viewportHeight);
  const fineXOffsets = rangePx > 0 ? [-0.5, 0, 0.5] : [0];
  const fineYOffsets = yRangePx > 0 ? [-0.5, 0, 0.5] : [0];
  const fineStepX = rangePx * 0.45;
  const fineStepY = yRangePx * 0.45;
  const candidates = [];
  const seen = new Set();

  const resolveSpeedIndex = (value) => {
    let bestIndex = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 0; index < speedScalars.length; index += 1) {
      const delta = Math.abs((speedScalars[index] ?? 1) - value);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    return bestIndex;
  };

  for (const choice of coarseChoices ?? []) {
    const centerSpeedIndex = resolveSpeedIndex(choice.speedScalar ?? 1);
    const localSpeedScalars = [...new Set([
      speedScalars[Math.max(0, centerSpeedIndex - 1)],
      speedScalars[centerSpeedIndex],
      speedScalars[Math.min(speedScalars.length - 1, centerSpeedIndex + 1)],
    ].filter(value => Number.isFinite(value)))];

    for (const xOffset of fineXOffsets) {
      const candidateX = clamp(
        (choice.x ?? enemy?.x ?? 0) + (xOffset * fineStepX * 0.5),
        marginPx,
        viewportWidth - marginPx
      );
      for (const yOffset of fineYOffsets) {
        const candidateY = clamp(
          (choice.y ?? enemy?.y ?? 0) + (yOffset * fineStepY * 0.5),
          topMarginPx,
          bottomMarginPx
        );
        for (const speedScalar of localSpeedScalars) {
          const key = [
            Math.round(candidateX * 100),
            Math.round(candidateY * 100),
            Math.round(speedScalar * 1000),
            choice.actionMode ?? DEFAULT_ENEMY_ACTION_MODE,
          ].join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            x: candidateX,
            y: candidateY,
            speedScalar,
            actionMode: choice.actionMode ?? DEFAULT_ENEMY_ACTION_MODE,
          });
        }
      }
    }
  }

  return candidates;
}

export function resolveAdaptiveMovePlan(policyApi, enemy, baseX, options = {}) {
  if (!enemy) {
    return buildFallbackMovePlan(enemy, baseX ?? 0, options);
  }

  const config = policyApi?._config ?? ENEMY_LEARNING_CONFIG;
  const normalization = config.normalization ?? {};
  const rangePx = Math.max(0, options.rangePx ?? 0);
  const yRangePx = Math.max(0, options.yRangePx ?? Math.round(rangePx * 0.7));
  const marginPx = Math.max(0, options.marginPx ?? 24);
  const topMarginPx = Math.max(0, options.topMarginPx ?? 24);
  const bottomMarginPx = Math.max(topMarginPx, options.bottomMarginPx ?? ((normalization.height ?? 0) - 24));
  const candidateY = options.candidateY ?? enemy.y ?? 0;
  const clampedBaseX = clamp(baseX, marginPx, (normalization.width ?? 0) - marginPx);
  const clampedBaseY = clamp(candidateY, topMarginPx, bottomMarginPx);
  const runtimeContext = resolveEnemyRuntimeContext(enemy);

  const canUseAdaptiveBehavior = typeof enemy.canUseAdaptiveBehavior === 'function'
    ? enemy.canUseAdaptiveBehavior()
    : false;
  if (!canUseAdaptiveBehavior || (!policyApi?.resolveBehavior && !policyApi?.rankBehaviors)) {
    return buildFallbackMovePlan(enemy, clampedBaseX, {
      ...options,
      candidateY: clampedBaseY,
      marginPx,
      topMarginPx,
      bottomMarginPx,
    });
  }

  const speedScalars = options.speedScalars ?? policyApi.getSpeedCandidates?.(enemy.enemyType) ?? [1];
  const anchors = buildAdaptiveAnchors(
    enemy,
    policyApi,
    clampedBaseX,
    clampedBaseY,
    rangePx,
    yRangePx,
    { marginPx, topMarginPx, bottomMarginPx }
  );
  const fallbackResolved = buildFallbackMovePlan(enemy, clampedBaseX, {
    ...options,
    candidateY: clampedBaseY,
    marginPx,
    topMarginPx,
    bottomMarginPx,
    commit: false,
  });
  let resolved = null;

  if (typeof policyApi?.rankBehaviors === 'function') {
    const coarseCandidates = buildAdaptiveCandidates(policyApi, anchors, {
      rangePx,
      yRangePx,
      marginPx,
      topMarginPx,
      bottomMarginPx,
      xOffsets: rangePx > 0 ? [-1, 0, 1] : [0],
      yOffsets: yRangePx > 0 ? [-1, 0, 1] : [0],
      speedScalars,
    });
    const coarseChoices = policyApi.rankBehaviors({
      enemy,
      enemyType: enemy.enemyType,
      candidates: coarseCandidates,
      context: runtimeContext,
    }, 3);
    const fineCandidates = buildFineAdaptiveCandidates(
      policyApi,
      enemy,
      coarseChoices,
      speedScalars,
      { marginPx, topMarginPx, bottomMarginPx },
      rangePx,
      yRangePx
    );
    resolved = policyApi.rankBehaviors({
      enemy,
      enemyType: enemy.enemyType,
      candidates: fineCandidates.length > 0 ? fineCandidates : coarseCandidates,
      context: runtimeContext,
    }, 1)?.[0] ?? coarseChoices?.[0] ?? null;
  } else {
    const fullCandidates = buildAdaptiveCandidates(policyApi, anchors, {
      rangePx,
      yRangePx,
      marginPx,
      topMarginPx,
      bottomMarginPx,
      xOffsets: rangePx > 0 ? (policyApi.getPositionOffsets?.() ?? [-1, -0.5, 0, 0.5, 1]) : [0],
      yOffsets: yRangePx > 0 ? (policyApi.getVerticalOffsets?.() ?? [-1, -0.5, 0, 0.5, 1]) : [0],
      speedScalars,
    });
    resolved = policyApi.resolveBehavior({
      enemy,
      enemyType: enemy.enemyType,
      candidates: fullCandidates,
      context: runtimeContext,
    });
  }

  resolved ??= fallbackResolved;

  const speedScalar = options.commit !== false && typeof enemy._applyAdaptiveSpeedScalar === 'function'
    ? enemy._applyAdaptiveSpeedScalar(resolved.speedScalar ?? 1)
    : clamp(
        resolved.speedScalar ?? 1,
        enemy.adaptiveProfile?.minSpeedScalar ?? 1,
        enemy.adaptiveProfile?.maxSpeedScalar ?? 1
      );

  if (enemy.adaptiveProfile) {
    enemy.adaptiveProfile.predictedEnemyWinRate = resolved.predictedEnemyWinRate ?? enemy.adaptiveProfile.predictedEnemyWinRate;
    enemy.adaptiveProfile.predictedSurvival = resolved.predictedSurvival ?? enemy.adaptiveProfile.predictedSurvival;
    enemy.adaptiveProfile.predictedPressure = resolved.predictedPressure ?? enemy.adaptiveProfile.predictedPressure;
    enemy.adaptiveProfile.predictedCollisionRisk = resolved.predictedCollisionRisk ?? enemy.adaptiveProfile.predictedCollisionRisk;
    enemy.adaptiveProfile.predictedBulletRisk = resolved.predictedBulletRisk ?? enemy.adaptiveProfile.predictedBulletRisk;
  }
  enemy._adaptiveActionMode = resolved.actionMode ?? enemy._adaptiveActionMode ?? DEFAULT_ENEMY_ACTION_MODE;

  return {
    x: resolved.x ?? clampedBaseX,
    y: resolved.y ?? clampedBaseY,
    speedScalar,
    predictedEnemyWinRate: resolved.predictedEnemyWinRate ?? 0.5,
    predictedSurvival: resolved.predictedSurvival ?? 0.5,
    predictedPressure: resolved.predictedPressure ?? 0.5,
    predictedCollisionRisk: resolved.predictedCollisionRisk ?? 0.5,
    predictedBulletRisk: resolved.predictedBulletRisk ?? 0.5,
    score: resolved.score ?? 0,
    actionMode: resolved.actionMode ?? DEFAULT_ENEMY_ACTION_MODE,
  };
}

export class EnemyPositionEvaluator {
  /**
   * @param {object} policy
   */
  constructor(policy) {
    this._policy = policy;
  }

  rankBehaviors(options, limit = 1) {
    const policy = this._policy;
    const enemyType = options.enemyType;
    const adaptiveConfig = policy?._enemyConfigs?.[enemyType]?.adaptive;
    if (!adaptiveConfig?.enabled) {
      return (options.candidates ?? []).slice(0, Math.max(1, limit));
    }

    const runtimeContext = options.context ?? resolveEnemyRuntimeContext(options.enemy);
    const liveEnemies = options.liveEnemies ?? runtimeContext?.getEnemies?.() ?? [];
    const player = options.player ?? resolveEnemyPlayerSnapshot(options.enemy, runtimeContext);
    const weapon = options.weapon ?? runtimeContext?.getServices?.()?.weapons?.getSnapshot?.() ?? runtimeContext?.getWeapons?.()?.getLearningSnapshot?.() ?? {
      primaryWeaponKey: null,
      heatRatio: 0,
      isOverheated: false,
      primaryDamageMultiplier: 1,
    };
    const playerBullets = options.playerBullets ?? runtimeContext?.getPlayerBullets?.() ?? [];
    const playerNotShooting = playerBullets.length === 0;
    const offensiveCandidates = playerNotShooting
      ? (options.candidates ?? []).filter(candidate => (
          candidate?.actionMode === 'press' || candidate?.actionMode === 'flank'
        ))
      : [];
    const candidatesToRank = offensiveCandidates.length > 0
      ? offensiveCandidates
      : (options.candidates ?? []);
    const weights = policy._config.runtimeWeights ?? {
      survival: 0.45,
      offense: 0.55,
      collision: 0.38,
      bullet: 0.52,
      spacing: 0.45,
      laneCrowding: 0.25,
      corner: 0.18,
    };

    const { modelState, network } = policy._getRuntimeCombatNetwork(enemyType);
    const learnedWeight = resolveHeuristicBlendWeight(policy._config, modelState);
    const rankedChoices = [];

    for (const candidate of candidatesToRank) {
      const squad = buildSquadSnapshot(liveEnemies, options.enemy?._squadId ?? null, {
        ...options.enemy,
        x: candidate.x,
        y: candidate.y,
      });
      const threat = buildPlayerBulletThreatSnapshot(playerBullets, {
        ...options.enemy,
        x: candidate.x,
        y: candidate.y,
      }, policy._config.normalization);
      const sample = policy._encoder.buildSample({
        enemyType,
        player,
        weapon,
        enemyX: candidate.x,
        enemyY: candidate.y,
        speed: Math.max(1, (options.enemy?._nativeSpeed ?? options.enemy?.speed ?? 1) * candidate.speedScalar),
        squad,
        threat,
        actionMode: candidate.actionMode ?? 'hold',
      });
      const encoded = policy._encoder.encodeSample(sample);
      const heuristic = resolveHeuristicPredictions(sample, candidate, player, threat);
      const learned = network.predict(encoded.vector);
      const predictedSurvival = blendValue(heuristic.survival, learned.survival ?? 0.5, learnedWeight);
      const predictedOffense = blendValue(heuristic.offense, learned.offense ?? 0.5, learnedWeight);
      const predictedCollisionRisk = blendValue(heuristic.collision, learned.collision ?? 0.5, learnedWeight);
      const predictedBulletRisk = blendValue(heuristic.bullet, learned.bullet ?? 0.5, learnedWeight);
      const spatialPenalties = resolveSpatialPenalties(candidate, options.enemy, liveEnemies, policy._config);
      const bulletWeight = (weights.bullet ?? 0.52) * (
        0.7
        + heuristic.threat.bulletLaneThreat * 0.55
        + heuristic.threat.bulletUrgency * 0.35
      );
      const collisionWeight = (weights.collision ?? 0.38) * (
        0.72
        + clamp(sample.proximityNorm ?? 0, 0, 1) * 0.45
        + (player?.hasShield ? 0.18 : 0)
      );
      const score = (
        predictedSurvival * (weights.survival ?? 0.45)
        + predictedOffense  * (weights.offense  ?? 0.55)
        - predictedCollisionRisk * collisionWeight
        - predictedBulletRisk * bulletWeight
        - spatialPenalties.spacingPenalty      * (weights.spacing      ?? 0)
        - spatialPenalties.laneCrowdingPenalty * (weights.laneCrowding ?? 0)
        - spatialPenalties.cornerPenalty       * (weights.corner       ?? 0)
      );

      rankedChoices.push({
        ...candidate,
        score,
        predictedSurvival,
        predictedOffense,
        // Legacy aliases consumed by EnemyBase / adaptiveProfile
        predictedEnemyWinRate:  predictedOffense,
        predictedPressure:      predictedOffense,
        predictedCollisionRisk,
        predictedBulletRisk,
      });
    }

    rankedChoices.sort((left, right) => (
      (right.score ?? 0)            - (left.score ?? 0)
      || (right.predictedOffense ?? 0)   - (left.predictedOffense ?? 0)
      || (right.predictedSurvival ?? 0)  - (left.predictedSurvival ?? 0)
    ));

    return rankedChoices.slice(0, Math.max(1, limit));
  }

  /**
   * @param {{
   *   enemy: object,
   *   enemyType: string,
   *   candidates: Array<{x: number, y: number, speedScalar: number}>,
   * }} options
   * @returns {{x: number, y: number, speedScalar: number, actionMode?: string, score: number, predictedEnemyWinRate: number, predictedSurvival: number, predictedPressure: number, predictedCollisionRisk: number, predictedBulletRisk: number}|null}
   */
  resolveBehavior(options) {
    return this.rankBehaviors(options, 1)[0] ?? null;
  }

  resolveMovePlan(enemy, baseX, options = {}) {
    return resolveAdaptiveMovePlan(this._policy, enemy, baseX, options);
  }

  scoreCurrentPosition(options) {
    if (typeof options.enemy?.canUseAdaptiveBehavior === 'function' && !options.enemy.canUseAdaptiveBehavior()) {
      return {
        x: options.enemy?.x ?? 0,
        y: options.enemy?.y ?? 0,
        speedScalar: options.enemy?.adaptiveProfile?.currentSpeedScalar ?? 1,
        actionMode: options.enemy?._adaptiveActionMode ?? 'hold',
        score: 0,
        predictedEnemyWinRate: options.enemy?.adaptiveProfile?.predictedEnemyWinRate ?? 0.5,
        predictedSurvival: options.enemy?.adaptiveProfile?.predictedSurvival ?? 0.5,
        predictedPressure: options.enemy?.adaptiveProfile?.predictedPressure ?? 0.5,
        predictedCollisionRisk: options.enemy?.adaptiveProfile?.predictedCollisionRisk ?? 0.5,
        predictedBulletRisk: options.enemy?.adaptiveProfile?.predictedBulletRisk ?? 0.5,
      };
    }

    return this.resolveBehavior({
      ...options,
      candidates: [{
        x: options.enemy?.x ?? 0,
        y: options.enemy?.y ?? 0,
        speedScalar: options.enemy?.adaptiveProfile?.currentSpeedScalar ?? 1,
        actionMode: options.enemy?._adaptiveActionMode ?? 'hold',
      }],
    });
  }

  /**
   * Resolve candidate speeds for a given class without duplicating config math
   * in entity classes.
   * @param {string} enemyType
   * @returns {number[]}
   */
  getSpeedCandidates(enemyType) {
    const adaptiveConfig = this._policy?._enemyConfigs?.[enemyType]?.adaptive;
    if (!adaptiveConfig?.enabled) return [1];
    return this._policy._buildSpeedScalars(
      adaptiveConfig.minSpeedScalar ?? 1,
      adaptiveConfig.maxSpeedScalar ?? 1
    );
  }

  /**
   * @returns {number[]}
   */
  getPositionOffsets() {
    return [...(this._policy?._config?.runtimePolicy?.positionOffsets ?? [-1, -0.5, 0, 0.5, 1])];
  }

  /**
   * @returns {number[]}
   */
  getVerticalOffsets() {
    return [...(this._policy?._config?.runtimePolicy?.verticalOffsets ?? [-1, -0.5, 0, 0.5, 1])];
  }
}
