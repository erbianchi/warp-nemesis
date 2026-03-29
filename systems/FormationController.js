/** @module FormationController
 * Drives configurable Skirm squadron formations.
 *
 * Behaviour:
 *   1. Formation ships launch from a visible top-side anchor.
 *   2. They sweep through a shared path, climb back to the top on the opposite side,
 *      and then peel off into formation slots.
 *   3. Idle phase blends smooth organic drift with abrupt jinks.
 *   4. After a configurable cycle, survivors rerun the pattern from the other side.
 *   5. Deaths reorganise living ships so the squadron never stalls.
 */

import { GAME_CONFIG } from '../config/game.config.js';
import { ENEMY_LEARNING_CONFIG } from '../config/enemyLearning.config.js';
import { EVENTS } from '../config/events.config.js';
import { resolveShotAlignment } from './ml/EnemyPolicyMath.js';
import { clamp } from '../utils/math.js';

const { WIDTH, HEIGHT } = GAME_CONFIG;

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

/**
 * Default controller behaviour for a formation squadron.
 * Returned as a fresh object so each controller instance owns its own config.
 * @returns {object}
 */
export function getDefaultFormationBehavior() {
  return {
    path: [
      { xPct: 0.50, yPct: 0.25, dur: 500 },
      { xPct: 0.17, yPct: 0.47, dur: 700 },
      { xPct: 0.14, yPct: 0.77, dur: 650 },
      { xPct: 0.46, yPct: 0.88, dur: 550 },
      { xPct: 0.83, yPct: 0.80, dur: 600 },
      { xPct: 0.94, yPct: 0.45, dur: 600 },
      { xPct: 0.67, yPct: 0.12, dur: 500 },
    ],
    mirrorPath: false,
    pathJitterX: 0,
    pathJitterY: 0,
    pathSpreadX: 0,
    speed: 1,
    launchStaggerMs: 200,
    cycleMs: 10000,
    shootRate: 2,
    pathShootRate: 1.35,
    shotCadence: {
      pathPattern: 'single',
      idlePattern: 'alternating_rows',
      pathVolleySize: 1,
      idleVolleySize: 2,
      intraVolleyMs: 120,
      modifier: 1,
      pathModifier: 1,
      idleModifier: 1,
    },
    slotSpacingX: 60,
    rowYs: [65, 110],
    exitToSlotMs: 380,
    reformMs: 350,
    alternateSides: true,
    sideMarginX: 52,
    sideTopY: 54,
    sideLaneSpreadX: 22,
    returnTopY: 58,
    returnToSideMs: 360,
    driftX: 30,
    driftY: 5,
    organicDurationMinMs: 120,
    organicDurationMaxMs: 220,
    organicPauseMinMs: 80,
    organicPauseMaxMs: 260,
    abruptChance: 0.35,
    abruptOffsetX: 42,
    abruptOffsetY: 10,
    abruptDurationMinMs: 70,
    abruptDurationMaxMs: 130,
    abruptPauseMinMs: 45,
    abruptPauseMaxMs: 110,
  };
}

/**
 * Merge squadron-specific controller config with defaults.
 * `mirrorPath: "random"` resolves once per controller to keep the squadron cohesive.
 *
 * @param {object} [controller={}]
 * @param {Function} [rng=Math.random]
 * @returns {object}
 */
export function resolveFormationBehavior(controller = {}, rng = Math.random) {
  const defaults = getDefaultFormationBehavior();
  const behavior = {
    ...defaults,
    ...controller,
    shotCadence: {
      ...(defaults.shotCadence ?? {}),
      ...(controller.shotCadence ?? {}),
    },
    path: (controller.path ?? defaults.path).map(step => ({ ...step })),
    rowYs: [...(controller.rowYs ?? defaults.rowYs)],
  };

  behavior.mirrorPath = controller.mirrorPath === 'random'
    ? rng() < 0.5
    : Boolean(controller.mirrorPath ?? defaults.mirrorPath);

  return behavior;
}

/**
 * Compute centred formation slots for N ships.
 * Ships are distributed as evenly as possible across the configured rows.
 *
 * @param {number} count
 * @param {{slotSpacingX?: number, rowYs?: number[]}} [options={}]
 * @returns {Array<{x: number, y: number}>}
 */
export function calcFormationSlots(count, options = {}) {
  if (count <= 0) return [];

  const defaults = getDefaultFormationBehavior();
  const slotSpacingX = options.slotSpacingX ?? defaults.slotSpacingX;
  const rowYs = [...(options.rowYs ?? defaults.rowYs)];
  const slots = [];

  let remaining = count;
  let rowsLeft = Math.min(rowYs.length, count);

  for (const y of rowYs) {
    if (remaining <= 0) break;
    const rowCount = Math.ceil(remaining / rowsLeft);
    const startX = (WIDTH - (rowCount - 1) * slotSpacingX) / 2;

    for (let col = 0; col < rowCount; col++) {
      slots.push({ x: startX + col * slotSpacingX, y });
    }

    remaining -= rowCount;
    rowsLeft--;
  }

  return slots;
}

/**
 * Resolve one path step into world coordinates.
 * Supports either absolute pixels (`x`, `y`) or percentages (`xPct`, `yPct`).
 *
 * @param {object} step
 * @param {number} laneOffsetX
 * @param {object} behavior
 * @param {Function} rng
 * @returns {{x: number, y: number, dur: number, ease: string}}
 */
export function resolveFormationStep(step, laneOffsetX, behavior, rng = Math.random) {
  const baseX = typeof step.xPct === 'number' ? WIDTH * step.xPct : step.x;
  const baseY = typeof step.yPct === 'number' ? HEIGHT * step.yPct : step.y;
  const jitterX = step.jitterX ?? behavior.pathJitterX;
  const jitterY = step.jitterY ?? behavior.pathJitterY;

  let x = baseX + laneOffsetX + (rng() - 0.5) * 2 * jitterX;
  const y = baseY + (rng() - 0.5) * 2 * jitterY;

  if (behavior.mirrorPath) x = WIDTH - x;

  return {
    x,
    y,
    dur: Math.max(1, Math.round(step.dur / behavior.speed)),
    ease: step.ease ?? 'Sine.easeInOut',
  };
}

/**
 * Build a per-ship path from the squadron config.
 *
 * @param {object} behavior
 * @param {number} shipIndex
 * @param {number} shipCount
 * @param {boolean|Function} [mirrorPathOrRng=behavior.mirrorPath]
 * @param {Function} [rng=Math.random]
 * @returns {Array<{x: number, y: number, dur: number, ease: string}>}
 */
