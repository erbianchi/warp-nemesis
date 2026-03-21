/** @module FormationController
 * Drives the "straight" (formation) dance.
 * Ported directly from the original static GameScene formation system.
 *
 * Behaviour:
 *   1. All ships start at center-top and fly the LOOP_PATH together (staggered).
 *   2. Each ship breaks off to its formation slot when the loop ends.
 *   3. Idle phase: ships jab/drift around their slots; the squadron cycles through
 *      ships firing bullets one at a time.
 *   4. After FORMATION_CYCLE_MS, the pattern phase kicks in: all ships re-fly the
 *      loop and reform with recalculated slots (adapts to deaths).
 *   5. Deaths during idle trigger a reorganisation. Deaths mid-flight keep the
 *      landing counter consistent so the state machine never stalls.
 */

import { EVENTS }      from '../config/events.config.js';
import { GAME_CONFIG } from '../config/game.config.js';

const { WIDTH, HEIGHT } = GAME_CONFIG;

export const LOOP_PATH = [
  { x: 240, y: 160, dur: 500 },
  { x: 80,  y: 300, dur: 700 },
  { x: 65,  y: 490, dur: 650 },
  { x: 220, y: 560, dur: 550 },
  { x: 400, y: 510, dur: 600 },
  { x: 450, y: 290, dur: 600 },
  { x: 320, y: 75,  dur: 500 },
];

export const FORMATION_CYCLE_MS   = 10000; // ms in idle before re-running the pattern
export const FORMATION_SHOOT_RATE = 2;     // shots per second for the whole squadron
export const FORMATION_SPEED      = 1;     // speed tier (1–5)
export const SQUADRON_SHIP_LIFE   = 10;    // base HP per ship in a formation squadron
export const DRIFT_RANGE_X        = 30;
export const DRIFT_RANGE_Y        = 5;

/** Compute centred two-row formation slots for N ships. */
export function calcFormationSlots(count) {
  const SPACING_X = 60;
  const ROW_YS    = [65, 110];
  const slots     = [];
  const row2      = Math.floor(count / 2);
  const row1      = count - row2;
  for (const [n, y] of [[row1, ROW_YS[0]], [row2, ROW_YS[1]]]) {
    if (n === 0) continue;
    const startX = (WIDTH - (n - 1) * SPACING_X) / 2;
    for (let col = 0; col < n; col++) slots.push({ x: startX + col * SPACING_X, y });
  }
  return slots;
}

/** Initial 2×4 slots for a full 8-ship squadron. */
export const SLOTS = calcFormationSlots(8);

export class FormationController {
  /**
   * @param {Phaser.Scene} scene
   * @param {EnemyBase[]}  ships  - All ships in this squadron (already in scene)
   */
  constructor(scene, ships) {
    this._scene      = scene;
    this._fleet      = [];
    this._landed     = 0;
    this._shootIdx   = 0;
    this._shootTimer = null;
    this._cycleTimer = null;
    this._inIdle     = false;

    const slots = calcFormationSlots(ships.length);

    ships.forEach((ship, i) => {
      // Teleport all ships to center-top (matching the original spawn point)
      ship.x = WIDTH / 2;
      ship.y = -30;
      if (ship.body) ship.body.reset(WIDTH / 2, -30);

      const data = {
        ship,
        slot:     slots[i] ?? { x: WIDTH / 2, y: 65 },
        speed:    1,
        drifting: false,
        dead:     false,
        landed:   false,
      };
      this._fleet.push(data);

      // Hook into the ship's death so we can reorganise / recount
      const origOnDeath = ship.onDeath.bind(ship);
      ship.onDeath = () => {
        origOnDeath();
        data.dead     = true;
        data.drifting = false;
        scene.tweens.killTweensOf(ship);
        if (this._inIdle) {
          this._reorganize();
        } else if (!data.landed) {
          // Killed mid-flight: tick the counter to keep state machine moving
          this._onLanded();
        }
      };
    });

    // Stagger launch: one ship every 200 ms (matches original)
    this._fleet.forEach((data, i) => {
      scene.time.delayedCall(i * 200, () => this._runPath(data));
    });
  }

  // ── Path / arrival ────────────────────────────────────────────────────────

  _runPath(data) {
    if (data.dead) { this._onLanded(); return; }
    this._chainStep(data.ship, LOOP_PATH, 0, data.speed, () => {
      this._scene.tweens.add({
        targets:    data.ship,
        x:          data.slot.x,
        y:          data.slot.y,
        duration:   380 / data.speed,
        ease:       'Cubic.easeOut',
        onComplete: () => { data.landed = true; this._onLanded(); },
      });
    });
  }

