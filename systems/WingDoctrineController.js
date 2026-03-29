/** @module WingDoctrineController
 * Lightweight doctrine controller for armed non-formation squads.
 *
 * Unlike `FormationController`, this controller does not tween ships through a
 * shared authored path. Instead it coordinates class-native movement by feeding
 * each ship a tactical anchor plus controller-owned volley timing.
 */

import { GAME_CONFIG } from '../config/game.config.js';
import { EVENTS } from '../config/events.config.js';
import { ENEMY_LEARNING_CONFIG } from '../config/enemyLearning.config.js';
import { resolveShotAlignment } from './ml/EnemyPolicyMath.js';
import { clamp } from '../utils/math.js';

const { WIDTH, HEIGHT } = GAME_CONFIG;

function resolveStableRole(index, count) {
  if (count <= 1) return { side: 'center', rank: 0, count };
  if (count === 2) return { side: index === 0 ? 'left' : 'right', rank: index, count };

  const ratio = index / Math.max(1, count - 1);
  if (ratio <= 0.34) return { side: 'left', rank: index, count };
  if (ratio >= 0.66) return { side: 'right', rank: index, count };
  return { side: 'center', rank: index, count };
}

function buildNeutralMetrics(now) {
  return {
    firstVisibleAt: null,
    entryCompleteAt: null,
    timeToCommitMs: null,
    pressureOccupancyMs: 0,
    bracketMs: 0,
    coordinatedVolleyCount: 0,
    playerDisplacementPxMax: 0,
    forcedReactionCount: 0,
    deadAirMs: 0,
    lastTickAt: now,
  };
}

export function getDefaultWingDoctrineBehavior(primaryEnemyType = 'skirm') {
  const config = ENEMY_LEARNING_CONFIG.squadRuntimePolicy?.wingDoctrine ?? {};
  const typeConfig = config.enemyTypes?.[primaryEnemyType] ?? {};

  return {
    replanMs: config.replanMs ?? 180,
    anchorWeightFloor: config.anchorWeightFloor ?? 0.28,
    anchorWeightCeil: config.anchorWeightCeil ?? 0.82,
    rangeFloorPx: config.rangeFloorPx ?? 44,
    rangeCeilPx: config.rangeCeilPx ?? 160,
    yRangeFloorPx: config.yRangeFloorPx ?? 34,
    yRangeCeilPx: config.yRangeCeilPx ?? 132,
    commitMs: config.commitMs ?? 720,
    attackMs: config.attackMs ?? 1180,
    recoverMs: config.recoverMs ?? 560,
    pressureLeadPx: config.pressureLeadPx ?? 148,
    attackDepthBonusPx: config.attackDepthBonusPx ?? 18,
    recoverLiftPx: config.recoverLiftPx ?? 62,
    laneTolerancePx: config.laneTolerancePx ?? 44,
    bracketTolerancePx: config.bracketTolerancePx ?? 28,
    reactionDistancePx: config.reactionDistancePx ?? 60,
    shootRate: typeConfig.shootRate ?? 1.15,
    volleySize: typeConfig.volleySize ?? 2,
    intraVolleyMs: typeConfig.intraVolleyMs ?? 110,
    pattern: typeConfig.pattern ?? 'focus_lane',
    leadDistancePx: typeConfig.leadDistancePx ?? 144,
  };
}

export function resolveWingDoctrineBehavior(controller = {}, primaryEnemyType = 'skirm') {
  const defaults = getDefaultWingDoctrineBehavior(primaryEnemyType);
  return {
    ...defaults,
    ...(controller.wingDoctrine ?? {}),
  };
}