export function buildFormationPath(
  behavior,
  shipIndex,
  shipCount,
  mirrorPathOrRng = behavior.mirrorPath,
  rng = Math.random,
  speedMultiplier = 1
) {
  const pathMirror = typeof mirrorPathOrRng === 'boolean' ? mirrorPathOrRng : behavior.mirrorPath;
  const pathRng = typeof mirrorPathOrRng === 'function' ? mirrorPathOrRng : rng;
  const normalizedIndex = shipCount <= 1 ? 0 : shipIndex / (shipCount - 1) - 0.5;
  const laneOffsetX = normalizedIndex * (behavior.pathSpreadX ?? 0);
  const sideOffsetX = normalizedIndex * (behavior.sideLaneSpreadX ?? 0);
  const sideX = resolveSideAnchorX(behavior, sideOffsetX, pathMirror);
  const returnX = resolveSideAnchorX(behavior, sideOffsetX, !pathMirror);
  const pathBehavior = { ...behavior, mirrorPath: pathMirror };

  return [
    {
      x: sideX,
      y: behavior.sideTopY,
      dur: Math.max(1, Math.round(behavior.returnToSideMs / (behavior.speed * speedMultiplier))),
      ease: 'Sine.easeInOut',
    },
    ...behavior.path.map(step => {
      const resolved = resolveFormationStep(step, laneOffsetX, pathBehavior, pathRng);
      return {
        ...resolved,
        dur: Math.max(1, Math.round(resolved.dur / speedMultiplier)),
      };
    }),
    {
      x: returnX,
      y: behavior.returnTopY,
      dur: Math.max(1, Math.round(behavior.returnToSideMs / (behavior.speed * speedMultiplier))),
      ease: 'Sine.easeInOut',
    },
  ];
}

/**
 * Resolve the side anchor for a given orientation.
 *
 * @param {object} behavior
 * @param {number} sideOffsetX
 * @param {boolean} mirrorPath
 * @returns {number}
 */
export function resolveSideAnchorX(behavior, sideOffsetX, mirrorPath) {
  const x = mirrorPath
    ? WIDTH - (behavior.sideMarginX + sideOffsetX)
    : behavior.sideMarginX + sideOffsetX;

  return Phaser.Math.Clamp?.(x, 24, WIDTH - 24) ?? Math.min(Math.max(x, 24), WIDTH - 24);
}

function resolveAdaptiveSlot(ship, slot, behavior) {
  const resolver = ship?.resolveDoctrineMovePlan ?? ship?.resolveAdaptiveMovePlan;
  if (!resolver) return { ...slot, speedScalar: 1 };
  return resolver.call(ship, slot.x, {
    candidateY: slot.y,
    rangePx: Math.max(32, (behavior.slotSpacingX ?? 60) * 0.7),
    yRangePx: Math.max(20, ((behavior.rowYs?.[1] ?? slot.y + 36) - slot.y) * 0.8),
    marginPx: 24,
    topMarginPx: 24,
    bottomMarginPx: HEIGHT - 96,
    commit: false,
  });
}

function applyAdaptivePath(ship, path, behavior, speedScalar = 1) {
  return path.map(step => ({ ...step }));
}

function resolveIdlePlan(ship, x, y, rangePx, yRangePx) {
  return ship.resolveDoctrineMovePlan?.(x, {
    candidateY: y,
    rangePx,
    yRangePx,
    marginPx: 24,
    topMarginPx: 24,
    bottomMarginPx: HEIGHT - 96,
    commit: false,
  }) ?? ship.resolveAdaptiveMovePlan?.(x, {
    candidateY: y,
    rangePx,
    yRangePx,
    marginPx: 24,
    topMarginPx: 24,
    bottomMarginPx: HEIGHT - 96,
    commit: false,
  }) ?? { x, y };
}

export class FormationController {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../entities/EnemyBase.js').IFormationMember[]} ships - Formation ships already spawned in the scene
   * @param {object} [controller={}] - Squadron-specific formation behaviour
   * @param {Function} [rng=Math.random]
   * @param {object|null} [services=scene?._services ?? null]
   */
  constructor(scene, ships, controller = {}, rng = Math.random, services = scene?._services ?? null) {
    this._scene = scene;
    this._services = services;
    this._rng = rng;
    this._behavior = resolveFormationBehavior(controller, rng);
    const firstMeta = ships[0]?.getFormationMeta?.() ?? {};
    this._squadId = firstMeta.squadId ?? null;
    this._squadTemplateId = firstMeta.squadTemplateId ?? null;
    this._formation = firstMeta.formation ?? controller.formation ?? null;
    this._dance = controller.dance ?? firstMeta.dance ?? ships[0]?.dance ?? null;
    this._overlay = Boolean(controller.overlay ?? firstMeta.overlay);
    this._primaryEnemyType = ships[0]?.enemyType ?? null;
    this._squadDirective = null;
    this._squadStats = {
      spawnCount: ships.length,
      shotCount: 0,
      playerHitCount: 0,
      hpDamageToPlayer: 0,
      shieldDamageToPlayer: 0,
      collisionDeathCount: 0,
    };
    this._pathMirror = controller.mirrorPath === undefined
      ? this._rng() < 0.5
      : this._behavior.mirrorPath;
    this._fleet = [];
    this._landed = 0;
    this._shootIdx = 0;
    this._rowShotCursor = 0;
    this._wingShotCursor = 0;
    this._shootTimer = null;
    this._shootLoop = null;
    this._cycleTimer = null;
    this._inIdle = false;
    this._assaultState = null;
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

    const pathBehavior = this._getEffectiveBehavior('path');
    const slots = calcFormationSlots(ships.length, pathBehavior);

    ships.forEach((ship, i) => {
      const movementSpeedMultiplier = ship.getFormationMovementSpeedMultiplier?.() ?? 1;
      const requestedMovementSpeed = pathBehavior.speed * movementSpeedMultiplier;
      const slotPlan = resolveAdaptiveSlot(
        ship,
        slots[i] ?? { x: WIDTH / 2, y: pathBehavior.rowYs[0] ?? 65 },
        pathBehavior
      );
      const requestedDurationScale = requestedMovementSpeed * (slotPlan.speedScalar ?? 1);
      const resolvedDurationScale = ship.resolveMovementDurationScale?.(requestedDurationScale) ?? requestedDurationScale;
      const effectiveShipSpeedMultiplier = resolvedDurationScale / Math.max(0.01, pathBehavior.speed);
      const data = {
        ship,
        slot: { x: slotPlan.x, y: slotPlan.y },
        rowIndex: this._resolveRowIndex(slotPlan.y, pathBehavior),
        speed: resolvedDurationScale,
        drifting: false,
        dead: false,
        landed: false,
        adaptiveUnlocked: false,
        motionStyle: this._pickMotionStyle(),
        path: applyAdaptivePath(
          ship,
          buildFormationPath(
            pathBehavior,
            i,
            ships.length,
            this._pathMirror,
            this._rng,
            effectiveShipSpeedMultiplier
          ),
          pathBehavior,
          slotPlan.speedScalar ?? 1
        ),
      };
      this._fleet.push(data);

      const launchAnchor = data.path[0];
      ship.onFormationStart?.(this, launchAnchor);

      const origOnDeath = ship.onDeath.bind(ship);
      ship.onDeath = (opts) => {
        origOnDeath(opts);
        data.dead = true;
        data.drifting = false;
        scene.tweens.killTweensOf(ship);
        if (this._inIdle) {
          this._reorganize();
        } else if (!data.landed) {
          this._onLanded();
        }
      };
    });

    this._refreshSquadDirective('path');
    this._applyDirectiveToFlightPlan('path');
    this._startMovementFire();
    this._fleet.forEach((data, i) => {
      scene.time.delayedCall(
        Math.max(1, Math.round((i * pathBehavior.launchStaggerMs) / (data.speed || 1))),
        () => this._runPath(data, 1)
      );
    });
  }

