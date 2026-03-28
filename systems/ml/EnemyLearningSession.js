/** @module EnemyLearningSession */

import { EVENTS } from '../../config/events.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { EnemyFeatureEncoder } from './EnemyFeatureEncoder.js';
import { buildPlayerBulletThreatSnapshot, buildSquadSnapshot } from './EnemyPolicyMath.js';
import { SquadFeatureEncoder } from './SquadFeatureEncoder.js';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveEventSignal(sampleTimeMs, eventTimes, windowMs) {
  if (!Array.isArray(eventTimes) || eventTimes.length === 0) return 0;

  let strongest = 0;
  for (const eventTimeMs of eventTimes) {
    const deltaMs = Math.abs(eventTimeMs - sampleTimeMs);
    if (!Number.isFinite(deltaMs) || deltaMs > windowMs) continue;
    strongest = Math.max(strongest, 1 - deltaMs / Math.max(1, windowMs));
  }

  return clamp(strongest, 0, 1);
}

/**
 * Per-run telemetry collector. It samples live enemy state/action snapshots and
 * attributes later outcomes back to each enemy instance so the next run can
 * score movement choices with learned models instead of heuristics.
 */
export class EnemyLearningSession {
  /**
   * @param {{
   *   scene: Phaser.Scene,
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
    this._scene = options.scene;
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
    this._elapsedMs = 0;
    this._sampleRemainderMs = 0;
    this._destroyed = false;

    this._handleEnemySpawned = (payload) => this._onEnemySpawned(payload);
    this._handleEnemyFired = (payload) => this._onEnemyFired(payload);
    this._handlePlayerHit = (payload) => this._onPlayerHit(payload);
    this._handleEnemyDied = (payload) => this._onEnemyResolved(payload, 'death');
    this._handleEnemyEscaped = (payload) => this._onEnemyResolved(payload, 'escape');

    this._scene.events?.on?.(EVENTS.ENEMY_SPAWNED, this._handleEnemySpawned);
    this._scene.events?.on?.(EVENTS.ENEMY_FIRE, this._handleEnemyFired);
    this._scene.events?.on?.(EVENTS.PLAYER_HIT, this._handlePlayerHit);
    this._scene.events?.on?.(EVENTS.ENEMY_DIED, this._handleEnemyDied);
    this._scene.events?.on?.(EVENTS.ENEMY_ESCAPED, this._handleEnemyEscaped);
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

    while (this._sampleRemainderMs >= this._sampleIntervalMs) {
      this._sampleRemainderMs -= this._sampleIntervalMs;
      this._sample();
    }
  }

  _sample() {
    const player = this._getPlayerSnapshot?.();
    if (!player) return;

    const liveEnemies = (this._getEnemies?.() ?? []).filter(enemy => enemy?.active !== false && enemy?.alive !== false);
    if (liveEnemies.length === 0) return;

    const weapon = this._getWeaponSnapshot?.() ?? {};
    const playerBullets = this._getPlayerBullets?.() ?? [];
    const sampledSquads = new Set();

    for (const enemy of liveEnemies) {
      const registry = this._enemyRegistry.get(enemy);
      if (!registry?.enemyType) continue;
      if (registry.samples.length >= ENEMY_LEARNING_CONFIG.maxSamplesPerEnemy) continue;

      const squad = buildSquadSnapshot(liveEnemies, enemy._squadId ?? null, enemy);
      const threat = buildPlayerBulletThreatSnapshot(playerBullets, enemy, ENEMY_LEARNING_CONFIG.normalization);
      const sample = this._encoder.buildSample({
        enemyType: registry.enemyType,
        player,
        weapon,
        enemyX: enemy.x ?? 0,
        enemyY: enemy.y ?? 0,
        speed: enemy.speed ?? 0,
        squad,
        threat,
        actionMode: enemy._adaptiveActionMode ?? 'hold',
      });

      registry.samples.push({
        sample,
        timeMs: this._elapsedMs,
      });

      if (registry.squadId && !sampledSquads.has(registry.squadId)) {
        sampledSquads.add(registry.squadId);
        this._sampleSquad(registry.squadId, liveEnemies, player, weapon);
      }
    }
  }

  _sampleSquad(squadId, liveEnemies, player, weapon) {
    const squadRegistry = this._squadRegistry.get(squadId);
    if (!squadRegistry) return;
    if (squadRegistry.samples.length >= ENEMY_LEARNING_CONFIG.maxSamplesPerEnemy) return;

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
      collisionDeath: false,
      bulletDeath: false,
      deathCount: 0,
      escapeCount: 0,
      resolvedCount: 0,
      resolutionTimeMs: null,
      lifetimeMsTotal: 0,
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
      });
    }

    const squadRegistry = this._squadRegistry.get(squadId);
    squadRegistry.spawnCount += 1;
    squadRegistry.primaryEnemyType = squadRegistry.primaryEnemyType ?? enemyType;
  }

  _onEnemyFired(payload = {}) {
    const enemy = payload.sourceEnemy ?? null;
    const enemyId = payload.sourceEnemyId ?? null;

    for (const [candidate, registry] of this._enemyRegistry.entries()) {
      if ((enemy && candidate === enemy) || (enemyId && candidate?._learningId === enemyId)) {
        registry.shotCount += 1;
        const squadRegistry = registry.squadId ? this._squadRegistry.get(registry.squadId) : null;
        squadRegistry && (squadRegistry.shotCount += 1);
        return;
      }
    }
  }

  _onPlayerHit(payload = {}) {
    const enemyId = payload.sourceEnemyId ?? null;
    if (!enemyId) return;

    for (const [enemy, registry] of this._enemyRegistry.entries()) {
      if (enemy?._learningId !== enemyId) continue;
      registry.playerHitCount += 1;
      registry.hpDamageToPlayer += Math.max(0, payload.hpDamage ?? 0);
      registry.shieldDamageToPlayer += Math.max(0, payload.absorbed ?? 0);
      registry.pressureTimes.push(this._elapsedMs);
      const squadRegistry = registry.squadId ? this._squadRegistry.get(registry.squadId) : null;
      if (squadRegistry) {
        squadRegistry.playerHitCount += 1;
        squadRegistry.hpDamageToPlayer += Math.max(0, payload.hpDamage ?? 0);
        squadRegistry.shieldDamageToPlayer += Math.max(0, payload.absorbed ?? 0);
      }
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
  }

  /**
   * @returns {Array<{enemyType: string, enemyCount: number, sampleCount: number, examples: Array<{vector: number[], labels: {pressure: number, collision: number}}>, summary: object}>}
   */
  buildTrainingRecords(outcome = 'player_win') {
    const grouped = new Map();
    const labeling = ENEMY_LEARNING_CONFIG.labeling ?? {};
    const outcomePrior = outcome === 'enemy_win'
      ? labeling.enemyWinPrior ?? 0.8
      : labeling.playerWinPrior ?? 0.2;
    const outcomePriorWeight = labeling.outcomePriorWeight ?? 0.2;
    const contributionWeight = labeling.contributionWeight ?? 0.8;
    const pressureWindowMs = labeling.pressureWindowMs ?? 1600;
    const collisionWindowMs = labeling.collisionWindowMs ?? 850;
    const bulletWindowMs = labeling.bulletWindowMs ?? 1250;
    const survivalWindowMs = labeling.survivalWindowMs ?? 1800;
    const escapeContribution = labeling.escapeContribution ?? 0.35;

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
      const didDie = registry.deathCount > 0;
      const resolutionTimeMs = registry.resolutionTimeMs ?? this._elapsedMs;
      const escapeTimes = didEscape ? [resolutionTimeMs] : [];
      const collisionTimes = registry.collisionDeath ? [resolutionTimeMs] : [];
      const bulletTimes = registry.bulletDeath ? [resolutionTimeMs] : [];

      for (const sampleEntry of registry.samples) {
        const sample = sampleEntry?.sample ?? sampleEntry;
        const sampleTimeMs = sampleEntry?.timeMs ?? registry.spawnTimeMs;
        const pressureLabel = resolveEventSignal(sampleTimeMs, registry.pressureTimes, pressureWindowMs);
        const collisionLabel = resolveEventSignal(sampleTimeMs, collisionTimes, collisionWindowMs);
        const bulletLabel = resolveEventSignal(sampleTimeMs, bulletTimes, bulletWindowMs);
        const terminalDanger = didDie
          ? resolveEventSignal(sampleTimeMs, [resolutionTimeMs], survivalWindowMs)
          : 0;
        const escapeSignal = resolveEventSignal(sampleTimeMs, escapeTimes, survivalWindowMs);
        const survivalLabel = clamp(
          didDie
            ? 1 - terminalDanger
            : (didEscape ? 0.72 + escapeSignal * 0.12 : 0.82),
          0,
          1
        );
        const contributionScore = clamp(
          pressureLabel * 0.65
          + survivalLabel * 0.2
          + escapeSignal * escapeContribution,
          0,
          1
        );
        const winLabel = clamp(
          outcomePrior * outcomePriorWeight
          + contributionScore * contributionWeight,
          0,
          1
        );
        const encoded = this._encoder.encodeSample(sample);
        record.examples.push({
          vector: encoded.vector,
          labels: {
            win: winLabel,
            survival: survivalLabel,
            pressure: pressureLabel,
            collision: collisionLabel,
            bullet: bulletLabel,
          },
        });
      }

      record.sampleCount += registry.samples.length;
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

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._scene.events?.off?.(EVENTS.ENEMY_SPAWNED, this._handleEnemySpawned);
    this._scene.events?.off?.(EVENTS.ENEMY_FIRE, this._handleEnemyFired);
    this._scene.events?.off?.(EVENTS.PLAYER_HIT, this._handlePlayerHit);
    this._scene.events?.off?.(EVENTS.ENEMY_DIED, this._handleEnemyDied);
    this._scene.events?.off?.(EVENTS.ENEMY_ESCAPED, this._handleEnemyEscaped);
  }
}