export class WingDoctrineController {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../entities/EnemyBase.js').IFormationMember[]} ships
   * @param {object} [controller={}]
   * @param {Function} [rng=Math.random]
   * @param {object|null} [services=scene?._services ?? null]
   */
  constructor(scene, ships, controller = {}, rng = Math.random, services = scene?._services ?? null) {
    this._scene = scene;
    this._services = services;
    this._rng = rng;
    const firstMeta = ships[0]?.getFormationMeta?.() ?? {};
    this._squadId = firstMeta.squadId ?? null;
    this._squadTemplateId = firstMeta.squadTemplateId ?? null;
    this._formation = controller.formation ?? firstMeta.formation ?? null;
    this._dance = controller.dance ?? firstMeta.dance ?? ships[0]?.dance ?? null;
    this._overlay = Boolean(controller.overlay ?? firstMeta.overlay);
    this._primaryEnemyType = ships[0]?.enemyType ?? 'skirm';
    this._behavior = resolveWingDoctrineBehavior(controller, this._primaryEnemyType);
    this._squadDirective = null;
    this._fleet = [];
    this._shootIdx = 0;
    this._wingShotCursor = 0;
    this._rowShotCursor = 0;
    this._replanTimer = null;
    this._shootTimer = null;
    this._stopped = false;
    this._squadStats = {
      spawnCount: ships.length,
      shotCount: 0,
      playerHitCount: 0,
      hpDamageToPlayer: 0,
      shieldDamageToPlayer: 0,
      collisionDeathCount: 0,
    };
    this._objectiveState = null;
    this._behaviorMetrics = buildNeutralMetrics(this._getNow());

    this._handlePlayerHit = (payload = {}) => {
      if (!this._squadId || payload.squadId !== this._squadId) return;
      this._squadStats.playerHitCount += 1;
      this._squadStats.hpDamageToPlayer += Math.max(0, payload.hpDamage ?? 0);
      this._squadStats.shieldDamageToPlayer += Math.max(0, payload.absorbed ?? 0);
      this._behaviorMetrics.forcedReactionCount += 1;
    };
    this._handleEnemyDied = (payload = {}) => {
      if (!this._squadId || payload.squadId !== this._squadId) return;
      if (payload.cause === 'player_collision') {
        this._squadStats.collisionDeathCount += 1;
      }
    };
    scene.events?.on?.(EVENTS.PLAYER_HIT, this._handlePlayerHit);
    scene.events?.on?.(EVENTS.ENEMY_DIED, this._handleEnemyDied);

    ships.forEach((ship, index) => {
      const data = {
        ship,
        dead: false,
        roleSeed: index,
        homeX: ship?.x ?? WIDTH / 2,
        homeY: ship?.y ?? HEIGHT * 0.3,
        role: resolveStableRole(index, ships.length),
        anchor: { x: ship?.x ?? WIDTH / 2, y: ship?.y ?? HEIGHT * 0.3 },
      };
      this._fleet.push(data);
      ship.onFormationStart?.(this);

      const origOnDeath = ship.onDeath.bind(ship);
      ship.onDeath = (opts) => {
        origOnDeath(opts);
        data.dead = true;
        data.ship?.clearSquadDoctrineState?.();
      };
    });

    this._setObjectivePhase('entry', this._createNeutralSquadDirective(), this._getPlayerSnapshot());
    this._refreshWingDoctrine();
    this._scheduleNextVolley();
    this._replanTimer = this._scene.time.addEvent?.({
      delay: Math.max(80, Math.round(this._behavior.replanMs)),
      callback: () => this._refreshWingDoctrine(),
      callbackScope: this,
      loop: true,
    }) ?? null;
  }

  _getNow() {
    return this._scene?.time?.now ?? Date.now();
  }

  getBehaviorMetrics() {
    return {
      ...this._behaviorMetrics,
      objective: this._objectiveState ? { ...this._objectiveState } : null,
    };
  }

  getBehaviorSnapshot() {
    return {
      objective: this._objectiveState ? { ...this._objectiveState } : null,
      directive: this._squadDirective ? { ...this._squadDirective } : null,
      metrics: this.getBehaviorMetrics(),
    };
  }

  _createNeutralSquadDirective() {
    return {
      predictions: {
        win: 0.5,
        pressure: 0.5,
        collision: 0.5,
      },
      doctrine: 'suppress',
      cadenceModifier: 1,
      focusX: WIDTH / 2,
      focusPull: 0.32,
      flankOffsetPx: 72,
      aggression: 0.5,
      caution: 0.5,
      idlePattern: this._behavior.pattern,
      volleySizeBonus: 0,
    };
  }

  _getPlayerSnapshot() {
    return this._services?.player?.getSnapshot?.() ?? {
      x: WIDTH / 2,
      y: HEIGHT - 80,
      hasShield: false,
      shieldRatio: 0,
      hpRatio: 1,
    };
  }

  _getLiveFleet() {
    return this._fleet.filter(data => !data.dead && data.ship?.active && data.ship?.alive !== false);
  }

  _isVisibleData(data) {
    return Boolean(
      data?.ship?.active
      && (data.ship?.x ?? 0) >= -24
      && (data.ship?.x ?? 0) <= WIDTH + 24
      && (data.ship?.y ?? -1) >= 0
      && (data.ship?.y ?? HEIGHT + 1) <= HEIGHT + 48
    );
  }