  _getNow() {
    return this._scene?.time?.now ?? Date.now();
  }

  _getAssaultConfig() {
    return ENEMY_LEARNING_CONFIG.squadRuntimePolicy?.formationAssault ?? {};
  }

  getBehaviorMetrics() {
    return {
      ...this._behaviorMetrics,
      assault: this._assaultState ? { ...this._assaultState } : null,
    };
  }

  getBehaviorSnapshot() {
    return {
      directive: this._squadDirective ? { ...this._squadDirective } : null,
      assault: this._assaultState ? { ...this._assaultState } : null,
      metrics: this.getBehaviorMetrics(),
    };
  }

  _setAssaultPhase(phase) {
    const cfg = this._getAssaultConfig();
    const now = this._getNow();
    const player = this._getPlayerSnapshot();
    const durationMs = ({
      commit: cfg.commitMs ?? 760,
      attack: cfg.attackMs ?? 1280,
      recover: cfg.recoverMs ?? 620,
    })[phase] ?? (cfg.commitMs ?? 760);
    const liveFleet = this._fleet.filter(data => !data.dead && data.ship?.active);
    const frontRow = Math.max(...liveFleet.map(data => data.rowIndex ?? 0), 0);
    const pressureLeadPx = cfg.pressureLeadPx ?? 178;
    const pressureLineY = clamp((player?.y ?? HEIGHT - 80) - pressureLeadPx, 72, HEIGHT - 136);

    this._assaultState = {
      phase,
      doctrine: this._squadDirective?.doctrine ?? 'suppress',
      focusX: clamp(this._squadDirective?.focusX ?? player?.x ?? WIDTH / 2, 24, WIDTH - 24),
      flankOffsetPx: Math.max(40, this._squadDirective?.flankOffsetPx ?? 72),
      aggression: this._squadDirective?.aggression ?? 0.5,
      caution: this._squadDirective?.caution ?? 0.5,
      pressureLineY,
      frontRow,
      startedAt: now,
      expiresAt: now + durationMs,
      playerStartX: player?.x ?? WIDTH / 2,
      playerStartY: player?.y ?? HEIGHT - 80,
      reactionCounted: false,
    };

    if (phase === 'commit' && this._behaviorMetrics.entryCompleteAt === null) {
      this._behaviorMetrics.entryCompleteAt = now;
    }

    if (phase === 'commit' || phase === 'attack') {
      this._fireNext();
      this._scheduleShootLoop();
    }
  }

  _hasFormationPressureCommit(liveFleet, assault = this._assaultState) {
    if (!assault) return false;
    return liveFleet.some((data) => (
      (data.ship?.y ?? 0) >= assault.pressureLineY - 16
    ));
  }

  _hasFormationBracket(liveFleet, assault = this._assaultState) {
    if (!assault) return false;
    const tolerance = this._getAssaultConfig().bracketTolerancePx ?? 28;
    const left = liveFleet.some((data) => (
      (data.ship?.x ?? WIDTH / 2) <= assault.focusX - tolerance
      && (data.ship?.y ?? 0) >= assault.pressureLineY - 24
    ));
    const right = liveFleet.some((data) => (
      (data.ship?.x ?? WIDTH / 2) >= assault.focusX + tolerance
      && (data.ship?.y ?? 0) >= assault.pressureLineY - 24
    ));
    return left && right;
  }

  _hasFormationLanePin(liveFleet, assault = this._assaultState) {
    if (!assault) return false;
    const tolerance = this._getAssaultConfig().laneTolerancePx ?? 44;
    return liveFleet.some((data) => (
      Math.abs((data.ship?.x ?? WIDTH / 2) - assault.focusX) <= tolerance
      && (data.ship?.y ?? 0) >= assault.pressureLineY - 22
    ));
  }

  _isFormationAttackGeometryReady(liveFleet) {
    const assault = this._assaultState;
    if (!assault) return false;
    if (!this._hasFormationPressureCommit(liveFleet, assault)) return false;

    switch (assault.doctrine) {
      case 'crossfire':
      case 'encircle':
        return this._hasFormationBracket(liveFleet, assault);
      case 'collapse':
      case 'suppress':
      case 'feint':
      default:
        return this._hasFormationLanePin(liveFleet, assault);
    }
  }

  _advanceAssaultState() {
    if (!this._inIdle || !this._assaultState) return;
    const liveFleet = this._fleet.filter(data => !data.dead && data.ship?.active);
    if (liveFleet.length === 0) return;

    const now = this._getNow();
    if (this._assaultState.phase === 'commit') {
      if (this._isFormationAttackGeometryReady(liveFleet) || now >= this._assaultState.expiresAt) {
        this._setAssaultPhase('attack');
      }
      return;
    }

    if (this._assaultState.phase === 'attack') {
      if (now >= this._assaultState.expiresAt) {
        this._setAssaultPhase('recover');
      }
      return;
    }

    if (this._assaultState.phase === 'recover' && now >= this._assaultState.expiresAt) {
      this._setAssaultPhase('commit');
    }
  }

  _updateBehaviorMetrics() {
    const now = this._getNow();
    const metrics = this._behaviorMetrics;
    const dt = Math.max(0, now - (metrics.lastTickAt ?? now));
    metrics.lastTickAt = now;

    const liveFleet = this._fleet.filter(data => !data.dead && data.ship?.active);
    if (metrics.firstVisibleAt === null && liveFleet.some(data => (data.ship?.y ?? -1) >= 0)) {
      metrics.firstVisibleAt = now;
    }
    if (!this._assaultState) return;

    const hasPressure = this._hasFormationPressureCommit(liveFleet, this._assaultState);
    const hasBracket = this._hasFormationBracket(liveFleet, this._assaultState);
    if (hasPressure && metrics.entryCompleteAt !== null && metrics.timeToCommitMs === null) {
      metrics.timeToCommitMs = Math.max(0, now - metrics.entryCompleteAt);
    }
    if (hasPressure) metrics.pressureOccupancyMs += dt;
    if (hasBracket) metrics.bracketMs += dt;
    if (liveFleet.length > 0 && !hasPressure && !hasBracket) {
      metrics.deadAirMs += dt;
    }

    const player = this._getPlayerSnapshot();
    const displacement = Math.abs((player?.x ?? this._assaultState.playerStartX ?? WIDTH / 2) - (this._assaultState.playerStartX ?? WIDTH / 2));
    metrics.playerDisplacementPxMax = Math.max(metrics.playerDisplacementPxMax, displacement);
    if (!this._assaultState.reactionCounted && displacement >= (this._getAssaultConfig().reactionDistancePx ?? 60)) {
      this._assaultState.reactionCounted = true;
      metrics.forcedReactionCount += 1;
    }
  }

