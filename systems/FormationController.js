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
import { EVENTS } from '../config/events.config.js';

const { WIDTH, HEIGHT } = GAME_CONFIG;

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
  if (!ship?.resolveAdaptiveMovePlan) return { ...slot, speedScalar: 1 };
  return ship.resolveAdaptiveMovePlan(slot.x, {
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
  if (!ship?.resolveAdaptiveMovePlan) {
    return path.map(step => ({ ...step }));
  }

  const rangePx = Math.max(
    28,
    behavior.pathSpreadX ?? 0,
    behavior.sideLaneSpreadX ?? 0,
    (behavior.slotSpacingX ?? 60) * 0.5
  );

  return path.map(step => ({
    ...step,
    ...(function () {
      const plan = ship.resolveAdaptiveMovePlan(step.x, {
        candidateY: step.y,
        rangePx,
        yRangePx: Math.max(24, rangePx * 0.45),
        marginPx: 24,
        topMarginPx: 24,
        bottomMarginPx: HEIGHT - 96,
        commit: false,
        speedScalars: [speedScalar],
      });
      return {
        x: plan.x,
        y: plan.y,
      };
    }()),
  }));
}

function resolveIdlePlan(ship, x, y, rangePx, yRangePx) {
  return ship.resolveAdaptiveMovePlan?.(x, {
    candidateY: y,
    rangePx,
    yRangePx,
    marginPx: 24,
    topMarginPx: 24,
    bottomMarginPx: HEIGHT - 96,
    commit: false,
  }) ?? { x, y };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export class FormationController {
  /**
   * @param {Phaser.Scene} scene
   * @param {EnemyBase[]} ships - Formation ships already spawned in the scene
   * @param {object} [controller={}] - Squadron-specific formation behaviour
   * @param {Function} [rng=Math.random]
   */
  constructor(scene, ships, controller = {}, rng = Math.random) {
    this._scene = scene;
    this._rng = rng;
    this._behavior = resolveFormationBehavior(controller, rng);
    this._squadId = ships[0]?._squadId ?? null;
    this._squadTemplateId = ships[0]?._squadTemplateId ?? null;
    this._formation = ships[0]?._formationType ?? controller.formation ?? null;
    this._dance = controller.dance ?? ships[0]?._spawnDance ?? ships[0]?.dance ?? null;
    this._overlay = Boolean(controller.overlay ?? ships[0]?._overlayRaid);
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
    this._cycleTimer = null;
    this._inIdle = false;

    this._handlePlayerHit = (payload = {}) => {
      if (!this._squadId || payload.squadId !== this._squadId) return;
      this._squadStats.playerHitCount += 1;
      this._squadStats.hpDamageToPlayer += Math.max(0, payload.hpDamage ?? 0);
      this._squadStats.shieldDamageToPlayer += Math.max(0, payload.absorbed ?? 0);
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
      const movementSpeedMultiplier = ship._baseMovementSpeedMultiplier ?? ship._movementSpeedMultiplier ?? 1;
      const slotPlan = resolveAdaptiveSlot(
        ship,
        slots[i] ?? { x: WIDTH / 2, y: pathBehavior.rowYs[0] ?? 65 },
        pathBehavior
      );
      const data = {
        ship,
        slot: { x: slotPlan.x, y: slotPlan.y },
        rowIndex: this._resolveRowIndex(slotPlan.y, pathBehavior),
        speed: pathBehavior.speed * movementSpeedMultiplier * (slotPlan.speedScalar ?? 1),
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
            movementSpeedMultiplier * (slotPlan.speedScalar ?? 1)
          ),
          pathBehavior,
          slotPlan.speedScalar ?? 1
        ),
      };
      this._fleet.push(data);

      const launchAnchor = data.path[0];
      ship.x = launchAnchor.x;
      ship.y = launchAnchor.y;
      if (ship.body) ship.body.reset(launchAnchor.x, launchAnchor.y);
      ship._formationFireControlled = true;
      ship._formationController = this;

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

    this._startMovementFire();
    this._fleet.forEach((data, i) => {
      scene.time.delayedCall(
        Math.max(1, Math.round((i * pathBehavior.launchStaggerMs) / (data.speed || 1))),
        () => this._runPath(data, 1)
      );
    });
  }

  _pickMotionStyle() {
    return this._rng() < this._behavior.abruptChance ? 'abrupt' : 'organic';
  }

  _runPath(data, startIdx = 0) {
    if (data.dead) {
      this._onLanded();
      return;
    }

    const pathBehavior = this._getEffectiveBehavior('path');
    this._chainStep(data.ship, data.path, startIdx, () => {
      this._scene.tweens.add({
        targets: data.ship,
        x: data.slot.x,
        y: data.slot.y,
        duration: Math.round(pathBehavior.exitToSlotMs / data.speed),
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
      duration: dur,
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
    if (this._shootTimer) this._shootTimer.remove();
    const cadence = this._resolveShotCadence(callback === this._fireMovingNext ? 'path' : 'idle');
    const cadenceRate = Math.max(
      0.2,
      rate
      * (cadence.modifier ?? 1)
      * (callback === this._fireMovingNext ? (cadence.pathModifier ?? 1) : (cadence.idleModifier ?? 1))
    );
    this._shootTimer = this._scene.time.addEvent({
      delay: Math.max(120, Math.round(1000 / cadenceRate)),
      callback,
      callbackScope: this,
      loop: true,
    });
  }

  _startMovementFire() {
    this._startShootLoop(this._behavior.pathShootRate, this._fireMovingNext);
  }

  _beginIdle() {
    this._refreshSquadDirective('idle');
    const idleBehavior = this._getEffectiveBehavior('idle');
    this._inIdle = true;

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
    if (data.motionStyle === 'abrupt') {
      this._idleJink(data);
      return;
    }
    this._idleDrift(data);
  }

  _idleDrift(data) {
    const behavior = this._getEffectiveBehavior('idle');
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
      data.slot.x + ox,
      data.slot.y + oy,
      Math.max(20, behavior.driftX),
      Math.max(16, behavior.driftY * 4)
    );

    this._scene.tweens.add({
      targets: data.ship,
      x: driftPlan.x,
      y: driftPlan.y,
      duration: Math.max(1, Math.round(dur / (data.speed || 1))),
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.tweens.add({
          targets: data.ship,
          x: data.slot.x,
          y: data.slot.y,
          duration: Math.max(1, Math.round(dur / (data.speed || 1))),
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
      data.slot.x + ox,
      data.slot.y + oy,
      Math.max(24, behavior.abruptOffsetX),
      Math.max(18, behavior.abruptOffsetY * 4)
    );

    this._scene.tweens.add({
      targets: data.ship,
      x: jinkPlan.x,
      y: jinkPlan.y,
      duration: Math.max(1, Math.round(outMs / (data.speed || 1))),
      ease: 'Expo.easeOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.tweens.add({
          targets: data.ship,
          x: data.slot.x,
          y: data.slot.y,
          duration: Math.max(1, Math.round(backMs / (data.speed || 1))),
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
    this._fireFromFleet('path', (data) => !data.dead && data.ship.active && data.ship.y >= 20);
  }

  _fireNext() {
    this._fireFromFleet('idle', (data) => !data.dead && data.ship.active);
  }

  _fireFromFleet(phase, predicate) {
    if (this._fleet.length === 0) return;
    const cadence = this._resolveShotCadence(phase);
    const volley = this._selectVolleyCandidates(phase, predicate, cadence);
    if (volley.length === 0) return;

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
    this._startMovementFire();
    if (pathBehavior.alternateSides) this._pathMirror = !this._pathMirror;

    const newSlots = calcFormationSlots(alive.length, pathBehavior);
    alive.forEach((data, i) => {
      const movementSpeedMultiplier = data.ship._baseMovementSpeedMultiplier ?? data.ship._movementSpeedMultiplier ?? 1;
      const slotPlan = resolveAdaptiveSlot(data.ship, newSlots[i], pathBehavior);
      data.slot = { x: slotPlan.x, y: slotPlan.y };
      data.rowIndex = this._resolveRowIndex(slotPlan.y, pathBehavior);
      data.landed = false;
      data.motionStyle = this._pickMotionStyle();
      data.speed = pathBehavior.speed * movementSpeedMultiplier * (slotPlan.speedScalar ?? 1);
      data.path = applyAdaptivePath(
        data.ship,
        buildFormationPath(
          pathBehavior,
          i,
          alive.length,
          this._pathMirror,
          this._rng,
          movementSpeedMultiplier * (slotPlan.speedScalar ?? 1)
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
      data.speed = behavior.speed
        * (data.ship._baseMovementSpeedMultiplier ?? data.ship._movementSpeedMultiplier ?? 1)
        * (slotPlan.speedScalar ?? 1);
      data.drifting = false;
      this._scene.tweens.killTweensOf(data.ship);
      this._scene.tweens.add({
        targets: data.ship,
        x: data.slot.x,
        y: data.slot.y,
        duration: Math.max(1, Math.round(behavior.reformMs / (data.speed || 1))),
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

  _isShipReadyToFire(data) {
    const fireRate = Math.max(0, data?.ship?.fireRate ?? 0);
    if (fireRate <= 0) return true;
    return (data?.ship?._fireCooldown ?? 0) >= fireRate;
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

  _emitFormationShot(data) {
    if (!data || data.dead || !data.ship?.active) return;
    if (!this._isShipReadyToFire(data)) return;

    data.ship._fireCooldown = 0;
    this._squadStats.shotCount += 1;
    this._scene.tweens.add({
      targets: data.ship,
      alpha: 0.25,
      duration: 80,
      yoyo: true,
      repeat: 1,
    });

    data.ship.emitNativeFireBursts?.({ yOffset: 14, speedOverride: 600 });
  }

  /** Stop all timers and tweens (call on game over). */
  stop() {
    if (this._shootTimer) {
      this._shootTimer.remove();
      this._shootTimer = null;
    }
    if (this._cycleTimer) {
      this._cycleTimer.remove();
      this._cycleTimer = null;
    }
    for (const data of this._fleet) {
      data.drifting = false;
      if (!data.dead && data.ship.active) {
        this._scene.tweens.killTweensOf(data.ship);
      }
      if (data.ship) {
        data.ship._formationFireControlled = false;
        data.ship._formationController = null;
      }
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
      cadenceModifier: 1,
      spreadMultiplier: 1,
      driftMultiplier: 1,
      verticalBiasPx: 0,
      volleySizeBonus: 0,
      pathPattern: null,
      idlePattern: null,
    };
  }

  _refreshSquadDirective(phase) {
    const liveShips = this._fleet
      .filter(data => !data.dead && data.ship?.active)
      .map(data => data.ship);
    const adaptiveReady = liveShips.some(ship => ship.canUseAdaptiveBehavior?.() || ship._adaptiveUnlocked);
    if (!adaptiveReady) {
      this._squadDirective = this._createNeutralSquadDirective();
      return this._squadDirective;
    }

    const directive = this._scene?._enemyAdaptivePolicy?.evaluateSquadDirective?.({
      phase,
      scene: this._scene,
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
    return this._squadDirective;
  }

  _getEffectiveBehavior(phase) {
    const directive = this._squadDirective ?? this._createNeutralSquadDirective();
    const spreadMultiplier = directive.spreadMultiplier ?? 1;
    const driftMultiplier = directive.driftMultiplier ?? 1;
    const verticalBiasPx = directive.verticalBiasPx ?? 0;
    const baseCadence = this._behavior.shotCadence ?? {};

    return {
      ...this._behavior,
      slotSpacingX: Math.max(28, (this._behavior.slotSpacingX ?? 60) * spreadMultiplier),
      pathSpreadX: Math.max(
        0,
        (this._behavior.pathSpreadX ?? 0) * spreadMultiplier
        + ((this._behavior.slotSpacingX ?? 60) * Math.max(0, spreadMultiplier - 1) * 0.35)
      ),
      sideLaneSpreadX: Math.max(0, (this._behavior.sideLaneSpreadX ?? 0) * spreadMultiplier),
      rowYs: (this._behavior.rowYs ?? []).map(y => clamp(y + verticalBiasPx, 24, HEIGHT - 96)),
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