  _resolveShipRole(data, source = this._getLiveFleet()) {
    if (!Array.isArray(source) || source.length <= 0) {
      return { side: 'center', rank: 0, count: 1 };
    }

    const ordered = [...source].sort((left, right) => (
      (left.roleSeed ?? 0) - (right.roleSeed ?? 0)
    ));
    const index = Math.max(0, ordered.indexOf(data));
    return resolveStableRole(index, ordered.length);
  }

  _resolveDoctrineSpeedScalar(ship, directive) {
    const minSpeed = ship?.adaptiveProfile?.minSpeedScalar ?? 1;
    const maxSpeed = ship?.adaptiveProfile?.maxSpeedScalar ?? 1;
    const aggression = directive?.aggression ?? 0.5;
    const caution = directive?.caution ?? 0.5;
    const phase = this._objectiveState?.phase ?? 'entry';
    const doctrineBias = ({
      collapse: 0.10,
      encircle: 0.08,
      crossfire: 0.07,
      feint: 0.03,
      scatter: -0.02,
      suppress: 0.05,
    })[directive?.doctrine] ?? 0;
    const phaseBias = ({
      entry: 0,
      commit: 0.08,
      attack: 0.12,
      recover: -0.02,
    })[phase] ?? 0;
    return clamp(0.96 + aggression * 0.14 - caution * 0.06 + doctrineBias + phaseBias, minSpeed, maxSpeed);
  }

  _resolvePressureLineY(player, directive = this._squadDirective ?? this._createNeutralSquadDirective()) {
    const focusY = player?.y ?? HEIGHT - 80;
    const leadDistancePx = Math.max(
      88,
      directive?.leadDistancePx
      ?? this._behavior.leadDistancePx
      ?? this._behavior.pressureLeadPx
      ?? 148
    );
    return clamp(focusY - leadDistancePx, 64, HEIGHT - 112);
  }

  _setObjectivePhase(phase, directive = this._squadDirective ?? this._createNeutralSquadDirective(), player = this._getPlayerSnapshot()) {
    const now = this._getNow();
    const durationMs = ({
      entry: Number.POSITIVE_INFINITY,
      commit: this._behavior.commitMs,
      attack: this._behavior.attackMs,
      recover: this._behavior.recoverMs,
    })[phase] ?? this._behavior.commitMs;
    const pressureLineY = this._resolvePressureLineY(player, directive);

    this._objectiveState = {
      phase,
      doctrine: directive?.doctrine ?? 'suppress',
      focusX: clamp(directive?.focusX ?? player?.x ?? WIDTH / 2, 24, WIDTH - 24),
      flankOffsetPx: Math.max(36, directive?.flankOffsetPx ?? 72),
      aggression: directive?.aggression ?? 0.5,
      caution: directive?.caution ?? 0.5,
      pressureLineY,
      startedAt: now,
      expiresAt: Number.isFinite(durationMs) ? now + durationMs : Number.POSITIVE_INFINITY,
      playerStartX: player?.x ?? WIDTH / 2,
      playerStartY: player?.y ?? HEIGHT - 80,
      reactionCounted: false,
    };

    if (phase === 'commit' && this._behaviorMetrics.entryCompleteAt === null) {
      this._behaviorMetrics.entryCompleteAt = now;
    }

    if (phase === 'commit' || phase === 'attack') {
      this._fireNext();
      this._scheduleNextVolley();
    }
  }

  _hasPressureCommit(liveFleet, objective = this._objectiveState) {
    if (!objective) return false;
    const thresholdY = objective.pressureLineY - 14;
    return liveFleet.some(data => (data.ship?.y ?? 0) >= thresholdY);
  }

  _hasBracket(liveFleet, objective = this._objectiveState) {
    if (!objective) return false;
    const tolerance = this._behavior.bracketTolerancePx ?? 28;
    const left = liveFleet.some((data) => (
      (data.ship?.x ?? WIDTH / 2) <= objective.focusX - tolerance
      && (data.ship?.y ?? 0) >= objective.pressureLineY - 28
    ));
    const right = liveFleet.some((data) => (
      (data.ship?.x ?? WIDTH / 2) >= objective.focusX + tolerance
      && (data.ship?.y ?? 0) >= objective.pressureLineY - 28
    ));
    return left && right;
  }

