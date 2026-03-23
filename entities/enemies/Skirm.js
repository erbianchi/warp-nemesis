/** @module Skirm */

import { EnemyBase }    from '../EnemyBase.js';
import { EVENTS }       from '../../config/events.config.js';
import { GAME_CONFIG }  from '../../config/game.config.js';

const { WIDTH: W, HEIGHT: H } = GAME_CONFIG;

/**
 * Skirm — basic enemy unit.
 *
 * Each dance is a full tween-driven behavior with its own personality.
 *
 * Dances:
 *   straight    — loop across the screen, settle into formation, drift+shoot, dive at player
 *   sweep_left  — arc in from top-right, curve left across screen, shoot, exit left
 *   sweep_right — arc in from top-left, curve right across screen, shoot, exit right
 *   zigzag      — enter from top, tween left/right in sharp zigzags while descending, shoot
 *   drift_drop  — organic wandering descent with random lateral drift
 *   jink_drop   — abrupt lateral snaps while descending
 *   whirl       — enter, then orbit a local center in a symmetric on-screen loop
 *   hourglass   — enter, then weave a mirrored hourglass loop while holding screen space
 *   side_cross  — enter from one side, arc across to other side, brief hover, dive at player
 *   fan_out     — enter clustered, spread outward, hold + shoot, all converge and dive
 */
export class Skirm extends EnemyBase {
  constructor(scene, x, y, stats, dance = 'straight') {
    super(scene, x, y, 'skirm', stats, dance);
  }

  setupMovement() {
    this.body.setVelocity(0, 0);
    switch (this.dance) {
      case 'straight':
        // FormationController takes over; nothing to do here
        break;
      case 'sweep_left':  this._danceSweep(-1);   break;
      case 'sweep_right': this._danceSweep(1);    break;
      case 'zigzag':      this._danceZigzag();    break;
      case 'drift_drop':  this._danceDriftDrop(); break;
      case 'jink_drop':   this._danceJinkDrop();  break;
      case 'whirl':       this._danceWhirl();     break;
      case 'hourglass':   this._danceHourglass(); break;
      case 'side_cross':  this._danceSideCross(); break;
      case 'fan_out':     this._danceFanOut();    break;
      default:            break;
    }
  }

  setupWeapon() {}

  fire() {
    this.scene.events.emit(EVENTS.ENEMY_FIRE, {
      x:      this.x,
      y:      this.y + 12,
      vx:     0,
      vy:     this.bulletSpeed,
      damage: this.damage,
    });
  }

  // ── Dances ──────────────────────────────────────────────────────────────────

  /**
   * sweep_left / sweep_right — arc in from top, curve across the screen,
   * shoot while moving, exit off the opposite side.
   * dir: -1 = sweep left, 1 = sweep right
   */
  _danceSweep(dir) {
    const scene = this.scene;
    const midX  = dir === 1 ? W * 0.68 + Math.random() * 40 : W * 0.28 - Math.random() * 40;
    const midY  = H * 0.38 + Math.random() * H * 0.16;
    const exitX = dir === 1 ? W + 70 : -70;
    const exitY = midY + 60 + Math.random() * 80;

    scene.tweens.add({
      targets:  this,
      x: midX, y: midY,
      duration: 1100,
      ease:     'Sine.easeOut',
      onComplete: () => {
        if (!this.alive) return;
        scene.tweens.add({
          targets:  this,
          x: exitX, y: exitY,
          duration: 900,
          ease:     'Sine.easeIn',
          onComplete: () => this._exitSilent(),
        });
      },
    });
  }

  /**
   * zigzag — enter from top, tween sharp left/right zigzags while descending,
   * shoot at each direction reversal.
   */
  _danceZigzag() {
    const scene = this.scene;

    const zig = (x, y, dir) => {
      if (!this.alive) return;
      if (y > H + 40) { this._exitSilent(); return; }

      const nx = Phaser.Math.Clamp(x + dir * (70 + Math.random() * 50), 30, W - 30);
      const ny = y + 70 + Math.random() * 50;

      scene.tweens.add({
        targets:  this,
        x: nx, y: ny,
        duration: 350 + Math.random() * 150,
        ease:     'Sine.easeInOut',
        onComplete: () => zig(nx, ny, -dir),
      });
    };

    zig(this.x, this.y, Math.random() > 0.5 ? 1 : -1);
  }