  _pickMotionStyle() {
    return this._rng() < this._behavior.abruptChance ? 'abrupt' : 'organic';
  }

  _resolveTravelDuration(ship, targetX, targetY, requestedDurationMs) {
    const durationMs = Math.max(1, Math.round(requestedDurationMs ?? 0));
    return ship?.resolveTravelDurationMs?.(durationMs, targetX, targetY) ?? durationMs;
  }

  _runPath(data, startIdx = 0) {
    if (data.dead) {
      this._onLanded();
      return;
    }

    const pathBehavior = this._getEffectiveBehavior('path');
    this._chainStep(data.ship, data.path, startIdx, () => {
      const requestedDuration = Math.round(pathBehavior.exitToSlotMs / data.speed);
      this._scene.tweens.add({
        targets: data.ship,
        x: data.slot.x,
        y: data.slot.y,
        duration: this._resolveTravelDuration(data.ship, data.slot.x, data.slot.y, requestedDuration),
        ease: 'Cubic.easeOut',
        onComplete: () => {
          if (!data.adaptiveUnlocked) {
            data.ship.unlockAdaptiveBehavior?.();
            data.adaptiveUnlocked = true;
          }
          data.landed = true;
          this._onLanded();
        },
      });
    });
  }

  _chainStep(ship, steps, idx, onDone) {
    if (idx >= steps.length) {
      onDone();
      return;
    }

    const { x, y, dur, ease } = steps[idx];
    this._scene.tweens.add({
      targets: ship,
      x,
      y,
      duration: this._resolveTravelDuration(ship, x, y, dur),
      ease,
      onComplete: () => this._chainStep(ship, steps, idx + 1, onDone),
    });
  }

  _onLanded() {
    this._landed++;
    if (this._landed < this._fleet.length) return;
    if (this._fleet.some(data => !data.dead)) this._beginIdle();
  }

  _startShootLoop(rate, callback) {
    this._shootLoop = { rate, callback };
    this._scheduleShootLoop();
  }

  _resolveSoonestFireDelay() {
    const delays = this._fleet
      .filter(data => !data.dead && data.ship?.active)
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

  _resolveShootLoopDelay(rate, callback) {
    const phase = callback === this._fireMovingNext ? 'path' : 'idle';
    const cadence = this._resolveShotCadence(phase);
    const cadenceRate = Math.max(
      0.2,
      rate
      * (cadence.modifier ?? 1)
      * (phase === 'path' ? (cadence.pathModifier ?? 1) : (cadence.idleModifier ?? 1))
    );
    const cadenceDelay = Math.max(1, Math.round(1000 / cadenceRate));
    const readyDelay = this._resolveSoonestFireDelay();

    if (phase === 'path') {
      if ((this._getAssaultConfig().pathFireEnabled ?? false) === false) {
        return cadenceDelay;
      }
      if (readyDelay === null) return cadenceDelay;
      return Math.max(1, Math.min(readyDelay, cadenceDelay));
    }

    const assaultPhase = this._assaultState?.phase ?? null;
    if (!assaultPhase || assaultPhase === 'recover') {
      return Math.max(1, Math.round(this._getAssaultConfig().settleMs ?? 220));
    }
    if (assaultPhase === 'attack' && !this._isFormationAttackGeometryReady(
      this._fleet.filter(data => !data.dead && data.ship?.active)
    )) {
      return Math.max(1, Math.round(this._getAssaultConfig().settleMs ?? 220));
    }
    if (readyDelay === null) return cadenceDelay;
    return Math.max(1, Math.min(readyDelay, cadenceDelay));
  }

  _scheduleShootLoop() {
    if (!this._shootLoop) return;
    if (this._shootTimer) this._shootTimer.remove();

    const { rate, callback } = this._shootLoop;
    this._shootTimer = this._scene.time.delayedCall(
      this._resolveShootLoopDelay(rate, callback),
      () => {
        if (!this._shootLoop || this._shootLoop.callback !== callback) return;
        callback.call(this);
        if (!this._shootLoop || this._shootLoop.callback !== callback) return;
        this._scheduleShootLoop();
      }
    );
  }

  _startMovementFire() {
    this._startShootLoop(this._behavior.pathShootRate, this._fireMovingNext);
  }

  _beginIdle() {
    this._refreshSquadDirective('idle');
    const idleBehavior = this._getEffectiveBehavior('idle');
    this._inIdle = true;
    this._setAssaultPhase('commit');
    this._refreshSquadDirective('idle');

    for (const data of this._fleet) {
      if (data.dead) continue;
      data.motionStyle = this._pickMotionStyle();
      data.drifting = true;
      this._idleMove(data);
    }

    this._startShootLoop(this._behavior.shootRate, this._fireNext);

    if (this._cycleTimer) this._cycleTimer.remove();
    this._cycleTimer = this._scene.time.delayedCall(
      idleBehavior.cycleMs,
      () => this._beginPattern()
    );
  }

  _idleMove(data) {
    if (!data.drifting) return;
    this._refreshSquadDirective('idle');
    if (this._assaultState) {
      this._idleAssaultMove(data);
      return;
    }
    if (data.motionStyle === 'abrupt') {
      this._idleJink(data);
      return;
    }
    this._idleDrift(data);
  }

  _idleAssaultMove(data) {
    const cfg = this._getAssaultConfig();
    const behavior = this._getEffectiveBehavior('idle');
    const anchor = this._resolveTacticalAnchor(data, behavior);
    const duration = cfg.attackMoveDurationMs ?? 180;
    const pause = cfg.attackPauseMs ?? 36;

    this._scene.tweens.add({
      targets: data.ship,
      x: anchor.x,
      y: anchor.y,
      duration: this._resolveTravelDuration(
        data.ship,
        anchor.x,
        anchor.y,
        Math.max(1, Math.round(duration / (data.speed || 1)))
      ),
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.time.delayedCall(
          Math.max(1, Math.round(pause / (data.speed || 1))),
          () => this._idleMove(data)
        );
      },
    });
  }