  _chainStep(ship, steps, idx, speed, onDone) {
    if (idx >= steps.length) { onDone(); return; }
    const { x, y, dur } = steps[idx];
    this._scene.tweens.add({
      targets:    ship,
      x, y,
      duration:   dur / speed,
      ease:       'Sine.easeInOut',
      onComplete: () => this._chainStep(ship, steps, idx + 1, speed, onDone),
    });
  }

  _onLanded() {
    this._landed++;
    if (this._landed < this._fleet.length) return;
    const alive = this._fleet.filter(d => !d.dead).length;
    if (alive > 0) this._beginIdle();
  }

  // ── Idle (drift + shoot) ──────────────────────────────────────────────────

  _beginIdle() {
    this._inIdle = true;
    for (const data of this._fleet) {
      if (data.dead) continue;
      data.drifting = true;
      this._idleDrift(data);
    }

    if (this._shootTimer) this._shootTimer.remove();
    this._shootTimer = this._scene.time.addEvent({
      delay:         Math.round(1000 / FORMATION_SHOOT_RATE),
      callback:      this._fireNext,
      callbackScope: this,
      loop:          true,
    });

    this._cycleTimer = this._scene.time.delayedCall(
      FORMATION_CYCLE_MS,
      () => this._beginPattern()
    );
  }

  _idleDrift(data) {
    if (!data.drifting) return;
    const sign = Math.random() < 0.5 ? -1 : 1;
    const ox   = sign * DRIFT_RANGE_X * (0.7 + Math.random() * 0.3);
    const oy   = (Math.random() - 0.5) * 2 * DRIFT_RANGE_Y;
    const dur  = Math.round((120 + Math.random() * 100) / data.speed);

    this._scene.tweens.add({
      targets:    data.ship,
      x:          data.slot.x + ox,
      y:          data.slot.y + oy,
      duration:   dur,
      ease:       'Cubic.easeOut',
      onComplete: () => {
        if (!data.drifting) return;
        this._scene.tweens.add({
          targets:    data.ship,
          x:          data.slot.x,
          y:          data.slot.y,
          duration:   dur,
          ease:       'Cubic.easeIn',
          onComplete: () => {
            if (!data.drifting) return;
            this._scene.time.delayedCall(
              Math.round(80 + Math.random() * 180),
              () => this._idleDrift(data)
            );
          },
        });
      },
    });
  }

  _fireNext() {
    const data = this._fleet[this._shootIdx];
    this._shootIdx = (this._shootIdx + 1) % this._fleet.length;
    if (!data || data.dead || !data.ship.active) return;

    this._scene.tweens.add({
      targets: data.ship, alpha: 0.25, duration: 80, yoyo: true, repeat: 1,
    });

    this._scene.events.emit(EVENTS.ENEMY_FIRE, {
      x:      data.ship.x,
      y:      data.ship.y + 14,
      vx:     0,
      vy:     600,
      damage: data.ship.damage,
    });
  }

  // ── Pattern run (loop + reform) ───────────────────────────────────────────

  _beginPattern() {
    const alive = this._fleet.filter(d => !d.dead);
    if (alive.length === 0) return;

    this._inIdle = false;
    if (this._shootTimer) { this._shootTimer.remove(); this._shootTimer = null; }

    const newSlots = calcFormationSlots(alive.length);
    alive.forEach((data, i) => { data.slot = newSlots[i]; data.landed = false; });

    for (const data of this._fleet) {
      data.drifting = false;
      if (!data.dead) this._scene.tweens.killTweensOf(data.ship);
    }

    this._landed = 0;
    let delay = 0;
    for (const data of this._fleet) {
      if (data.dead) { this._landed++; continue; }
      this._scene.time.delayedCall(delay, () => this._runPath(data));
      delay += 200;
    }
  }

  _reorganize() {
    const living = this._fleet.filter(d => !d.dead);
    if (living.length === 0) return;

    const newSlots = calcFormationSlots(living.length);
    living.forEach((data, i) => {
      data.slot     = newSlots[i];
      data.drifting = false;
      this._scene.tweens.killTweensOf(data.ship);
      this._scene.tweens.add({
        targets:    data.ship,
        x:          data.slot.x,
        y:          data.slot.y,
        duration:   350,
        ease:       'Cubic.easeOut',
        onComplete: () => {
          if (data.dead) return;
          data.drifting = true;
          this._idleDrift(data);
        },
      });
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /** Stop all timers and tweens (call on game over). */
  stop() {
    if (this._shootTimer) { this._shootTimer.remove(); this._shootTimer = null; }
    if (this._cycleTimer) { this._cycleTimer.remove(); this._cycleTimer = null; }
    for (const data of this._fleet) {
      data.drifting = false;
      if (!data.dead && data.ship.active) {
        this._scene.tweens.killTweensOf(data.ship);
      }
    }
  }
}
