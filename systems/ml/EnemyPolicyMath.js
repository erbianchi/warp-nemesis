/** @module EnemyPolicyMath */

import { clamp } from '../../utils/math.js';

const STAR_DIRECTIONS = Object.freeze([
  { x: 0, y: 1 },
  { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: 1, y: 0 },
  { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  { x: 0, y: -1 },
  { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  { x: -1, y: 0 },
  { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
]);

function safeDivide(numerator, denominator, fallback = 0) {
  return denominator > 0 ? numerator / denominator : fallback;
}

function resolveDownwardAlignment(dx, dy, sameLaneThresholdPx) {
  if (dy <= 0) return 0;
  return clamp(1 - Math.abs(dx) / Math.max(1, sameLaneThresholdPx * 2), 0, 1);
}

function resolveStarAlignment(dx, dy) {
  const magnitude = Math.hypot(dx, dy);
  if (magnitude <= 0) return 1;

  const unitX = dx / magnitude;
  const unitY = dy / magnitude;
  let bestDot = -1;

  for (const direction of STAR_DIRECTIONS) {
    bestDot = Math.max(bestDot, unitX * direction.x + unitY * direction.y);
  }

  return clamp((bestDot + 1) / 2, 0, 1);
}

export function resolveShotAlignment(enemyType, dx, dy, normalization = {}) {
  const sameLaneThresholdPx = normalization.sameLaneThresholdPx ?? 56;

  switch (enemyType) {
    case 'raptor':
      return resolveStarAlignment(dx, dy);
    case 'mine':
      return 0;
    case 'skirm':
    default:
      return resolveDownwardAlignment(dx, dy, sameLaneThresholdPx);
  }
}

export function buildSquadSnapshot(liveEnemies, squadId, fallbackEnemy) {
  const fallbackX = fallbackEnemy?.x ?? 0;
  const fallbackY = fallbackEnemy?.y ?? 0;

  if (!squadId) {
    return {
      centroidX: fallbackX,
      centroidY: fallbackY,
      width: 0,
      aliveRatio: 1,
    };
  }

  const squadEnemies = liveEnemies.filter(enemy => enemy?._squadId === squadId);
  if (squadEnemies.length === 0) {
    return {
      centroidX: fallbackX,
      centroidY: fallbackY,
      width: 0,
      aliveRatio: 1,
    };
  }

  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;

  for (const enemy of squadEnemies) {
    const enemyX = enemy?.x ?? 0;
    const enemyY = enemy?.y ?? 0;
    sumX += enemyX;
    sumY += enemyY;
    minX = Math.min(minX, enemyX);
    maxX = Math.max(maxX, enemyX);
  }

  return {
    centroidX: sumX / squadEnemies.length,
    centroidY: sumY / squadEnemies.length,
    width: Number.isFinite(minX) && Number.isFinite(maxX) ? maxX - minX : 0,
    aliveRatio: clamp(
      safeDivide(
        squadEnemies.length,
        Math.max(
          squadEnemies.length,
          fallbackEnemy?._squadSpawnCount ?? squadEnemies.length
        ),
        1
      ),
      0,
      1
    ),
  };
}

export function buildPlayerBulletThreatSnapshot(playerBullets, enemy, normalization = {}) {
  const bullets = Array.isArray(playerBullets) ? playerBullets.filter(bullet => bullet?.active !== false) : [];
  const enemyX = enemy?.x ?? 0;
  const enemyY = enemy?.y ?? 0;
  const sameLaneThresholdPx = normalization.sameLaneThresholdPx ?? 56;
  const maxDistance = normalization.maxBulletThreatDistance ?? 1000;
  const maxTimeToImpactMs = normalization.maxBulletTimeToImpactMs ?? 1500;

  if (bullets.length === 0) {
    return {
      nearestBulletDistance: maxDistance,
      bulletLaneThreat: 0,
      bulletTimeToImpactMs: maxTimeToImpactMs,
      suggestedSafeX: enemyX,
      suggestedSafeY: enemyY,
    };
  }

  let nearestBulletDistance = Number.POSITIVE_INFINITY;
  let strongestThreat = 0;
  let shortestTimeToImpactMs = maxTimeToImpactMs;
  let suggestedSafeX = enemyX;
  let suggestedSafeY = enemyY;

  for (const bullet of bullets) {
    const bulletX = bullet?.x ?? 0;
    const bulletY = bullet?.y ?? 0;
    const vx = bullet?.body?._vx ?? bullet?.body?.velocity?.x ?? 0;
    const vy = bullet?.body?._vy ?? bullet?.body?.velocity?.y ?? 0;
    const dx = enemyX - bulletX;
    const dy = enemyY - bulletY;
    const distance = Math.hypot(dx, dy);
    nearestBulletDistance = Math.min(nearestBulletDistance, distance);

    const sameLaneFactor = clamp(1 - Math.abs(dx) / Math.max(1, sameLaneThresholdPx * 2), 0, 1);
    const approaching = dy < 0 && vy < 0 ? 1 : 0;
    const bulletDistanceFactor = clamp(1 - distance / Math.max(1, maxDistance), 0, 1);
    const threat = sameLaneFactor * (approaching ? 1 : 0.4) * bulletDistanceFactor;

    if (threat > strongestThreat) {
      strongestThreat = threat;
      const evadeDirection = dx >= 0 ? 1 : -1;
      suggestedSafeX = enemyX + evadeDirection * sameLaneThresholdPx * (1.2 + threat);
      suggestedSafeY = enemyY + (approaching ? -32 : -16);
    }

    if (approaching) {
      const relativeYSpeed = Math.abs(vy) || 1;
      const timeToImpactMs = clamp(Math.abs(dy) / relativeYSpeed * 1000, 0, maxTimeToImpactMs);
      shortestTimeToImpactMs = Math.min(shortestTimeToImpactMs, timeToImpactMs);
    }
  }

  return {
    nearestBulletDistance: Number.isFinite(nearestBulletDistance) ? nearestBulletDistance : maxDistance,
    bulletLaneThreat: strongestThreat,
    bulletTimeToImpactMs: Number.isFinite(shortestTimeToImpactMs) ? shortestTimeToImpactMs : maxTimeToImpactMs,
    suggestedSafeX,
    suggestedSafeY,
  };
}