  /**
   * drift_drop — softly wander down the screen, choosing a fresh random lane
   * each step so the squadron feels organic and slightly different every run.
   */
  _danceDriftDrop() {
    const scene = this.scene;

    const drift = (x, y) => {
      if (!this.alive) return;
      if (y > H + 40) { this._exitSilent(); return; }

      const nx = Phaser.Math.Clamp(x + (Math.random() - 0.5) * 120, 35, W - 35);
      const ny = y + 55 + Math.random() * 65;

      scene.tweens.add({
        targets:  this,
        x: nx, y: ny,
        duration: 420 + Math.random() * 260,
        ease:     'Sine.easeInOut',
        onComplete: () => drift(nx, ny),
      });
    };

    drift(this.x, this.y);
  }

  /**
   * jink_drop — short, abrupt horizontal snaps with quick downward steps.
   * Reads more aggressive than zigzag and works well as a flanker.
   */
  _danceJinkDrop() {
    const scene = this.scene;

    const jink = (x, y, dir) => {
      if (!this.alive) return;
      if (y > H + 40) { this._exitSilent(); return; }

      const stepX = 48 + Math.random() * 42;
      const nx = Phaser.Math.Clamp(x + dir * stepX, 28, W - 28);
      const ny = y + 38 + Math.random() * 38;
      const nextDir = nx <= 40 ? 1 : nx >= W - 40 ? -1 : -dir;

      scene.tweens.add({
        targets:  this,
        x: nx, y: ny,
        duration: 120 + Math.random() * 80,
        ease:     'Expo.easeOut',
        onComplete: () => {
          if (!this.alive) return;
          scene.time.delayedCall(
            45 + Math.random() * 80,
            () => jink(nx, ny, nextDir)
          );
        },
      });
    };

    jink(this.x, this.y, Math.random() > 0.5 ? 1 : -1);
  }

  /**
   * whirl — enter the arena, then orbit a local center forever in a
   * balanced four-point loop. Direction can flip per ship so the wave still
   * feels organic while remaining highly readable and symmetrical.
   */
  _danceWhirl() {
    const centerX = Phaser.Math.Clamp(this.x, 90, W - 90);
    const centerY = H * 0.26 + Math.random() * H * 0.10;
    const radiusX = 44 + Math.random() * 18;
    const radiusY = 34 + Math.random() * 14;
    const clockwise = Math.random() > 0.5;
    const orbitPoints = clockwise
      ? [
          { x: centerX + radiusX, y: centerY,           duration: 300 },
          { x: centerX,           y: centerY + radiusY, duration: 320 },
          { x: centerX - radiusX, y: centerY,           duration: 300 },
          { x: centerX,           y: centerY - radiusY, duration: 320 },
        ]
      : [
          { x: centerX - radiusX, y: centerY,           duration: 300 },
          { x: centerX,           y: centerY + radiusY, duration: 320 },
          { x: centerX + radiusX, y: centerY,           duration: 300 },
          { x: centerX,           y: centerY - radiusY, duration: 320 },
        ];

    this._enterAndLoop(
      { x: centerX, y: centerY - radiusY },
      orbitPoints,
      { enterDuration: 760, enterEase: 'Sine.easeOut' }
    );
  }

  /**
   * hourglass — move into position, then sweep through mirrored diagonal
   * crossings around a center anchor. This holds the enemy on screen and keeps
   * its threat pattern visibly symmetric.
   */
  _danceHourglass() {
    const centerX = Phaser.Math.Clamp(this.x, 96, W - 96);
    const centerY = H * 0.30 + Math.random() * H * 0.10;
    const spanX = Math.min(74, centerX - 34, W - 34 - centerX);
    const spanY = 42 + Math.random() * 16;
    const loopPoints = [
      { x: centerX - spanX, y: centerY - spanY, duration: 300 },
      { x: centerX + spanX, y: centerY + spanY, duration: 360 },
      { x: centerX + spanX, y: centerY - spanY, duration: 300 },
      { x: centerX - spanX, y: centerY + spanY, duration: 360 },
      { x: centerX,         y: centerY,         duration: 260 },
    ];

    this._enterAndLoop(
      { x: centerX, y: centerY },
      loopPoints,
      { enterDuration: 700, enterEase: 'Sine.easeOut' }
    );
  }