  _idleDrift(data) {
    const behavior = this._getEffectiveBehavior('idle');
    const anchor = this._resolveTacticalAnchor(data, behavior);
    const ox = (this._rng() - 0.5) * 2 * behavior.driftX;
    const oy = (this._rng() - 0.5) * 2 * behavior.driftY;
    const dur = this._randInt(
      behavior.organicDurationMinMs,
      behavior.organicDurationMaxMs
    );
    const pause = this._randInt(
      behavior.organicPauseMinMs,
      behavior.organicPauseMaxMs
    );

    const driftPlan = resolveIdlePlan(
      data.ship,
      anchor.x + ox,
      anchor.y + oy,
      Math.max(20, behavior.driftX),
      Math.max(16, behavior.driftY * 4)
    );

    this._scene.tweens.add({
      targets: data.ship,
      x: driftPlan.x,
      y: driftPlan.y,
      duration: this._resolveTravelDuration(
        data.ship,
        driftPlan.x,
        driftPlan.y,
        Math.max(1, Math.round(dur / (data.speed || 1)))
      ),
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.tweens.add({
          targets: data.ship,
          x: anchor.x,
          y: anchor.y,
          duration: this._resolveTravelDuration(
            data.ship,
            anchor.x,
            anchor.y,
            Math.max(1, Math.round(dur / (data.speed || 1)))
          ),
          ease: 'Sine.easeInOut',
          onComplete: () => {
            if (!data.drifting) return;
            this._scene.time.delayedCall(
              Math.max(1, Math.round(pause / (data.speed || 1))),
              () => this._idleMove(data)
            );
          },
        });
      },
    });
  }

  _idleJink(data) {
    const behavior = this._getEffectiveBehavior('idle');
    const anchor = this._resolveTacticalAnchor(data, behavior);
    const dir = this._rng() < 0.5 ? -1 : 1;
    const ox = dir * behavior.abruptOffsetX * (0.65 + this._rng() * 0.35);
    const oy = (this._rng() - 0.5) * 2 * behavior.abruptOffsetY;
    const outMs = this._randInt(
      behavior.abruptDurationMinMs,
      behavior.abruptDurationMaxMs
    );
    const backMs = Math.max(50, Math.round(outMs * 0.9));
    const pause = this._randInt(
      behavior.abruptPauseMinMs,
      behavior.abruptPauseMaxMs
    );

    const jinkPlan = resolveIdlePlan(
      data.ship,
      anchor.x + ox,
      anchor.y + oy,
      Math.max(24, behavior.abruptOffsetX),
      Math.max(18, behavior.abruptOffsetY * 4)
    );

    this._scene.tweens.add({
      targets: data.ship,
      x: jinkPlan.x,
      y: jinkPlan.y,
      duration: this._resolveTravelDuration(
        data.ship,
        jinkPlan.x,
        jinkPlan.y,
        Math.max(1, Math.round(outMs / (data.speed || 1)))
      ),
      ease: 'Expo.easeOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.tweens.add({
          targets: data.ship,
          x: anchor.x,
          y: anchor.y,
          duration: this._resolveTravelDuration(
            data.ship,
            anchor.x,
            anchor.y,
            Math.max(1, Math.round(backMs / (data.speed || 1)))
          ),
          ease: 'Quad.easeIn',
          onComplete: () => {
            if (!data.drifting) return;
            this._scene.time.delayedCall(
              Math.max(1, Math.round(pause / (data.speed || 1))),
              () => this._idleMove(data)
            );
          },
        });
      },
    });
  }

  _fireMovingNext() {
    if ((this._getAssaultConfig().pathFireEnabled ?? false) === false) return;
    this._fireFromFleet('path', (data) => !data.dead && data.ship.active && data.ship.y >= 20);
  }

  _fireNext() {
    this._fireFromFleet('idle', (data) => !data.dead && data.ship.active);
  }

  _fireFromFleet(phase, predicate) {
    if (this._fleet.length === 0) return;
    this._refreshSquadDirective(phase);
    const liveFleet = this._fleet.filter(data => !data.dead && data.ship?.active);
    if (phase === 'idle') {
      const assaultPhase = this._assaultState?.phase ?? null;
      if (!assaultPhase || assaultPhase === 'recover') return;
      if (assaultPhase === 'attack' && !this._isFormationAttackGeometryReady(liveFleet)) return;
    }
    const cadence = this._resolveShotCadence(phase);
    const volley = this._selectVolleyCandidates(phase, predicate, cadence);
    if (volley.length === 0) return;
    if (phase === 'idle') {
      this._behaviorMetrics.coordinatedVolleyCount += 1;
    }

    volley.forEach((data, index) => {
      this._scene.time.delayedCall(
        Math.max(0, Math.round(index * (cadence.intraVolleyMs ?? 120))),
        () => this._emitFormationShot(data)
      );
    });
  }

  _beginPattern() {
    const alive = this._fleet.filter(data => !data.dead);
    if (alive.length === 0) return;

    this._refreshSquadDirective('path');
    const pathBehavior = this._getEffectiveBehavior('path');
    this._inIdle = false;
    this._assaultState = null;
    this._startMovementFire();
    if (pathBehavior.alternateSides) this._pathMirror = !this._pathMirror;

    const newSlots = calcFormationSlots(alive.length, pathBehavior);
    alive.forEach((data, i) => {
      const movementSpeedMultiplier = data.ship.getFormationMovementSpeedMultiplier?.() ?? 1;
      const slotPlan = resolveAdaptiveSlot(data.ship, newSlots[i], pathBehavior);
      const requestedDurationScale = pathBehavior.speed * movementSpeedMultiplier * (slotPlan.speedScalar ?? 1);
      const resolvedDurationScale = data.ship.resolveMovementDurationScale?.(requestedDurationScale) ?? requestedDurationScale;
      const effectiveShipSpeedMultiplier = resolvedDurationScale / Math.max(0.01, pathBehavior.speed);
      data.slot = { x: slotPlan.x, y: slotPlan.y };
      data.rowIndex = this._resolveRowIndex(slotPlan.y, pathBehavior);
      data.landed = false;
      data.motionStyle = this._pickMotionStyle();
      data.speed = resolvedDurationScale;
      data.path = applyAdaptivePath(
        data.ship,
        buildFormationPath(
          pathBehavior,
          i,
          alive.length,
          this._pathMirror,
          this._rng,
          effectiveShipSpeedMultiplier
        ),
        pathBehavior,
        slotPlan.speedScalar ?? 1
      );
    });

    for (const data of this._fleet) {
      data.drifting = false;
      if (!data.dead) this._scene.tweens.killTweensOf(data.ship);
    }

    this._landed = 0;
    let delay = 0;
    for (const data of this._fleet) {
      if (data.dead) {
        this._landed++;
        continue;
      }
      this._scene.time.delayedCall(delay, () => this._runPath(data));
      delay += Math.max(1, Math.round(pathBehavior.launchStaggerMs / (data.speed || 1)));
    }
  }

  _reorganize() {
    const living = this._fleet.filter(data => !data.dead);
    if (living.length === 0) return;

    const phase = this._inIdle ? 'idle' : 'path';
    const behavior = this._getEffectiveBehavior(phase);
    const newSlots = calcFormationSlots(living.length, behavior);
    living.forEach((data, i) => {
      const slotPlan = resolveAdaptiveSlot(data.ship, newSlots[i], behavior);
      data.slot = { x: slotPlan.x, y: slotPlan.y };
      data.rowIndex = this._resolveRowIndex(slotPlan.y, behavior);
      const requestedDurationScale = behavior.speed
        * (data.ship.getFormationMovementSpeedMultiplier?.() ?? 1)
        * (slotPlan.speedScalar ?? 1);
      data.speed = data.ship.resolveMovementDurationScale?.(requestedDurationScale) ?? requestedDurationScale;
      data.drifting = false;
      this._scene.tweens.killTweensOf(data.ship);
      this._scene.tweens.add({
        targets: data.ship,
        x: data.slot.x,
        y: data.slot.y,
        duration: this._resolveTravelDuration(
          data.ship,
          data.slot.x,
          data.slot.y,
          Math.max(1, Math.round(behavior.reformMs / (data.speed || 1)))
        ),
        ease: 'Cubic.easeOut',
        onComplete: () => {
          if (data.dead) return;
          data.drifting = true;
          this._idleMove(data);
        },
      });
    });
  }

  _randInt(min, max) {
    return Math.round(min + this._rng() * (max - min));
  }

  _resolveShotCadence(phase) {
    const behavior = this._getEffectiveBehavior(phase);
    const cadence = behavior.shotCadence ?? {};
    return {
      ...cadence,
      pattern: phase === 'path'
        ? (cadence.pathPattern ?? 'single')
        : (cadence.idlePattern ?? 'alternating_rows'),
      volleySize: clamp(
        Math.round(phase === 'path'
          ? (cadence.pathVolleySize ?? 1)
          : (cadence.idleVolleySize ?? 2)),
        1,
        4
      ),
    };
  }

  _resolveRowIndex(y, behavior = this._getEffectiveBehavior(this._inIdle ? 'idle' : 'path')) {
    const rowYs = behavior.rowYs ?? [];
    if (rowYs.length <= 1) return 0;

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    rowYs.forEach((rowY, index) => {
      const distance = Math.abs((y ?? 0) - rowY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
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

  _resolveShipRole(data, source = this._fleet.filter(entry => !entry.dead && entry.ship?.active)) {
    if (!Array.isArray(source) || source.length <= 1) {
      return { side: 'center', rank: 0, count: source?.length ?? 1 };
    }

    const ordered = [...source].sort((left, right) => (
      (left.slot?.x ?? left.ship?.x ?? 0) - (right.slot?.x ?? right.ship?.x ?? 0)
    ));
    const index = Math.max(0, ordered.indexOf(data));
    const ratio = source.length <= 1 ? 0.5 : index / (source.length - 1);
    if (ratio <= 0.34) return { side: 'left', rank: index, count: source.length };
    if (ratio >= 0.66) return { side: 'right', rank: index, count: source.length };
    return { side: 'center', rank: index, count: source.length };
  }

  _resolveTacticalAnchor(data, behavior) {
    const directive = this._squadDirective ?? this._createNeutralSquadDirective();
    const player = this._getPlayerSnapshot();
    const focusX = clamp(directive.focusX ?? player.x ?? WIDTH / 2, 24, WIDTH - 24);
    const focusPull = clamp(directive.focusPull ?? 0.32, 0, 1);
    const flankOffsetPx = Math.max(24, directive.flankOffsetPx ?? 72);
    const aggression = clamp(directive.aggression ?? 0.5, 0, 1);
    const role = this._resolveShipRole(data);
    const playerY = player.y ?? HEIGHT - 80;
    const assault = this._assaultState;
    const cfg = this._getAssaultConfig();
    const rowDepthBonus = (data.rowIndex ?? 0) >= (assault?.frontRow ?? 1)
      ? (cfg.pressureFrontRowBonusPx ?? 26)
      : (cfg.pressureRearRowBonusPx ?? -18);
    const defaultPressureLeadPx = ({
      collapse: 150,
      encircle: 170,
      crossfire: 180,
      suppress: 190,
      feint: 220,
      scatter: 250,
    })[directive.doctrine] ?? 190;
    const pressureTargetY = clamp(
      Math.min(
        playerY - defaultPressureLeadPx,
        data.slot.y + 108 + aggression * 42
      ),
      data.slot.y - 10,
      HEIGHT - 136
    );
    let targetX = data.slot.x;
    let targetY = data.slot.y;

    if (this._inIdle && assault) {
      const assaultFocusX = clamp(assault.focusX ?? focusX, 24, WIDTH - 24);
      const assaultFlankOffsetPx = Math.max(32, assault.flankOffsetPx ?? flankOffsetPx);
      const commitY = clamp(assault.pressureLineY + rowDepthBonus - 18, 40, HEIGHT - 132);
      const attackY = clamp(assault.pressureLineY + rowDepthBonus, 48, HEIGHT - 104);
      const recoverY = clamp((data.slot?.y ?? HEIGHT * 0.25) - (cfg.recoverLiftPx ?? 54), 28, HEIGHT - 132);
      const activeY = assault.phase === 'attack'
        ? attackY
        : assault.phase === 'recover'
          ? recoverY
          : commitY;

      switch (assault.doctrine) {
        case 'collapse':
          targetX = assaultFocusX + (role.side === 'left' ? -20 : role.side === 'right' ? 20 : 0);
          targetY = activeY + 10;
          break;
        case 'crossfire':
          if (role.side === 'left') targetX = assaultFocusX - assaultFlankOffsetPx * 0.72;
          else if (role.side === 'right') targetX = assaultFocusX + assaultFlankOffsetPx * 0.72;
          else targetX = assaultFocusX;
          targetY = activeY;
          break;
        case 'encircle':
          if (role.side === 'left') targetX = assaultFocusX - assaultFlankOffsetPx;
          else if (role.side === 'right') targetX = assaultFocusX + assaultFlankOffsetPx;
          else targetX = assaultFocusX;
          targetY = activeY + (role.side === 'center' ? 8 : -4);
          break;
        case 'feint':
          targetX = data.slot.x + ((assaultFocusX - data.slot.x) * 0.46);
          targetY = assault.phase === 'attack' ? activeY : activeY - 20;
          break;
        case 'scatter':
          targetX = data.slot.x + ((data.slot.x <= assaultFocusX ? -1 : 1) * assaultFlankOffsetPx * 0.55);
          targetY = assault.phase === 'recover' ? recoverY : activeY - 14;
          break;
        case 'suppress':
        default:
          targetX = assaultFocusX + ((role.rank - ((role.count - 1) / 2)) * 26);
          targetY = activeY;
          break;
      }

      if (assault.phase === 'recover') {
        targetX = data.slot.x + ((targetX - data.slot.x) * 0.25);
        targetY = recoverY;
      }

      return {
        x: clamp(targetX, 24, WIDTH - 24),
        y: clamp(targetY, 24, HEIGHT - 96),
      };
    }

    switch (directive.doctrine) {
      case 'collapse':
        targetX = data.slot.x + ((focusX - data.slot.x) * Math.max(0.55, focusPull));
        targetY = pressureTargetY + 28;
        break;
      case 'crossfire':
        if (role.side === 'left') targetX = focusX - flankOffsetPx * 0.55;
        else if (role.side === 'right') targetX = focusX + flankOffsetPx * 0.55;
        else targetX = data.slot.x + ((focusX - data.slot.x) * 0.35);
        targetY = pressureTargetY + 10;
        break;
      case 'encircle':
        if (role.side === 'left') targetX = focusX - flankOffsetPx;
        else if (role.side === 'right') targetX = focusX + flankOffsetPx;
        else targetX = focusX;
        targetY = pressureTargetY + (role.side === 'center' ? 20 : 6);
        break;
      case 'feint':
        targetX = data.slot.x + ((focusX - data.slot.x) * 0.38);
        targetY = pressureTargetY + (role.side === 'center' ? -18 : -4);
        break;
      case 'scatter':
        targetX = data.slot.x + ((data.slot.x <= focusX ? -1 : 1) * flankOffsetPx * 0.45);
        targetY = data.slot.y - 16;
        break;
      case 'suppress':
      default:
        targetX = data.slot.x + ((focusX - data.slot.x) * focusPull * 0.72);
        targetY = pressureTargetY;
        break;
    }

    return {
      x: clamp(targetX, 24, WIDTH - 24),
      y: clamp(targetY, 24, HEIGHT - 96),
    };
  }

  _scoreShipForDirective(data, ready, options = {}) {
    const player = this._getPlayerSnapshot();
    const focusX = clamp(this._squadDirective?.focusX ?? player.x ?? WIDTH / 2, 24, WIDTH - 24);
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

  _isShipReadyToFire(data) {
    const fireRate = Math.max(0, data?.ship?.fireRate ?? 0);
    if (fireRate <= 0) return true;
    return (data?.ship?.getFormationFireCooldown?.() ?? 0) >= fireRate;
  }

  _selectVolleyCandidates(phase, predicate, cadence) {
    const ready = this._fleet.filter((data) => (
      data
      && predicate(data)
      && this._isShipReadyToFire(data)
      && (!data.ship?.shouldFireNow || data.ship.shouldFireNow() !== false)
    ));
    if (ready.length === 0) return [];

    switch (cadence.pattern) {
      case 'focus_lane':
        return this._selectFocusLaneVolley(ready, cadence.volleySize);
      case 'crossfire':
        return this._selectCrossfireVolley(ready, cadence.volleySize);
      case 'encircle':
        return this._selectEncircleVolley(ready, cadence.volleySize);
      case 'collapse':
        return this._selectCollapseVolley(ready, cadence.volleySize);
      case 'stagger_pin':
        return this._selectStaggerPinVolley(ready, cadence.volleySize);
      case 'wings':
        return this._selectWingVolley(ready, cadence.volleySize);
      case 'alternating_rows':
        return this._selectAlternatingRowVolley(ready, cadence.volleySize);
      case 'sweep':
        return this._selectSweepVolley(ready, cadence.volleySize);
      case 'single':
      default:
        return this._selectSweepVolley(ready, 1);
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

  _selectAlternatingRowVolley(ready, volleySize) {
    const rowCount = Math.max(1, (this._behavior.rowYs ?? []).length);
    const targetRow = this._rowShotCursor % rowCount;
    this._rowShotCursor = (this._rowShotCursor + 1) % rowCount;
    const rowCandidates = ready.filter(data => data.rowIndex === targetRow);
    if (rowCandidates.length === 0) {
      return this._selectSweepVolley(ready, volleySize);
    }
    return this._selectSweepVolley(rowCandidates, volleySize);
  }

  _selectWingVolley(ready, volleySize) {
    const sorted = [...ready].sort((a, b) => (
      Math.abs((b.ship?.x ?? WIDTH / 2) - WIDTH / 2)
      - Math.abs((a.ship?.x ?? WIDTH / 2) - WIDTH / 2)
    ));
    const volley = [];
    for (let tries = 0; tries < sorted.length && volley.length < volleySize; tries += 1) {
      const index = (this._wingShotCursor + tries) % sorted.length;
      volley.push(sorted[index]);
    }
    this._wingShotCursor = (this._wingShotCursor + volley.length) % Math.max(1, sorted.length);
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
    const rowCount = Math.max(1, (this._behavior.rowYs ?? []).length);
    const targetRow = this._rowShotCursor % rowCount;
    this._rowShotCursor = (this._rowShotCursor + 1) % rowCount;
    const rowReady = ready.filter(data => data.rowIndex === targetRow);
    if (rowReady.length === 0) {
      return this._selectFocusLaneVolley(ready, volleySize);
    }
    return this._rankReadyShips(rowReady, {
      alignmentWeight: 0.56,
      laneWeight: 0.30,
      depthWeight: 0.08,
    }).slice(0, volleySize);
  }

  _emitFormationShot(data) {
    if (!data || data.dead || !data.ship?.active) return;
    if (!this._isShipReadyToFire(data)) return;

    this._squadStats.shotCount += 1;
    this._scene.tweens.add({
      targets: data.ship,
      alpha: 0.25,
      duration: 80,
      yoyo: true,
      repeat: 1,
    });

    data.ship.emitFormationShot?.();
  }

  /** Stop all timers and tweens (call on game over). */
  stop() {
    if (this._shootTimer) {
      this._shootTimer.remove();
      this._shootTimer = null;
    }
    this._shootLoop = null;
    if (this._cycleTimer) {
      this._cycleTimer.remove();
      this._cycleTimer = null;
    }
    this._assaultState = null;
    for (const data of this._fleet) {
      data.drifting = false;
      if (!data.dead && data.ship.active) {
        this._scene.tweens.killTweensOf(data.ship);
      }
      data.ship?.onFormationEnd?.();
    }
    this._scene.events?.off?.(EVENTS.PLAYER_HIT, this._handlePlayerHit);
    this._scene.events?.off?.(EVENTS.ENEMY_DIED, this._handleEnemyDied);
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
      spreadMultiplier: 1,
      driftMultiplier: 1,
      verticalBiasPx: 0,
      volleySizeBonus: 0,
      pathPattern: null,
      idlePattern: null,
      focusX: WIDTH / 2,
      focusPull: 0.32,
      flankOffsetPx: 72,
      pathSpreadBonusPx: 0,
      sideLaneSpreadBonusPx: 0,
      slotSpacingMultiplier: 1,
      rowShiftPx: 0,
    };
  }

  _refreshSquadDirective(phase) {
    const liveShips = this._fleet
      .filter(data => !data.dead && data.ship?.active)
      .map(data => data.ship);
    if (liveShips.length === 0) {
      this._squadDirective = this._createNeutralSquadDirective();
      return this._squadDirective;
    }

    const directive = this._services?.adaptive?.evaluateSquadDirective?.({
      phase,
      squadId: this._squadId,
      squadTemplateId: this._squadTemplateId,
      formation: this._formation,
      dance: this._dance,
      overlay: this._overlay,
      primaryEnemyType: this._primaryEnemyType,
      liveEnemies: liveShips,
      stats: this._squadStats,
    });
    this._squadDirective = directive ?? this._createNeutralSquadDirective();
    if (phase === 'idle' && this._assaultState) {
      this._advanceAssaultState();
      this._updateBehaviorMetrics();
    }
    this._applyDoctrineState(phase);
    return this._squadDirective;
  }

  _resolveDoctrineSpeedScalar(ship, directive = this._squadDirective ?? this._createNeutralSquadDirective()) {
    const minSpeed = ship?.adaptiveProfile?.minSpeedScalar ?? 1;
    const maxSpeed = ship?.adaptiveProfile?.maxSpeedScalar ?? 1;
    const assaultPhase = this._assaultState?.phase ?? null;
    const doctrineBias = ({
      collapse: 0.10,
      encircle: 0.08,
      crossfire: 0.06,
      suppress: 0.04,
      feint: 0.02,
      scatter: -0.04,
    })[directive?.doctrine] ?? 0;
    const phaseBias = ({
      commit: 0.08,
      attack: 0.12,
      recover: -0.02,
    })[assaultPhase] ?? 0;
    return clamp(
      0.98
      + (directive?.aggression ?? 0.5) * 0.18
      - (directive?.caution ?? 0.5) * 0.08
      + doctrineBias
      + phaseBias,
      minSpeed,
      maxSpeed
    );
  }

  _applyDoctrineState(phase) {
    const behavior = this._getEffectiveBehavior(phase);
    const liveFleet = this._fleet.filter(data => !data.dead && data.ship?.active);

    for (const data of this._fleet) {
      if (!data.ship?.setSquadDoctrineState) continue;
      if (!liveFleet.includes(data)) {
        data.ship.clearSquadDoctrineState?.();
        continue;
      }

      data.role = this._resolveShipRole(data, liveFleet);
      const anchor = this._resolveTacticalAnchor(data, behavior);
      const slotX = data.slot?.x ?? data.ship?.x ?? WIDTH / 2;
      const slotY = data.slot?.y ?? data.ship?.y ?? HEIGHT * 0.25;
      const assaultPhase = phase === 'idle' ? (this._assaultState?.phase ?? null) : null;
      const anchorWeight = clamp(
        0.34
        + (this._squadDirective?.aggression ?? 0.5) * 0.26
        - (this._squadDirective?.caution ?? 0.5) * 0.08
        + (phase === 'path' ? 0.06 : 0)
        + (this._squadDirective?.doctrine === 'crossfire' || this._squadDirective?.doctrine === 'encircle' ? 0.04 : 0)
        + (assaultPhase === 'commit' ? 0.14 : 0)
        + (assaultPhase === 'attack' ? 0.20 : 0),
        0.30,
        0.96
      );
      const rangePx = clamp(
        Math.abs(anchor.x - slotX) * 0.72
        + Math.max(30, (behavior.slotSpacingX ?? 60) * (assaultPhase === 'attack' ? 0.24 : 0.52)),
        34,
        168
      );
      const yRangePx = clamp(
        Math.abs(anchor.y - slotY) * 0.92 + (assaultPhase === 'attack' ? 18 : 30),
        24,
        156
      );

      data.ship.setSquadDoctrineState({
        active: true,
        doctrine: this._squadDirective?.doctrine ?? 'suppress',
        phase: phase === 'idle' ? (this._assaultState?.phase ?? 'idle') : phase,
        role: data.role,
        anchorX: anchor.x,
        anchorY: anchor.y,
        anchorWeight,
        rangePx,
        yRangePx,
        speedScalar: this._resolveDoctrineSpeedScalar(data.ship),
        focusX: this._squadDirective?.focusX,
        focusPull: this._squadDirective?.focusPull,
        flankOffsetPx: this._squadDirective?.flankOffsetPx,
        aggression: this._squadDirective?.aggression,
        caution: this._squadDirective?.caution,
      });
    }
  }

  _applyDirectiveToFlightPlan(phase) {
    const behavior = this._getEffectiveBehavior(phase);
    const liveFleet = this._fleet.filter(data => !data.dead && data.ship?.active);

    liveFleet.forEach((data, i) => {
      const movementSpeedMultiplier = data.ship.getFormationMovementSpeedMultiplier?.() ?? 1;
      const slotPlan = resolveAdaptiveSlot(data.ship, calcFormationSlots(liveFleet.length, behavior)[i], behavior);
      const requestedDurationScale = behavior.speed * movementSpeedMultiplier * (slotPlan.speedScalar ?? 1);
      const resolvedDurationScale = data.ship.resolveMovementDurationScale?.(requestedDurationScale) ?? requestedDurationScale;
      const effectiveShipSpeedMultiplier = resolvedDurationScale / Math.max(0.01, behavior.speed);
      data.slot = { x: slotPlan.x, y: slotPlan.y };
      data.rowIndex = this._resolveRowIndex(slotPlan.y, behavior);
      data.speed = resolvedDurationScale;
      data.path = applyAdaptivePath(
        data.ship,
        buildFormationPath(
          behavior,
          i,
          liveFleet.length,
          this._pathMirror,
          this._rng,
          effectiveShipSpeedMultiplier
        ),
        behavior,
        slotPlan.speedScalar ?? 1
      );
    });
  }

  _getEffectiveBehavior(phase) {
    const directive = this._squadDirective ?? this._createNeutralSquadDirective();
    const spreadMultiplier = directive.spreadMultiplier ?? 1;
    const driftMultiplier = directive.driftMultiplier ?? 1;
    const verticalBiasPx = directive.verticalBiasPx ?? 0;
    const rowShiftPx = directive.rowShiftPx ?? 0;
    const baseCadence = this._behavior.shotCadence ?? {};
    const slotSpacingMultiplier = directive.slotSpacingMultiplier ?? spreadMultiplier;
    const pathSpreadBonusPx = directive.pathSpreadBonusPx ?? 0;
    const sideLaneSpreadBonusPx = directive.sideLaneSpreadBonusPx ?? 0;

    return {
      ...this._behavior,
      slotSpacingX: Math.max(28, (this._behavior.slotSpacingX ?? 60) * slotSpacingMultiplier),
      pathSpreadX: Math.max(
        0,
        (this._behavior.pathSpreadX ?? 0) * spreadMultiplier
        + ((this._behavior.slotSpacingX ?? 60) * Math.max(0, spreadMultiplier - 1) * 0.35)
        + pathSpreadBonusPx
      ),
      sideLaneSpreadX: Math.max(0, (this._behavior.sideLaneSpreadX ?? 0) * spreadMultiplier + sideLaneSpreadBonusPx),
      rowYs: (this._behavior.rowYs ?? []).map(y => clamp(y + verticalBiasPx + rowShiftPx, 24, HEIGHT - 96)),
      driftX: Math.max(12, (this._behavior.driftX ?? 30) * driftMultiplier),
      driftY: Math.max(2, (this._behavior.driftY ?? 5) * driftMultiplier),
      shotCadence: {
        ...baseCadence,
        modifier: (baseCadence.modifier ?? 1) * (directive.cadenceModifier ?? 1),
        pathPattern: directive.pathPattern ?? baseCadence.pathPattern,
        idlePattern: directive.idlePattern ?? baseCadence.idlePattern,
        pathVolleySize: clamp(
          Math.round((baseCadence.pathVolleySize ?? 1) + (phase === 'path' ? (directive.volleySizeBonus ?? 0) : 0)),
          1,
          4
        ),
        idleVolleySize: clamp(
          Math.round((baseCadence.idleVolleySize ?? 2) + (phase === 'idle' ? (directive.volleySizeBonus ?? 0) : 0)),
          1,
          4
        ),
      },
    };
  }
}
