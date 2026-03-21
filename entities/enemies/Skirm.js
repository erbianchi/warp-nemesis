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
   * side_cross — enter from one side, arc across to mid-screen,
   * brief hover, then dive toward the player.
   */
  _danceSideCross() {
    const scene    = this.scene;
    const fromLeft = this.x < 0;
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

  /** Remove this enemy silently (off-screen exit — no score). */
  _exitSilent() {
    if (!this.alive) return;
    this.alive = false;
    this.setActive(false).setVisible(false);
    if (this.body) this.body.enable = false;
    this.destroy();
  }
}