  _hasLanePin(liveFleet, objective = this._objectiveState) {
    if (!objective) return false;
    const tolerance = this._behavior.laneTolerancePx ?? 44;
    return liveFleet.some((data) => (
      Math.abs((data.ship?.x ?? WIDTH / 2) - objective.focusX) <= tolerance
      && (data.ship?.y ?? 0) >= objective.pressureLineY - 20
    ));
  }

  _isObjectiveGeometryReady(liveFleet, player = this._getPlayerSnapshot()) {
    const objective = this._objectiveState;
    if (!objective) return false;
    if (liveFleet.length === 0) return false;

    const focusX = clamp(player?.x ?? objective.focusX ?? WIDTH / 2, 24, WIDTH - 24);
    const dynamicObjective = { ...objective, focusX };
    const hasPressure = this._hasPressureCommit(liveFleet, dynamicObjective);
    if (!hasPressure) return false;

    switch (objective.doctrine) {
      case 'crossfire':
      case 'encircle':
        return this._hasBracket(liveFleet, dynamicObjective);
      case 'collapse':
      case 'suppress':
      case 'feint':
      default:
        return this._hasLanePin(liveFleet, dynamicObjective);
    }
  }

  _updateBehaviorMetrics(liveFleet, player) {
    const now = this._getNow();
    const metrics = this._behaviorMetrics;
    const dt = Math.max(0, now - (metrics.lastTickAt ?? now));
    metrics.lastTickAt = now;

    if (metrics.firstVisibleAt === null && liveFleet.some(data => this._isVisibleData(data))) {
      metrics.firstVisibleAt = now;
    }

    const objective = this._objectiveState;
    if (!objective) return;

    const hasPressure = this._hasPressureCommit(liveFleet, objective);
    const hasBracket = this._hasBracket(liveFleet, objective);
    if (hasPressure && metrics.entryCompleteAt !== null && metrics.timeToCommitMs === null) {
      metrics.timeToCommitMs = Math.max(0, now - metrics.entryCompleteAt);
    }
    if (hasPressure) metrics.pressureOccupancyMs += dt;
    if (hasBracket) metrics.bracketMs += dt;
    if (liveFleet.some(data => this._isVisibleData(data)) && objective.phase !== 'entry' && !hasPressure && !hasBracket) {
      metrics.deadAirMs += dt;
    }

    const displacement = Math.abs((player?.x ?? objective.playerStartX ?? WIDTH / 2) - (objective.playerStartX ?? WIDTH / 2));
    metrics.playerDisplacementPxMax = Math.max(metrics.playerDisplacementPxMax, displacement);
    if (!objective.reactionCounted && displacement >= (this._behavior.reactionDistancePx ?? 60)) {
      objective.reactionCounted = true;
      metrics.forcedReactionCount += 1;
    }
  }

  _advanceObjectiveState(liveFleet, player) {
    const objective = this._objectiveState;
    const now = this._getNow();
    const allReady = liveFleet.length > 0 && liveFleet.every((data) => (
      data.ship?.isAdaptiveBehaviorReady?.() === true
      || data.ship?.canUseAdaptiveBehavior?.() === true
    ));

    if (!objective || objective.phase === 'entry') {
      if (allReady) {
        this._setObjectivePhase('commit', this._squadDirective, player);
      }
      return;
    }

    if (objective.phase === 'commit') {
      if (this._isObjectiveGeometryReady(liveFleet, player) || now >= objective.expiresAt) {
        this._setObjectivePhase('attack', this._squadDirective, player);
      }
      return;
    }

    if (objective.phase === 'attack') {
      if (now >= objective.expiresAt) {
        this._setObjectivePhase('recover', this._squadDirective, player);
      }
      return;
    }

    if (objective.phase === 'recover' && now >= objective.expiresAt) {
      this._setObjectivePhase('commit', this._squadDirective, player);
    }
  }

  _resolveRoleOffsetX(role, spread = 34) {
    if (!role || role.count <= 1) return 0;
    const center = (role.count - 1) / 2;
    return (role.rank - center) * spread;
  }