  /**
   * side_cross — enter from one side, arc across to mid-screen,
   * brief hover, then dive toward the player.
   */
  _danceSideCross() {
    const scene    = this.scene;
    const midX     = W * 0.35 + Math.random() * W * 0.30;
    const midY     = H * 0.28 + Math.random() * H * 0.18;
    const hoverMs  = 500 + Math.random() * 400;

    scene.tweens.add({
      targets:  this,
      x: midX, y: midY,
      duration: 1000,
      ease:     'Sine.easeOut',
      onComplete: () => {
        if (!this.alive) return;
        // brief hover drift
        const hx = Phaser.Math.Clamp(midX + (Math.random() - 0.5) * 40, 40, W - 40);
        scene.tweens.add({
          targets:  this,
          x: hx, y: midY + (Math.random() - 0.5) * 20,
          duration: hoverMs,
          ease:     'Sine.easeInOut',
          onComplete: () => {
            if (!this.alive) return;
            const player = scene._player;
            const tx = player
              ? Phaser.Math.Clamp(player.x + (Math.random() - 0.5) * 60, 30, W - 30)
              : midX;
            scene.tweens.add({
              targets:  this,
              x: tx, y: H + 80,
              duration: 1000,
              ease:     'Cubic.easeIn',
              onComplete: () => this._exitSilent(),
            });
          },
        });
      },
    });
  }

  /**
   * fan_out — enter from spawn position, fan outward to a spread position,
   * hold and shoot, then all converge and dive at the player.
   */
  _danceFanOut() {
    const scene   = this.scene;
    const spreadX = Phaser.Math.Clamp(this.x + (Math.random() - 0.5) * W * 0.65, 40, W - 40);
    const spreadY = H * 0.14 + Math.random() * H * 0.14;
    const holdMs  = 900 + Math.random() * 500;

    scene.tweens.add({
      targets:  this,
      x: spreadX, y: spreadY,
      duration: 750,
      ease:     'Sine.easeOut',
      onComplete: () => {
        if (!this.alive) return;
        // slight drift while holding
        scene.tweens.add({
          targets:  this,
          x: spreadX + (Math.random() - 0.5) * 30,
          y: spreadY + (Math.random() - 0.5) * 15,
          duration: holdMs,
          ease:     'Sine.easeInOut',
          onComplete: () => {
            if (!this.alive) return;
            const player = scene._player;
            const tx = player
              ? Phaser.Math.Clamp(player.x + (Math.random() - 0.5) * 70, 30, W - 30)
              : spreadX;
            scene.tweens.add({
              targets:  this,
              x: tx, y: H + 80,
              duration: 950,
              ease:     'Cubic.easeIn',
              onComplete: () => this._exitSilent(),
            });
          },
        });
      },
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Enter the play space once, then repeat a looping tween pattern while
   * staying on screen until the player destroys the ship.
   * @param {{x: number, y: number}} entryTarget
   * @param {Array<{x: number, y: number, duration?: number, ease?: string, pauseMs?: number}>} loopPoints
   * @param {{enterDuration?: number, enterEase?: string}} [opts]
   */
  _enterAndLoop(entryTarget, loopPoints, opts = {}) {
    const scene = this.scene;
    const runStep = (index = 0) => {
      if (!this.alive) return;
      const step = loopPoints[index % loopPoints.length];
      scene.tweens.add({
        targets:  this,
        x:        step.x,
        y:        step.y,
        duration: step.duration ?? 320,
        ease:     step.ease ?? 'Sine.easeInOut',
        onComplete: () => {
          if (!this.alive) return;
          const pauseMs = step.pauseMs ?? 0;
          if (pauseMs > 0) {
            scene.time.delayedCall(pauseMs, () => runStep(index + 1));
            return;
          }
          runStep(index + 1);
        },
      });
    };

    scene.tweens.add({
      targets:  this,
      x:        entryTarget.x,
      y:        entryTarget.y,
      duration: opts.enterDuration ?? 720,
      ease:     opts.enterEase ?? 'Sine.easeOut',
      onComplete: () => runStep(0),
    });
  }

  /** Remove this enemy silently (off-screen exit — no score). */
  _exitSilent() {
    if (!this.alive) return;
    this.alive = false;
    this.setActive(false).setVisible(false);
    if (this.body) this.body.enable = false;
    this.destroy();
  }
}
