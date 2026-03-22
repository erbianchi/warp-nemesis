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

import { EVENTS } from '../config/events.config.js';
import { GAME_CONFIG } from '../config/game.config.js';

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
  rng = Math.random
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
      dur: Math.max(1, Math.round(behavior.returnToSideMs / behavior.speed)),
      ease: 'Sine.easeInOut',
    },
    ...behavior.path.map(step => resolveFormationStep(step, laneOffsetX, pathBehavior, pathRng)),
    {
      x: returnX,
      y: behavior.returnTopY,
      dur: Math.max(1, Math.round(behavior.returnToSideMs / behavior.speed)),
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
    this._pathMirror = controller.mirrorPath === undefined
      ? this._rng() < 0.5
      : this._behavior.mirrorPath;
    this._fleet = [];
    this._landed = 0;
    this._shootIdx = 0;
    this._shootTimer = null;
    this._cycleTimer = null;
    this._inIdle = false;

    const slots = calcFormationSlots(ships.length, this._behavior);

    ships.forEach((ship, i) => {
      const data = {
        ship,
        slot: slots[i] ?? { x: WIDTH / 2, y: this._behavior.rowYs[0] ?? 65 },
        speed: this._behavior.speed,
        drifting: false,
        dead: false,
        landed: false,
        motionStyle: this._pickMotionStyle(),
        path: buildFormationPath(this._behavior, i, ships.length, this._pathMirror, this._rng),
      };
      this._fleet.push(data);

      const launchAnchor = data.path[0];
      ship.x = launchAnchor.x;
      ship.y = launchAnchor.y;
      if (ship.body) ship.body.reset(launchAnchor.x, launchAnchor.y);

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
      scene.time.delayedCall(i * this._behavior.launchStaggerMs, () => this._runPath(data, 1));
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

    this._chainStep(data.ship, data.path, startIdx, () => {
      this._scene.tweens.add({
        targets: data.ship,
        x: data.slot.x,
        y: data.slot.y,
        duration: Math.round(this._behavior.exitToSlotMs / data.speed),
        ease: 'Cubic.easeOut',
        onComplete: () => {
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
    this._shootTimer = this._scene.time.addEvent({
      delay: Math.round(1000 / rate),
      callback,
      callbackScope: this,
      loop: true,
    });
  }

  _startMovementFire() {
    this._startShootLoop(this._behavior.pathShootRate, this._fireMovingNext);
  }

  _beginIdle() {
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
      this._behavior.cycleMs,
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
    const ox = (this._rng() - 0.5) * 2 * this._behavior.driftX;
    const oy = (this._rng() - 0.5) * 2 * this._behavior.driftY;
    const dur = this._randInt(
      this._behavior.organicDurationMinMs,
      this._behavior.organicDurationMaxMs
    );
    const pause = this._randInt(
      this._behavior.organicPauseMinMs,
      this._behavior.organicPauseMaxMs
    );

    this._scene.tweens.add({
      targets: data.ship,
      x: data.slot.x + ox,
      y: data.slot.y + oy,
      duration: dur,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.tweens.add({
          targets: data.ship,
          x: data.slot.x,
          y: data.slot.y,
          duration: dur,
          ease: 'Sine.easeInOut',
          onComplete: () => {
            if (!data.drifting) return;
            this._scene.time.delayedCall(pause, () => this._idleMove(data));
          },
        });
      },
    });
  }

  _idleJink(data) {
    const dir = this._rng() < 0.5 ? -1 : 1;
    const ox = dir * this._behavior.abruptOffsetX * (0.65 + this._rng() * 0.35);
    const oy = (this._rng() - 0.5) * 2 * this._behavior.abruptOffsetY;
    const outMs = this._randInt(
      this._behavior.abruptDurationMinMs,
      this._behavior.abruptDurationMaxMs
    );
    const backMs = Math.max(50, Math.round(outMs * 0.9));
    const pause = this._randInt(
      this._behavior.abruptPauseMinMs,
      this._behavior.abruptPauseMaxMs
    );

    this._scene.tweens.add({
      targets: data.ship,
      x: data.slot.x + ox,
      y: data.slot.y + oy,
      duration: outMs,
      ease: 'Expo.easeOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.tweens.add({
          targets: data.ship,
          x: data.slot.x,
          y: data.slot.y,
          duration: backMs,
          ease: 'Quad.easeIn',
          onComplete: () => {
            if (!data.drifting) return;
            this._scene.time.delayedCall(pause, () => this._idleMove(data));
          },
        });
      },
    });
  }

  _fireMovingNext() {
    this._fireFromFleet((data) => !data.dead && data.ship.active && data.ship.y >= 20);
  }

  _fireNext() {
    this._fireFromFleet((data) => !data.dead && data.ship.active);
  }

  _fireFromFleet(predicate) {
    if (this._fleet.length === 0) return;

    let data = null;
    for (let tries = 0; tries < this._fleet.length; tries++) {
      const candidate = this._fleet[this._shootIdx];
      this._shootIdx = (this._shootIdx + 1) % this._fleet.length;
      if (candidate && predicate(candidate)) {
        data = candidate;
        break;
      }
    }

    if (!data) return;
    this._scene.tweens.add({
      targets: data.ship,
      alpha: 0.25,
      duration: 80,
      yoyo: true,
      repeat: 1,
    });

    this._scene.events.emit(EVENTS.ENEMY_FIRE, {
      x: data.ship.x,
      y: data.ship.y + 14,
      vx: 0,
      vy: 600,
      damage: data.ship.damage,
    });
  }

  _beginPattern() {
    const alive = this._fleet.filter(data => !data.dead);
    if (alive.length === 0) return;

    this._inIdle = false;
    this._startMovementFire();
    if (this._behavior.alternateSides) this._pathMirror = !this._pathMirror;

    const newSlots = calcFormationSlots(alive.length, this._behavior);
    alive.forEach((data, i) => {
      data.slot = newSlots[i];
      data.landed = false;
      data.motionStyle = this._pickMotionStyle();
      data.path = buildFormationPath(this._behavior, i, alive.length, this._pathMirror, this._rng);
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
      delay += this._behavior.launchStaggerMs;
    }
  }

  _reorganize() {
    const living = this._fleet.filter(data => !data.dead);
    if (living.length === 0) return;

    const newSlots = calcFormationSlots(living.length, this._behavior);
    living.forEach((data, i) => {
      data.slot = newSlots[i];
      data.drifting = false;
      this._scene.tweens.killTweensOf(data.ship);
      this._scene.tweens.add({
        targets: data.ship,
        x: data.slot.x,
        y: data.slot.y,
        duration: this._behavior.reformMs,
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
    }
  }
}