  _resolveWingAnchor(data, directive, player) {
    const objective = this._objectiveState ?? {
      phase: 'entry',
      doctrine: directive?.doctrine ?? 'suppress',
      focusX: directive?.focusX ?? player?.x ?? WIDTH / 2,
      flankOffsetPx: directive?.flankOffsetPx ?? 72,
      pressureLineY: this._resolvePressureLineY(player, directive),
    };
    const role = data.role ?? { side: 'center', rank: 0, count: 1 };
    const focusX = clamp(objective.focusX ?? player?.x ?? WIDTH / 2, 24, WIDTH - 24);
    const flankOffsetPx = Math.max(36, objective.flankOffsetPx ?? 72);
    const roleOffsetX = this._resolveRoleOffsetX(role, 30);
    const commitY = clamp(objective.pressureLineY - 10, 54, HEIGHT - 118);
    const attackY = clamp(objective.pressureLineY + (this._behavior.attackDepthBonusPx ?? 18), 54, HEIGHT - 102);
    const recoverY = clamp(objective.pressureLineY - (this._behavior.recoverLiftPx ?? 62), 54, HEIGHT - 132);
    let targetX = data.homeX ?? data.ship?.x ?? WIDTH / 2;
    let targetY = data.homeY ?? data.ship?.y ?? HEIGHT * 0.3;

    if (objective.phase === 'entry') {
      return {
        x: clamp(targetX, 24, WIDTH - 24),
        y: clamp(targetY, 40, HEIGHT - 120),
      };
    }

    const doctrine = objective.doctrine ?? directive?.doctrine ?? 'suppress';
    const isAttackPhase = objective.phase === 'attack';
    const depthY = isAttackPhase ? attackY : commitY;

    switch (doctrine) {
      case 'collapse':
        targetX = focusX + (role.side === 'left' ? -24 : role.side === 'right' ? 24 : roleOffsetX * 0.45);
        targetY = depthY + 10;
        break;
      case 'crossfire':
        if (role.side === 'left') targetX = focusX - flankOffsetPx;
        else if (role.side === 'right') targetX = focusX + flankOffsetPx;
        else targetX = focusX + roleOffsetX * 0.35;
        targetY = depthY + (role.side === 'center' ? 10 : 0);
        break;
      case 'encircle':
        if (role.side === 'left') targetX = focusX - (flankOffsetPx + 18);
        else if (role.side === 'right') targetX = focusX + (flankOffsetPx + 18);
        else targetX = focusX;
        targetY = depthY + (role.side === 'center' ? 16 : -2);
        break;
      case 'feint':
        targetX = focusX + roleOffsetX * 0.55;
        targetY = isAttackPhase ? depthY + 6 : commitY - 20;
        break;
      case 'scatter':
        targetX = focusX + (role.side === 'left' ? -flankOffsetPx * 1.15 : role.side === 'right' ? flankOffsetPx * 1.15 : roleOffsetX);
        targetY = objective.phase === 'recover' ? recoverY : commitY - 12;
        break;
      case 'suppress':
      default:
        targetX = focusX + roleOffsetX * 0.8;
        targetY = depthY;
        break;
    }

    if (objective.phase === 'recover') {
      targetY = recoverY;
      targetX = clamp(targetX + roleOffsetX * 0.35, 24, WIDTH - 24);
    }

    return {
      x: clamp(targetX, 24, WIDTH - 24),
      y: clamp(targetY, 40, HEIGHT - 102),
    };
  }

  _resolveAnchorWeight() {
    const phase = this._objectiveState?.phase ?? 'entry';
    return clamp(({
      entry: 0.40,
      commit: 0.88,
      attack: 0.98,
      recover: 0.70,
    })[phase] ?? 0.52, this._behavior.anchorWeightFloor ?? 0.28, this._behavior.anchorWeightCeil ?? 0.82);
  }

  _resolveAnchorRanges(anchor, data) {
    const dx = Math.abs((anchor?.x ?? data.homeX ?? WIDTH / 2) - (data.ship?.x ?? data.homeX ?? WIDTH / 2));
    const dy = Math.abs((anchor?.y ?? data.homeY ?? HEIGHT * 0.3) - (data.ship?.y ?? data.homeY ?? HEIGHT * 0.3));
    const phase = this._objectiveState?.phase ?? 'entry';
    const xBonus = phase === 'attack' ? 16 : phase === 'commit' ? 28 : 46;
    const yBonus = phase === 'attack' ? 12 : phase === 'commit' ? 20 : 36;
    return {
      rangePx: clamp(dx * 0.55 + xBonus, this._behavior.rangeFloorPx ?? 44, this._behavior.rangeCeilPx ?? 160),
      yRangePx: clamp(dy * 0.55 + yBonus, this._behavior.yRangeFloorPx ?? 34, this._behavior.yRangeCeilPx ?? 132),
    };
  }

