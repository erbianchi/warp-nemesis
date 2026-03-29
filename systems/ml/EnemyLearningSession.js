/** @module EnemyLearningSession */

import { EVENTS } from '../../config/events.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { EnemyFeatureEncoder } from './EnemyFeatureEncoder.js';
import { buildPlayerBulletThreatSnapshot, buildSquadSnapshot } from './EnemyPolicyMath.js';
import { SquadFeatureEncoder } from './SquadFeatureEncoder.js';
import { clamp } from '../../utils/math.js';

function average(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function resolveShieldBucket(player = {}) {
  const shieldRatio = clamp(player?.hasShield ? (player?.shieldRatio ?? 0) : 0, 0, 1);
  if (shieldRatio <= 0) return 0;
  if (shieldRatio <= 0.33) return 1;
  if (shieldRatio <= 0.66) return 2;
  return 3;
}

function resolveThreatSeverity(threat = {}, normalization = {}) {
  const maxTimeToImpactMs = Math.max(1, normalization.maxBulletTimeToImpactMs ?? 1500);
  const laneThreat = clamp(threat?.bulletLaneThreat ?? 0, 0, 1.5);
  const timeUrgency = clamp(
    1 - ((threat?.bulletTimeToImpactMs ?? maxTimeToImpactMs) / maxTimeToImpactMs),
    0,
    1
  );
  return clamp(Math.max(laneThreat, timeUrgency), 0, 1);
}

function resolveThreatBucket(threat = {}, normalization = {}) {
  const severity = resolveThreatSeverity(threat, normalization);
  if (severity <= 0.2) return 0;
  if (severity <= 0.45) return 1;
  if (severity <= 0.7) return 2;
  return 3;
}

function resolveOutcomeMagnitude(labels = {}) {
  const softOutcomeMagnitude = Math.max(
    Math.abs((labels.win ?? 0.5) - 0.5) * 2,
    Math.abs((labels.survival ?? 0.5) - 0.5) * 2
  );
  const eventOutcomeMagnitude = Math.max(
    clamp(labels.pressure ?? 0, 0, 1),
    clamp(labels.collision ?? 0, 0, 1),
    clamp(labels.bullet ?? 0, 0, 1)
  );

  return clamp(Math.max(softOutcomeMagnitude, eventOutcomeMagnitude), 0, 1);
}

function isHighValueReason(reason) {
  return reason !== 'heartbeat';
}

function isSurvivalSignalReason(reason) {
  return reason === 'action_change'
    || reason === 'threat_change'
    || reason === 'shield_change'
    || reason === 'fire'
    || reason === 'player_hit'
    || reason === 'escape';
}

/**
 * Per-run telemetry collector. It samples live enemy state/action snapshots and
 * attributes later outcomes back to each enemy instance so the next run can
 * score movement choices with learned models instead of heuristics.
 */
export class EnemyLearningSession {
  /**
   * @param {{
   *   eventSource?: Phaser.Events.EventEmitter,
   *   scene?: Phaser.Scene,
   *   getPlayerSnapshot: Function,
   *   getWeaponSnapshot: Function,
   *   getEnemies: Function,
   *   getPlayerBullets?: Function,
   *   sampleIntervalMs?: number,
   *   encoder?: EnemyFeatureEncoder,
   *   squadEncoder?: SquadFeatureEncoder,
   *   levelNumber?: number,
   * }} options
   */
  constructor(options) {
    this._eventSource = options.eventSource ?? options.scene?.events ?? null;
    this._getPlayerSnapshot = options.getPlayerSnapshot;
    this._getWeaponSnapshot = options.getWeaponSnapshot;
    this._getEnemies = options.getEnemies;
    this._getPlayerBullets = options.getPlayerBullets;
    this._sampleIntervalMs = options.sampleIntervalMs ?? ENEMY_LEARNING_CONFIG.sampleIntervalMs;
    this._encoder = options.encoder ?? new EnemyFeatureEncoder();
    this._squadEncoder = options.squadEncoder ?? new SquadFeatureEncoder();
    this._levelNumber = Math.max(1, Math.round(options.levelNumber ?? 1));
    this._enemyRegistry = new Map();
    this._squadRegistry = new Map();
    this._playerSamples = [];
    this._playerHitEvents = 0;
    this._playerHpDamageTaken = 0;
    this._playerShieldDamageTaken = 0;
    this._elapsedMs = 0;
    this._sampleRemainderMs = 0;
    this._heartbeatRemainderMs = 0;
    this._lastPlayerSampleTimeMs = -1;
    this._lastPlayerShieldBucket = null;
    this._destroyed = false;

    this._handleEnemySpawned = (payload) => this._onEnemySpawned(payload);
    this._handleEnemyFired = (payload) => this._onEnemyFired(payload);
    this._handlePlayerHit = (payload) => this._onPlayerHit(payload);
    this._handleEnemyDied = (payload) => this._onEnemyResolved(payload, 'death');
    this._handleEnemyEscaped = (payload) => this._onEnemyResolved(payload, 'escape');

    this._eventSource?.on?.(EVENTS.ENEMY_SPAWNED, this._handleEnemySpawned);
    this._eventSource?.on?.(EVENTS.ENEMY_FIRE, this._handleEnemyFired);
    this._eventSource?.on?.(EVENTS.PLAYER_HIT, this._handlePlayerHit);
    this._eventSource?.on?.(EVENTS.ENEMY_DIED, this._handleEnemyDied);
    this._eventSource?.on?.(EVENTS.ENEMY_ESCAPED, this._handleEnemyEscaped);
  }

  /**
   * @returns {number}
   */
  get elapsedMs() {
    return this._elapsedMs;
  }

  /**
   * @param {number} deltaMs
   */
  update(deltaMs) {
    if (this._destroyed) return;
    this._elapsedMs += deltaMs;
    this._sampleRemainderMs += deltaMs;
    this._heartbeatRemainderMs += deltaMs;

    const player = this._getPlayerSnapshot?.();
    const liveEnemies = (this._getEnemies?.() ?? []).filter(enemy => enemy?.active !== false && enemy?.alive !== false);
    const weapon = this._getWeaponSnapshot?.() ?? {};
    const playerBullets = this._getPlayerBullets?.() ?? [];

    while (this._sampleRemainderMs >= this._sampleIntervalMs) {
      this._sampleRemainderMs -= this._sampleIntervalMs;
      if (player && liveEnemies.length > 0) {
        this._recordPlayerSample(player, weapon, liveEnemies);
      }
    }

    if (!player || liveEnemies.length === 0) return;

    const heartbeatIntervalMs = Math.max(
      this._sampleIntervalMs,
      ENEMY_LEARNING_CONFIG.heartbeatSampleIntervalMs ?? 1000
    );
    let heartbeatDue = false;
    while (this._heartbeatRemainderMs >= heartbeatIntervalMs) {
      this._heartbeatRemainderMs -= heartbeatIntervalMs;
      heartbeatDue = true;
    }

    const currentShieldBucket = resolveShieldBucket(player);
    const shieldBucketChanged = this._lastPlayerShieldBucket !== null
      && currentShieldBucket !== this._lastPlayerShieldBucket;
    this._lastPlayerShieldBucket = currentShieldBucket;

    const context = { player, weapon, liveEnemies, playerBullets };
    for (const enemy of liveEnemies) {
      const registry = this._enemyRegistry.get(enemy);
      if (!registry?.enemyType) continue;
      const threat = buildPlayerBulletThreatSnapshot(playerBullets, enemy, ENEMY_LEARNING_CONFIG.normalization);
      const currentThreatBucket = resolveThreatBucket(threat, ENEMY_LEARNING_CONFIG.normalization);
      const currentActionMode = enemy._adaptiveActionMode ?? 'hold';

      if ((registry.samples?.length ?? 0) === 0) {
        this._recordEnemySample(enemy, registry, context, 'spawn', { force: true });
        continue;
      }

      if (currentActionMode !== registry.lastActionMode) {
        this._recordEnemySample(enemy, registry, context, 'action_change');
        continue;
      }

      if (currentThreatBucket !== registry.lastThreatBucket) {
        this._recordEnemySample(enemy, registry, context, 'threat_change');
        continue;
      }

      if (shieldBucketChanged && currentShieldBucket !== registry.lastShieldBucket) {
        this._recordEnemySample(enemy, registry, context, 'shield_change');
        continue;
      }

      if (heartbeatDue && (this._elapsedMs - (registry.lastSampleTimeMs ?? 0)) >= heartbeatIntervalMs) {
        this._recordEnemySample(enemy, registry, context, 'heartbeat');
      }
    }
  }

  _buildSamplingContext(focusEnemy = null) {
    const player = this._getPlayerSnapshot?.();
    const weapon = this._getWeaponSnapshot?.() ?? {};
    const playerBullets = this._getPlayerBullets?.() ?? [];
    const liveEnemies = (this._getEnemies?.() ?? []).filter(enemy => enemy?.active !== false && enemy?.alive !== false);

    if (focusEnemy && !liveEnemies.includes(focusEnemy)) {
      liveEnemies.push(focusEnemy);
    }

    return {
      player,
      weapon,
      playerBullets,
      liveEnemies,
    };
  }

  _recordPlayerSampleOnce(player, weapon, liveEnemies) {
    if (this._lastPlayerSampleTimeMs === this._elapsedMs) return;
    this._recordPlayerSample(player, weapon, liveEnemies);
    this._lastPlayerSampleTimeMs = this._elapsedMs;
  }

  _recordEnemySample(enemy, registry, context, reason, options = {}) {
    if (!enemy || !registry?.enemyType) return false;
    if ((registry.samples?.length ?? 0) >= ENEMY_LEARNING_CONFIG.maxSamplesPerEnemy) return false;

    const player = context?.player;
    if (!player) return false;

    const debounceMs = Math.max(0, ENEMY_LEARNING_CONFIG.decisionSampleDebounceMs ?? 120);
    const elapsedSinceLastSample = this._elapsedMs - (registry.lastSampleTimeMs ?? Number.NEGATIVE_INFINITY);
    if (!options.force && elapsedSinceLastSample < debounceMs) {
      return false;
    }

    const liveEnemies = context?.liveEnemies ?? [];
    const weapon = context?.weapon ?? {};
    const playerBullets = context?.playerBullets ?? [];
    const squad = buildSquadSnapshot(liveEnemies, enemy._squadId ?? null, enemy);
    const threat = buildPlayerBulletThreatSnapshot(playerBullets, enemy, ENEMY_LEARNING_CONFIG.normalization);
    const actionMode = enemy._adaptiveActionMode ?? 'hold';
    const threatBucket = resolveThreatBucket(threat, ENEMY_LEARNING_CONFIG.normalization);
    const shieldBucket = resolveShieldBucket(player);
    const sample = this._encoder.buildSample({
      enemyType: registry.enemyType,
      player,
      weapon,
      enemyX: enemy.x ?? 0,
      enemyY: enemy.y ?? 0,
      speed: enemy.speed ?? 0,
      squad,
      threat,
      actionMode,
    });

    registry.samples.push({
      sample,
      timeMs: this._elapsedMs,
      reason,
      actionMode,
      threatBucket,
      shieldBucket,
    });
    registry.lastSampleTimeMs = this._elapsedMs;
    registry.lastSampleReason = reason;
    registry.lastActionMode = actionMode;
    registry.lastThreatBucket = threatBucket;
    registry.lastShieldBucket = shieldBucket;

    this._recordPlayerSampleOnce(player, weapon, liveEnemies);
    if (registry.squadId) {
      this._sampleSquad(registry.squadId, liveEnemies, player, weapon);
    }

    return true;
  }

  _recordPlayerSample(player, weapon, liveEnemies) {
    const normalization = ENEMY_LEARNING_CONFIG.normalization ?? {};
    const diagonal = Math.max(1, normalization.diagonal ?? 1);
    const nearestEnemyDistance = (liveEnemies ?? []).reduce((closest, enemy) => (
      Math.min(
        closest,
        Math.hypot((enemy?.x ?? 0) - (player?.x ?? 0), (enemy?.y ?? 0) - (player?.y ?? 0))
      )
    ), Number.POSITIVE_INFINITY);
    const maxSamples = Math.max(48, (ENEMY_LEARNING_CONFIG.maxSamplesPerEnemy ?? 40) * 16);

    this._playerSamples.push({
      timeMs: this._elapsedMs,
      xNorm: clamp((player?.x ?? 0) / Math.max(1, normalization.width ?? 1), 0, 1),
      yNorm: clamp((player?.y ?? 0) / Math.max(1, normalization.height ?? 1), 0, 1),
      hpRatio: clamp(player?.hpRatio ?? 1, 0, 1),
      hasShield: player?.hasShield ? 1 : 0,
      shieldRatio: clamp(player?.shieldRatio ?? 0, 0, 1),
      heatRatio: clamp(weapon?.heatRatio ?? 0, 0, 1),
      isOverheated: weapon?.isOverheated ? 1 : 0,
      primaryWeaponKey: typeof weapon?.primaryWeaponKey === 'string' ? weapon.primaryWeaponKey : 'laser',
      liveEnemyCountNorm: clamp((liveEnemies?.length ?? 0) / 16, 0, 1.5),
      nearestEnemyDistanceNorm: clamp(
        (Number.isFinite(nearestEnemyDistance) ? nearestEnemyDistance : diagonal) / diagonal,
        0,
        1.5
      ),
    });

    while (this._playerSamples.length > maxSamples) {
      this._playerSamples.shift();
    }
  }

  _sampleSquad(squadId, liveEnemies, player, weapon) {
    const squadRegistry = this._squadRegistry.get(squadId);
    if (!squadRegistry) return;
    if (squadRegistry.samples.length >= ENEMY_LEARNING_CONFIG.maxSamplesPerEnemy) return;
    if (squadRegistry.lastSampleTimeMs === this._elapsedMs) return;

    const squadEnemies = liveEnemies.filter(enemy => enemy?._squadId === squadId);
    if (squadEnemies.length === 0) return;

    const fallbackEnemy = squadEnemies[0];
    const squad = buildSquadSnapshot(squadEnemies, squadId, fallbackEnemy);
    const closestEnemyDistance = squadEnemies.reduce((closest, enemy) => (
      Math.min(
        closest,
        Math.hypot((enemy?.x ?? 0) - (player?.x ?? 0), (enemy?.y ?? 0) - (player?.y ?? 0))
      )
    ), Number.POSITIVE_INFINITY);
    const sample = this._squadEncoder.buildSample({
      player,
      weapon,
      squad,
      closestEnemyDistance: Number.isFinite(closestEnemyDistance) ? closestEnemyDistance : 0,
      overlay: squadRegistry.overlay,
      formation: squadRegistry.formation,
      dance: squadRegistry.dance,
      primaryEnemyType: squadRegistry.primaryEnemyType,
      stats: {
        spawnCount: squadRegistry.spawnCount,
        shotCount: squadRegistry.shotCount,
        playerHitCount: squadRegistry.playerHitCount,
        hpDamageToPlayer: squadRegistry.hpDamageToPlayer,
        shieldDamageToPlayer: squadRegistry.shieldDamageToPlayer,
        collisionDeathCount: squadRegistry.collisionDeathCount,
      },
    });

    squadRegistry.samples.push(sample);
    squadRegistry.lastSampleTimeMs = this._elapsedMs;
  }

  _onEnemySpawned(payload = {}) {
    const enemy = payload.enemy;
    const enemyType = payload.type ?? enemy?.enemyType;
    if (!enemy || !enemyType) return;

    if (payload.squadId) {
      enemy._squadSpawnCount = Math.max(enemy._squadSpawnCount ?? 0, payload.squadSize ?? 1);
    }

    this._enemyRegistry.set(enemy, {
      enemyType,
      spawnTimeMs: this._elapsedMs,
      squadId: payload.squadId ?? enemy._squadId ?? null,
      samples: [],
      shotCount: 0,
      playerHitCount: 0,
      hpDamageToPlayer: 0,
      shieldDamageToPlayer: 0,
      pressureTimes: [],
      pressureEvents: [],
      collisionDeath: false,
      bulletDeath: false,
      deathCount: 0,
      escapeCount: 0,
      resolvedCount: 0,
      resolutionTimeMs: null,
      lifetimeMsTotal: 0,
      lastSampleTimeMs: Number.NEGATIVE_INFINITY,
      lastSampleReason: null,
      lastActionMode: enemy._adaptiveActionMode ?? 'hold',
      lastThreatBucket: 0,
      lastShieldBucket: this._lastPlayerShieldBucket ?? 0,
    });

    const squadId = payload.squadId ?? enemy._squadId ?? null;
    if (!squadId) return;

    if (!this._squadRegistry.has(squadId)) {
      this._squadRegistry.set(squadId, {
        squadId,
        squadTemplateId: payload.squadTemplateId ?? enemy._squadTemplateId ?? null,
        formation: payload.formation ?? enemy._formationType ?? null,
        dance: payload.dance ?? enemy._spawnDance ?? enemy.dance ?? null,
        overlay: Boolean(payload.overlay ?? enemy._overlayRaid),
        waveId: payload.waveId ?? enemy._spawnWaveId ?? null,
        levelNumber: this._levelNumber,
        primaryEnemyType: enemyType,
        spawnCount: 0,
        shotCount: 0,
        playerHitCount: 0,
        hpDamageToPlayer: 0,
        shieldDamageToPlayer: 0,
        collisionDeathCount: 0,
        deathCount: 0,
        escapeCount: 0,
        resolvedCount: 0,
        lifetimeMsTotal: 0,
        samples: [],
        lastSampleTimeMs: Number.NEGATIVE_INFINITY,
      });
    }

    const squadRegistry = this._squadRegistry.get(squadId);
    squadRegistry.spawnCount += 1;
    squadRegistry.primaryEnemyType = squadRegistry.primaryEnemyType ?? enemyType;

    const context = this._buildSamplingContext(enemy);
    const registry = this._enemyRegistry.get(enemy);
    this._recordEnemySample(enemy, registry, context, 'spawn', { force: true });
  }

  _onEnemyFired(payload = {}) {
    const enemy = payload.sourceEnemy ?? null;
    const enemyId = payload.sourceEnemyId ?? null;

    for (const [candidate, registry] of this._enemyRegistry.entries()) {
      if ((enemy && candidate === enemy) || (enemyId && candidate?._learningId === enemyId)) {
        registry.shotCount += 1;
        const squadRegistry = registry.squadId ? this._squadRegistry.get(registry.squadId) : null;
        squadRegistry && (squadRegistry.shotCount += 1);
        this._recordEnemySample(candidate, registry, this._buildSamplingContext(candidate), 'fire', {
          force: true,
        });
        return;
      }
    }
  }

  _onPlayerHit(payload = {}) {
    const enemyId = payload.sourceEnemyId ?? null;
    this._playerHitEvents += 1;
    this._playerHpDamageTaken += Math.max(0, payload.hpDamage ?? 0);
    this._playerShieldDamageTaken += Math.max(0, payload.absorbed ?? 0);
    if (!enemyId) return;

    for (const [enemy, registry] of this._enemyRegistry.entries()) {
      if (enemy?._learningId !== enemyId) continue;
      registry.playerHitCount += 1;
      registry.hpDamageToPlayer += Math.max(0, payload.hpDamage ?? 0);
      registry.shieldDamageToPlayer += Math.max(0, payload.absorbed ?? 0);
      registry.pressureTimes.push(this._elapsedMs);
      registry.pressureEvents.push({
        timeMs: this._elapsedMs,
        hpDamage: Math.max(0, payload.hpDamage ?? 0),
        shieldDamage: Math.max(0, payload.absorbed ?? 0),
      });
      const squadRegistry = registry.squadId ? this._squadRegistry.get(registry.squadId) : null;
      if (squadRegistry) {
        squadRegistry.playerHitCount += 1;
        squadRegistry.hpDamageToPlayer += Math.max(0, payload.hpDamage ?? 0);
        squadRegistry.shieldDamageToPlayer += Math.max(0, payload.absorbed ?? 0);
      }
      this._recordEnemySample(enemy, registry, this._buildSamplingContext(enemy), 'player_hit', {
        force: true,
      });
      return;
    }
  }

  _onEnemyResolved(payload = {}, resolution) {
    const enemy = payload.enemy;
    const registry = enemy ? this._enemyRegistry.get(enemy) : null;
    if (!registry) return;

    if (resolution === 'death') {
      registry.deathCount += 1;
      registry.collisionDeath = payload.cause === 'player_collision';
      registry.bulletDeath = payload.cause === 'player_bullet';
    }
    if (resolution === 'escape') registry.escapeCount += 1;
    registry.resolvedCount += 1;
    registry.resolutionTimeMs = this._elapsedMs;
    registry.lifetimeMsTotal += Math.max(0, this._elapsedMs - registry.spawnTimeMs);

    const squadRegistry = registry.squadId ? this._squadRegistry.get(registry.squadId) : null;
    if (squadRegistry) {
      if (resolution === 'death') {
        squadRegistry.deathCount += 1;
        if (payload.cause === 'player_collision') squadRegistry.collisionDeathCount += 1;
      }
      if (resolution === 'escape') squadRegistry.escapeCount += 1;
      squadRegistry.resolvedCount += 1;
      squadRegistry.lifetimeMsTotal += Math.max(0, this._elapsedMs - registry.spawnTimeMs);
    }

    this._recordEnemySample(enemy, registry, this._buildSamplingContext(enemy), resolution, {
      force: true,
    });
  }

  /**
   * @returns {Array<{enemyType: string, enemyCount: number, sampleCount: number, examples: Array<{vector: number[], labels: {pressure: number, collision: number}}>, summary: object}>}
   */
  buildTrainingRecords(outcome = 'player_win') {
    const grouped = new Map();
    const labeling = ENEMY_LEARNING_CONFIG.labeling ?? {};
    const outcomeHorizonMs = Math.max(1, labeling.outcomeHorizonMs ?? 750);
    const minSurvivalObservationMs = Math.max(0, labeling.minSurvivalObservationMs ?? 500);
    const strongOutcomeMagnitudeThreshold = clamp(labeling.strongOutcomeMagnitudeThreshold ?? 0.35, 0, 1);
    const weakOutcomeMagnitudeThreshold = clamp(labeling.weakOutcomeMagnitudeThreshold ?? 0.15, 0, 1);
    const heartbeatDropThreshold = clamp(labeling.heartbeatDropThreshold ?? 0.25, 0, 1);

    for (const registry of this._enemyRegistry.values()) {
      if (!grouped.has(registry.enemyType)) {
        grouped.set(registry.enemyType, {
          enemyType: registry.enemyType,
          enemyCount: 0,
          sampleCount: 0,
          examples: [],
          summary: {
            spawnCount: 0,
            shotCount: 0,
            playerHitCount: 0,
            hpDamageToPlayer: 0,
            shieldDamageToPlayer: 0,
            collisionDeathCount: 0,
            deathCount: 0,
            escapeCount: 0,
            resolvedCount: 0,
            lifetimeMsTotal: 0,
          },
        });
      }

      const record = grouped.get(registry.enemyType);
      record.enemyCount += 1;
      record.summary.spawnCount += 1;
      record.summary.shotCount += registry.shotCount;
      record.summary.playerHitCount += registry.playerHitCount;
      record.summary.hpDamageToPlayer += registry.hpDamageToPlayer;
      record.summary.shieldDamageToPlayer += registry.shieldDamageToPlayer;
      record.summary.collisionDeathCount += registry.collisionDeath ? 1 : 0;
      record.summary.deathCount += registry.deathCount;
      record.summary.escapeCount += registry.escapeCount;
      record.summary.resolvedCount += registry.resolvedCount;
      record.summary.lifetimeMsTotal += registry.lifetimeMsTotal;

      const didEscape = registry.escapeCount > 0;
      const resolutionTimeMs = registry.resolutionTimeMs ?? Number.POSITIVE_INFINITY;
      const exampleCountBefore = record.examples.length;

      for (let index = 0; index < registry.samples.length; index += 1) {
        const sampleEntry = registry.samples[index];
        const sample = sampleEntry?.sample ?? sampleEntry;
        const sampleTimeMs = sampleEntry?.timeMs ?? registry.spawnTimeMs;
        const nextSampleTimeMs = registry.samples[index + 1]?.timeMs ?? Number.POSITIVE_INFINITY;
        const horizonEndMs = Math.min(
          sampleTimeMs + outcomeHorizonMs,
          nextSampleTimeMs,
          resolutionTimeMs,
          this._elapsedMs
        );
        const observedHorizonMs = Math.max(0, horizonEndMs - sampleTimeMs);
        const pressureEventsInHorizon = (registry.pressureEvents ?? []).filter(event => (
          event?.timeMs >= sampleTimeMs && event?.timeMs <= horizonEndMs
        ));
        const pressureLabel = pressureEventsInHorizon.length > 0 ? 1 : 0;
        const collisionLabel = registry.collisionDeath
          && Number.isFinite(registry.resolutionTimeMs)
          && registry.resolutionTimeMs >= sampleTimeMs
          && registry.resolutionTimeMs <= horizonEndMs
          ? 1
          : 0;
        const bulletLabel = registry.bulletDeath
          && Number.isFinite(registry.resolutionTimeMs)
          && registry.resolutionTimeMs >= sampleTimeMs
          && registry.resolutionTimeMs <= horizonEndMs
          ? 1
          : 0;
        const escapedInHorizon = didEscape
          && Number.isFinite(registry.resolutionTimeMs)
          && registry.resolutionTimeMs >= sampleTimeMs
          && registry.resolutionTimeMs <= horizonEndMs;
        const hasMeaningfulSurvivalObservation = observedHorizonMs >= minSurvivalObservationMs
          || collisionLabel > 0
          || bulletLabel > 0
          || escapedInHorizon;
        const survivalSignal = escapedInHorizon || (
          hasMeaningfulSurvivalObservation
          && (
            (sampleEntry?.threatBucket ?? 0) > 0
            || isSurvivalSignalReason(sampleEntry?.reason)
          )
        );
        const survivalLabel = collisionLabel > 0 || bulletLabel > 0
          ? 0
          : survivalSignal
            ? 1
            : 0.5;
        const winShift = (
          pressureLabel * 0.55
          + (survivalLabel - 0.5) * 0.45
          - collisionLabel * 0.7
          - bulletLabel * 0.75
        );
        const winLabel = clamp(0.5 + winShift, 0, 1);
        const labels = {
          win: winLabel,
          survival: survivalLabel,
          pressure: pressureLabel,
          collision: collisionLabel,
          bullet: bulletLabel,
        };
        const outcomeMagnitude = resolveOutcomeMagnitude(labels);
        if (sampleEntry?.reason === 'heartbeat' && outcomeMagnitude < heartbeatDropThreshold) {
          continue;
        }
        if (!isHighValueReason(sampleEntry?.reason) && outcomeMagnitude < weakOutcomeMagnitudeThreshold) {
          continue;
        }
        if (
          pressureLabel <= 0
          && collisionLabel <= 0
          && bulletLabel <= 0
          && outcomeMagnitude < strongOutcomeMagnitudeThreshold
        ) {
          continue;
        }
        const encoded = this._encoder.encodeSample(sample);
        record.examples.push({
          vector: encoded.vector,
          labels,
          meta: {
            reason: sampleEntry?.reason ?? 'heartbeat',
            actionMode: sampleEntry?.actionMode ?? 'hold',
            threatBucket: sampleEntry?.threatBucket ?? 0,
            shieldBucket: sampleEntry?.shieldBucket ?? 0,
            horizonMs: observedHorizonMs,
            outcomeMagnitude,
          },
        });
      }

      record.sampleCount += record.examples.length - exampleCountBefore;
    }

    return [...grouped.values()];
  }

  /**
   * @returns {Array<{levelNumber: number, squadId: string, squadTemplateId: string|null, formation: string|null, dance: string|null, overlay: boolean, examples: Array<{vector: number[], labels: {pressure: number, collision: number}}>, summary: object}>}
   */
  buildSquadTrainingRecords() {
    const records = [];

    for (const registry of this._squadRegistry.values()) {
      if ((registry.samples?.length ?? 0) === 0) continue;

      const pressureLabel = registry.playerHitCount > 0 || registry.hpDamageToPlayer > 0 || registry.shieldDamageToPlayer > 0
        ? 1
        : 0;
      const collisionLabel = registry.collisionDeathCount > 0 ? 1 : 0;

      records.push({
        levelNumber: registry.levelNumber,
        squadId: registry.squadId,
        squadTemplateId: registry.squadTemplateId,
        formation: registry.formation,
        dance: registry.dance,
        overlay: registry.overlay,
        examples: registry.samples.map(sample => {
          const encoded = this._squadEncoder.encodeSample(sample);
          return {
            vector: encoded.vector,
            labels: {
              pressure: pressureLabel,
              collision: collisionLabel,
            },
          };
        }),
        summary: {
          spawnCount: registry.spawnCount,
          shotCount: registry.shotCount,
          playerHitCount: registry.playerHitCount,
          hpDamageToPlayer: registry.hpDamageToPlayer,
          shieldDamageToPlayer: registry.shieldDamageToPlayer,
          collisionDeathCount: registry.collisionDeathCount,
          deathCount: registry.deathCount,
          escapeCount: registry.escapeCount,
          resolvedCount: registry.resolvedCount,
          lifetimeMsTotal: registry.lifetimeMsTotal,
        },
      });
    }

    return records;
  }

  /**
   * Summarize the current run into a compact style profile that can steer the
   * next level's generator toward this player's habits.
   * @returns {object}
   */
  buildPlayerStyleProfile() {
    const samples = this._playerSamples;
    const latest = samples.at(-1) ?? null;

    if (!latest) {
      return {
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
      };
    }

    let lateralTravel = 0;
    let moveCount = 0;
    let reversals = 0;
    let previousDirection = 0;

    for (let index = 1; index < samples.length; index += 1) {
      const deltaX = samples[index].xNorm - samples[index - 1].xNorm;
      const absDeltaX = Math.abs(deltaX);
      if (absDeltaX < 0.0025) continue;

      lateralTravel += absDeltaX;
      moveCount += 1;

      const direction = Math.sign(deltaX);
      if (previousDirection !== 0 && direction !== 0 && direction !== previousDirection) {
        reversals += 1;
      }
      previousDirection = direction || previousDirection;
    }

    const weaponCounts = new Map();
    samples.forEach((sample) => {
      const key = sample.primaryWeaponKey ?? 'laser';
      weaponCounts.set(key, (weaponCounts.get(key) ?? 0) + 1);
    });
    const preferredWeaponKey = [...weaponCounts.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'laser';
    const sampleCount = samples.length;
    const moveDivisor = Math.max(1, moveCount);
    const avgXNorm = average(samples.map(sample => sample.xNorm));

    return {
      sampleCount,
      laneBiasX: clamp((avgXNorm - 0.5) * 2, -1, 1),
      aggression: clamp(1 - average(samples.map(sample => sample.yNorm)), 0, 1),
      dodgeIntensity: clamp((lateralTravel / moveDivisor) * 6.5, 0, 1),
      reversalRate: clamp(reversals / Math.max(1, moveCount - 1), 0, 1),
      heatGreed: clamp(
        average(samples.map(sample => sample.heatRatio)) * 0.78
        + average(samples.map(sample => sample.isOverheated)) * 0.34,
        0,
        1
      ),
      overheatRate: clamp(average(samples.map(sample => sample.isOverheated)), 0, 1),
      shieldReliance: clamp(
        average(samples.map(sample => sample.hasShield)) * 0.55
        + average(samples.map(sample => sample.shieldRatio)) * 0.45,
        0,
        1
      ),
      hpRatio: clamp(latest.hpRatio ?? 1, 0, 1),
      shieldRatio: clamp(latest.shieldRatio ?? 0, 0, 1),
      pressureExposure: clamp(
        (this._playerHitEvents / Math.max(1, sampleCount)) * 3.2
        + average(samples.map(sample => sample.liveEnemyCountNorm)) * 0.14,
        0,
        1
      ),
      enemyDensity: clamp(average(samples.map(sample => sample.liveEnemyCountNorm)), 0, 1),
      nearestEnemyDistanceNorm: clamp(
        average(samples.map(sample => sample.nearestEnemyDistanceNorm)),
        0,
        1.5
      ),
      preferredWeaponKey,
    };
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._eventSource?.off?.(EVENTS.ENEMY_SPAWNED, this._handleEnemySpawned);
    this._eventSource?.off?.(EVENTS.ENEMY_FIRE, this._handleEnemyFired);
    this._eventSource?.off?.(EVENTS.PLAYER_HIT, this._handlePlayerHit);
    this._eventSource?.off?.(EVENTS.ENEMY_DIED, this._handleEnemyDied);
    this._eventSource?.off?.(EVENTS.ENEMY_ESCAPED, this._handleEnemyEscaped);
  }
}