  _refreshWingDoctrine() {
    const liveFleet = this._getLiveFleet();
    if (liveFleet.length === 0) {
      this._squadDirective = this._createNeutralSquadDirective();
      return this._squadDirective;
    }

    const liveShips = liveFleet.map(data => data.ship);
    const latestDirective = this._services?.adaptive?.evaluateSquadDirective?.({
      phase: 'idle',
      squadId: this._squadId,
      squadTemplateId: this._squadTemplateId,
      formation: this._formation,
      dance: this._dance,
      overlay: this._overlay,
      primaryEnemyType: this._primaryEnemyType,
      liveEnemies: liveShips,
      stats: this._squadStats,
    }) ?? this._createNeutralSquadDirective();
    const player = this._getPlayerSnapshot();

    this._squadDirective = {
      ...this._createNeutralSquadDirective(),
      ...latestDirective,
    };

    this._advanceObjectiveState(liveFleet, player);
    this._updateBehaviorMetrics(liveFleet, player);

    liveFleet.forEach((data) => {
      data.role = this._resolveShipRole(data, liveFleet);
      data.anchor = this._resolveWingAnchor(data, this._squadDirective, player);
      const anchorWeight = this._resolveAnchorWeight();
      const { rangePx, yRangePx } = this._resolveAnchorRanges(data.anchor, data);

      data.ship?.setSquadDoctrineState?.({
        active: true,
        doctrine: this._objectiveState?.doctrine ?? this._squadDirective.doctrine,
        phase: this._objectiveState?.phase ?? 'entry',
        role: data.role,
        anchorX: data.anchor.x,
        anchorY: data.anchor.y,
        anchorWeight,
        rangePx,
        yRangePx,
        speedScalar: this._resolveDoctrineSpeedScalar(data.ship, this._squadDirective),
        focusX: this._objectiveState?.focusX ?? this._squadDirective.focusX,
        focusPull: 1,
        flankOffsetPx: this._objectiveState?.flankOffsetPx ?? this._squadDirective.flankOffsetPx,
        aggression: this._objectiveState?.aggression ?? this._squadDirective.aggression,
        caution: this._objectiveState?.caution ?? this._squadDirective.caution,
      });
    });

    return this._squadDirective;
  }

  _isShipReadyToFire(data) {
    const fireRate = Math.max(0, data?.ship?.fireRate ?? 0);
    if (fireRate <= 0) return false;
    return (data?.ship?.getFormationFireCooldown?.() ?? 0) >= fireRate;
  }

  _scoreShipForDirective(data, ready, options = {}) {
    const player = this._getPlayerSnapshot();
    const focusX = clamp(this._objectiveState?.focusX ?? this._squadDirective?.focusX ?? player.x ?? WIDTH / 2, 24, WIDTH - 24);
    const role = this._resolveShipRole(data, ready);
    const dx = focusX - (data.ship?.x ?? 0);
    const dy = (player.y ?? HEIGHT) - (data.ship?.y ?? 0);
    const alignment = resolveShotAlignment(
      data.ship?.enemyType ?? this._primaryEnemyType ?? 'skirm',
      dx,
      dy
    );
    const laneScore = 1 - clamp(Math.abs(dx) / Math.max(1, WIDTH * 0.55), 0, 1);
    const outerScore = role.side === 'center'
      ? 0
      : clamp(Math.abs((data.ship?.x ?? WIDTH / 2) - WIDTH / 2) / Math.max(1, WIDTH * 0.5), 0, 1);
    const depthScore = clamp((data.ship?.y ?? 0) / Math.max(1, HEIGHT), 0, 1);
    const sideBonus = options.side && role.side === options.side ? 0.28 : 0;

    return (
      alignment * (options.alignmentWeight ?? 0.56)
      + laneScore * (options.laneWeight ?? 0.28)
      + outerScore * (options.outerWeight ?? 0)
      + depthScore * (options.depthWeight ?? 0)
      + sideBonus
    );
  }

  _rankReadyShips(ready, options = {}) {
    return [...ready].sort((left, right) => (
      this._scoreShipForDirective(right, ready, options) - this._scoreShipForDirective(left, ready, options)
    ));
  }

  _takeUniqueRanked(ranked, selected, count) {
    for (const candidate of ranked) {
      if (selected.length >= count) break;
      if (selected.includes(candidate)) continue;
      selected.push(candidate);
    }
  }

  _selectSweepVolley(ready, volleySize) {
    const volley = [];
    for (let tries = 0; tries < ready.length && volley.length < volleySize; tries += 1) {
      const index = (this._shootIdx + tries) % ready.length;
      volley.push(ready[index]);
    }
    this._shootIdx = (this._shootIdx + volley.length) % Math.max(1, ready.length);
    return volley;
  }

  _selectFocusLaneVolley(ready, volleySize) {
    return this._rankReadyShips(ready, {
      alignmentWeight: 0.58,
      laneWeight: 0.34,
      depthWeight: 0.12,
    }).slice(0, volleySize);
  }

  _selectCollapseVolley(ready, volleySize) {
    return this._rankReadyShips(ready, {
      alignmentWeight: 0.54,
      laneWeight: 0.32,
      depthWeight: 0.24,
    }).slice(0, volleySize);
  }

  _selectCrossfireVolley(ready, volleySize) {
    const selected = [];
    const left = this._rankReadyShips(
      ready.filter(data => this._resolveShipRole(data, ready).side === 'left'),
      { alignmentWeight: 0.44, laneWeight: 0.20, outerWeight: 0.32, side: 'left' }
    );
    const right = this._rankReadyShips(
      ready.filter(data => this._resolveShipRole(data, ready).side === 'right'),
      { alignmentWeight: 0.44, laneWeight: 0.20, outerWeight: 0.32, side: 'right' }
    );
    const orderedSides = (this._wingShotCursor % 2) === 0 ? [left, right] : [right, left];
    while (selected.length < volleySize && (left.length > 0 || right.length > 0)) {
      for (const sideList of orderedSides) {
        this._takeUniqueRanked(sideList, selected, selected.length + 1);
        if (selected.length >= volleySize) break;
      }
      if (orderedSides.every(sideList => sideList.every(candidate => selected.includes(candidate)))) break;
    }
    this._wingShotCursor = (this._wingShotCursor + selected.length) % Math.max(1, ready.length);
    return selected.length > 0 ? selected : this._selectFocusLaneVolley(ready, volleySize);
  }

  _selectEncircleVolley(ready, volleySize) {
    const selected = [];
    const left = this._rankReadyShips(
      ready.filter(data => this._resolveShipRole(data, ready).side === 'left'),
      { alignmentWeight: 0.38, laneWeight: 0.24, outerWeight: 0.34, side: 'left' }
    );
    const right = this._rankReadyShips(
      ready.filter(data => this._resolveShipRole(data, ready).side === 'right'),
      { alignmentWeight: 0.38, laneWeight: 0.24, outerWeight: 0.34, side: 'right' }
    );
    const center = this._rankReadyShips(
      ready.filter(data => this._resolveShipRole(data, ready).side === 'center'),
      { alignmentWeight: 0.52, laneWeight: 0.30, depthWeight: 0.10 }
    );
    this._takeUniqueRanked(left, selected, 1);
    this._takeUniqueRanked(right, selected, Math.min(2, volleySize));
    this._takeUniqueRanked(center, selected, volleySize);
    this._takeUniqueRanked(this._rankReadyShips(ready), selected, volleySize);
    return selected.slice(0, volleySize);
  }

  _selectStaggerPinVolley(ready, volleySize) {
    const targetSide = (this._rowShotCursor % 2) === 0 ? 'left' : 'right';
    this._rowShotCursor = (this._rowShotCursor + 1) % 2;
    const sideReady = ready.filter(data => this._resolveShipRole(data, ready).side === targetSide);
    if (sideReady.length === 0) return this._selectFocusLaneVolley(ready, volleySize);
    return this._rankReadyShips(sideReady, {
      alignmentWeight: 0.56,
      laneWeight: 0.30,
      depthWeight: 0.08,
      side: targetSide,
    }).slice(0, volleySize);
  }

  _selectVolleyCandidates(ready, cadence) {
    switch (cadence.pattern) {
      case 'crossfire':
        return this._selectCrossfireVolley(ready, cadence.volleySize);
      case 'encircle':
        return this._selectEncircleVolley(ready, cadence.volleySize);
      case 'collapse':
        return this._selectCollapseVolley(ready, cadence.volleySize);
      case 'stagger_pin':
        return this._selectStaggerPinVolley(ready, cadence.volleySize);
      case 'single':
        return this._selectSweepVolley(ready, 1);
      case 'focus_lane':
      default:
        return this._selectFocusLaneVolley(ready, cadence.volleySize);
    }
  }

  _resolveCadence() {
    const directive = this._squadDirective ?? this._createNeutralSquadDirective();
    return {
      rate: Math.max(
        0,
        (this._behavior.shootRate ?? 0)
        * clamp(directive.cadenceModifier ?? 1, 0.6, 1.5)
      ),
      volleySize: clamp(
        Math.round((this._behavior.volleySize ?? 2) + (directive.volleySizeBonus ?? 0)),
        1,
        4
      ),
      intraVolleyMs: this._behavior.intraVolleyMs ?? 110,
      pattern: directive.idlePattern ?? this._behavior.pattern ?? 'focus_lane',
    };
  }

  _scheduleNextVolley() {
    if (this._stopped) return;
    if (this._shootTimer) this._shootTimer.remove?.();

    const delay = this._resolveNextVolleyDelay();

    this._shootTimer = this._scene.time.delayedCall?.(
      delay,
      () => {
        if (this._stopped) return;
        this._fireNext();
        this._scheduleNextVolley();
      }
    ) ?? null;
  }

  _resolveSoonestReadyDelay(liveFleet = this._getLiveFleet()) {
    const delays = liveFleet
      .filter(data => this._isVisibleData(data))
      .map((data) => {
        const fireRate = Math.max(0, data?.ship?.fireRate ?? 0);
        if (fireRate <= 0) return null;
        const cooldown = Math.max(0, data?.ship?.getFormationFireCooldown?.() ?? 0);
        return Math.max(0, Math.round(fireRate - cooldown));
      })
      .filter(delay => Number.isFinite(delay));

    if (delays.length === 0) return null;
    return Math.min(...delays);
  }

  _resolveNextVolleyDelay() {
    const cadence = this._resolveCadence();
    const cadenceDelay = (cadence.rate ?? 0) > 0
      ? Math.max(1, Math.round(1000 / Math.max(0.01, cadence.rate)))
      : null;
    const liveFleet = this._getLiveFleet();
    const player = this._getPlayerSnapshot();
    const readyDelay = this._resolveSoonestReadyDelay(liveFleet);

    if (!this._canFireCurrentObjective(liveFleet, player)) {
      return Math.max(1, Math.round(this._behavior.replanMs ?? 180));
    }
    if (readyDelay === null && cadenceDelay === null) {
      return Math.max(1, Math.round(this._behavior.replanMs ?? 180));
    }
    if (readyDelay === null) return cadenceDelay;
    if (cadenceDelay === null) return Math.max(1, readyDelay);
    return Math.max(1, Math.min(readyDelay, cadenceDelay));
  }

  _canFireCurrentObjective(liveFleet, player) {
    const phase = this._objectiveState?.phase ?? 'entry';
    if (phase === 'commit') {
      return liveFleet.some(data => this._isVisibleData(data));
    }
    if (phase !== 'attack') return false;
    return this._isObjectiveGeometryReady(liveFleet, player);
  }

  _fireNext() {
    const liveFleet = this._getLiveFleet();
    if (liveFleet.length === 0) return;
    const player = this._getPlayerSnapshot();
    if (!this._canFireCurrentObjective(liveFleet, player)) return;

    const ready = liveFleet.filter((data) => (
      this._isVisibleData(data)
      && this._isShipReadyToFire(data)
      && (!data.ship?.shouldFireNow || data.ship.shouldFireNow() !== false)
    ));
    if (ready.length === 0) return;

    const cadence = this._resolveCadence();
    const volley = this._selectVolleyCandidates(ready, cadence);
    if (volley.length === 0) return;
    this._behaviorMetrics.coordinatedVolleyCount += 1;

    volley.forEach((data, index) => {
      this._scene.time.delayedCall?.(
        Math.max(0, Math.round(index * (cadence.intraVolleyMs ?? 110))),
        () => this._emitWingShot(data)
      );
    });
  }

  _emitWingShot(data) {
    if (!data || data.dead || !data.ship?.active || !this._isShipReadyToFire(data)) return;
    this._squadStats.shotCount += 1;
    data.ship.resetFormationFireCooldown?.();
    data.ship.fire?.();
  }

  stop() {
    this._stopped = true;
    this._shootTimer?.remove?.();
    this._shootTimer = null;
    this._replanTimer?.remove?.();
    this._replanTimer = null;
    for (const data of this._fleet) {
      data.ship?.clearSquadDoctrineState?.();
      data.ship?.onFormationEnd?.();
    }
    this._scene.events?.off?.(EVENTS.PLAYER_HIT, this._handlePlayerHit);
    this._scene.events?.off?.(EVENTS.ENEMY_DIED, this._handleEnemyDied);
  }
}
