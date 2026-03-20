/** @module GameScene
 * Core game loop — orchestrator only.
 * Phase 1: starfield + moveable player rectangle + weapon slot display. */

import { GAME_CONFIG } from '../config/game.config.js';
import { ScrollingBackground } from '../systems/ScrollingBackground.js';
import { WeaponManager } from '../weapons/WeaponManager.js';
import { RunState } from '../systems/RunState.js';

const { WIDTH, HEIGHT, PLAYER_SPEED, PLAYER_SPEED_DEFAULT, PLAYER_LIFE_DEFAULT } = GAME_CONFIG;

/** Waypoints (x, y, dur ms) every ship follows before breaking to its slot. */
export const LOOP_PATH = [
  { x: 240, y: 160, dur: 500 },
  { x: 80,  y: 300, dur: 700 },
  { x: 65,  y: 490, dur: 650 },
  { x: 220, y: 560, dur: 550 },
  { x: 400, y: 510, dur: 600 },
  { x: 450, y: 290, dur: 600 },
  { x: 320, y: 75,  dur: 500 },
];

/** Initial 2×4 arrival slots, filled right-to-left (ships exit the loop on the right). */
export const SLOTS = [
  { x: 330, y: 65  }, { x: 270, y: 65  }, { x: 210, y: 65  }, { x: 150, y: 65  },
  { x: 330, y: 110 }, { x: 270, y: 110 }, { x: 210, y: 110 }, { x: 150, y: 110 },
];

/**
 * Calculate centered two-row formation slots for N living ships.
 * Splits ships as evenly as possible between the two rows.
 * @param {number} count
 * @returns {Array<{x: number, y: number}>}
 */
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

export const SQUADRON_SHIP_LIFE   = 10;    // HP per ship in this squadron
export const FORMATION_SPEED      = 1;     // speed tier (1–5) for this squadron
export const FORMATION_CYCLE_MS   = 10000; // ms in idle before repeating the pattern
export const FORMATION_SHOOT_RATE = 2;     // shots per second for the whole squadron
export const DRIFT_RANGE_X        = 30;    // max horizontal jab distance from slot (px)
export const DRIFT_RANGE_Y        = 5;     // max vertical offset during jab (px)

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    this._bg      = new ScrollingBackground(this);
    this._player  = this._createPlayer();
    this._weapons = new WeaponManager(this);
    this._cursors = this.input.keyboard.createCursorKeys();
    this._wasd    = this._createWASD();
    this._space   = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    this._playerSpeed = PLAYER_SPEED_DEFAULT;
    this._playerLife  = PLAYER_LIFE_DEFAULT;
    this._gameOver    = false;

    RunState.reset();

    this._buildWeaponDisplay();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('MenuScene'));

    // Spawn enemy formation 3 seconds after the game starts
    this.time.delayedCall(3000, () => this._spawnFormation());
  }

  update(_time, delta) {
    if (this._gameOver) return;

    this._bg.update(delta);
    this._movePlayer();
    this._weapons.update(delta);
    if (this._space.isDown) {
      this._weapons.tryFire(this._player.x, this._player.y);
    }

    // Move enemy bullets (tween-driven) and check AABB collision with player
    if (this._eBullets) {
      const px = this._player.x, py = this._player.y;
      for (let i = this._eBullets.length - 1; i >= 0; i--) {
        const b = this._eBullets[i];
        if (!b.active) { this._eBullets.splice(i, 1); continue; }
        if (b.y > HEIGHT + 20) { b.destroy(); this._eBullets.splice(i, 1); continue; }
        // Simple AABB: bullet 3×10, player 28×36
        if (Math.abs(b.x - px) < 15.5 && Math.abs(b.y - py) < 23) {
          b.destroy();
          this._eBullets.splice(i, 1);
          this._onEnemyBulletHit();
        }
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** @returns {Phaser.GameObjects.Rectangle} Physics-enabled player rectangle. */
  _createPlayer() {
    const player = this.add.rectangle(WIDTH / 2, HEIGHT - 80, 28, 36, 0x00ff88);
    this.physics.add.existing(player);
    player.body.setCollideWorldBounds(true);
    return player;
  }

  /** @returns {object} WASD key set. */
  _createWASD() {
    return this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
  }

  /**
   * Draw static weapon slot boxes in the bottom-left corner.
   * Re-call whenever the loadout changes (future phases).
   */
  _buildWeaponDisplay() {
    const BOX_W = 62;
    const BOX_H = 38;
    const GAP   = 6;
    const X0    = 8;
    const Y0    = HEIGHT - BOX_H - 8;

    const gfx = this.add.graphics();

    this._weapons.getSlots().forEach((slot, i) => {
      const x      = X0 + i * (BOX_W + GAP);
      const filled = slot !== null;
      const border = filled ? slot.color : 0x2a2a2a;
      const bg     = filled ? 0x001428  : 0x080808;
      const css    = filled ? `#${slot.color.toString(16).padStart(6, '0')}` : '#2a2a2a';

      gfx.fillStyle(bg, 1);
      gfx.fillRect(x, Y0, BOX_W, BOX_H);
      gfx.lineStyle(1, border, 1);
      gfx.strokeRect(x, Y0, BOX_W, BOX_H);

      // Slot number — top-left
      this.add.text(x + 4, Y0 + 3, `${i + 1}`, {
        fontSize: '9px', fill: filled ? '#aaaaaa' : '#333333', fontFamily: 'monospace',
      });

      // Weapon name — centered
      this.add.text(x + BOX_W / 2, Y0 + BOX_H / 2 + 3, filled ? slot.name : '----', {
        fontSize: '11px', fill: css, fontFamily: 'monospace',
      }).setOrigin(0.5);
    });
  }

  /** Read input, set velocity, normalise diagonals. */
  _movePlayer() {
    const body  = this._player.body;
    const c     = this._cursors;
    const w     = this._wasd;

    const left  = c.left.isDown  || w.left.isDown;
    const right = c.right.isDown || w.right.isDown;
    const up    = c.up.isDown    || w.up.isDown;
    const down  = c.down.isDown  || w.down.isDown;

    const spd = PLAYER_SPEED * this._playerSpeed;
    body.setVelocity(0);
    if (left)  body.setVelocityX(-spd);
    if (right) body.setVelocityX(spd);
    if (up)    body.setVelocityY(-spd);
    if (down)  body.setVelocityY(spd);

    if ((left || right) && (up || down)) {
      body.velocity.normalize().scale(PLAYER_SPEED);
    }
  }

  // ---------------------------------------------------------------------------
  // Enemy formation sequence
  // State machine: arrive → idle (drift + shoot) ⟲ pattern → idle
  // ---------------------------------------------------------------------------

  /**
   * Spawn 8 ships that fly in from off-screen, align, then enter the idle/pattern loop.
   * Each ship carries { ship, slot, speed, life, drifting, dead }.
   */
  _spawnFormation() {
    this._fFleet       = [];
    this._fLanded      = 0;
    this._fShootIndex  = 0;
    this._fShootTimer  = null;
    this._fCycleTimer  = null;
    this._fInIdle      = false;
    this._eBullets     = [];

    // Physics group used for player-bullet overlap detection
    this._fGroup = this.physics.add.group();

    for (let i = 0; i < 8; i++) {
      const ship = this.add.rectangle(WIDTH / 2, -30, 24, 20, 0xdd2211).setDepth(10);
      this.physics.add.existing(ship);  // attach arcade body for overlap checks
      this._fGroup.add(ship);

      const data = {
        ship,
        slot:     SLOTS[i],
        speed:    FORMATION_SPEED,
        life:     SQUADRON_SHIP_LIFE,
        drifting: false,
        dead:     false,
        landed:   false,   // true once the ship has reached its slot
      };
      this._fFleet.push(data);
      this.time.delayedCall(i * 200, () => this._fRunPath(data));
    }

    // Player bullets vs formation ships
    this.physics.add.overlap(
      this._weapons.pool,
      this._fGroup,
      this._fOnBulletHit,
      null,
      this
    );

  }

  /**
   * Send a ship through LOOP_PATH (speed-scaled), then tween it to its slot.
   * Dead ships are counted as already landed so the cycle counter stays correct.
   * @param {{ ship, slot: {x,y}, speed: number, life: number, drifting: boolean, dead: boolean }} data
   */
  _fRunPath(data) {
    if (data.dead) { this._fOnLanded(); return; }

    this._fChainStep(data.ship, LOOP_PATH, 0, data.speed, () => {
      this.tweens.add({
        targets:    data.ship,
        x:          data.slot.x,
        y:          data.slot.y,
        duration:   380 / data.speed,
        ease:       'Cubic.easeOut',
        onComplete: () => { data.landed = true; this._fOnLanded(); },
      });
    });
  }

  /**
   * Recursively chain waypoint tweens, scaling each duration by speed.
   * @param {Phaser.GameObjects.Rectangle} ship
   * @param {Array<{x,y,dur}>} steps
   * @param {number} idx
   * @param {number} speed
   * @param {Function} onDone
   */
  _fChainStep(ship, steps, idx, speed, onDone) {
    if (idx >= steps.length) { onDone(); return; }
    const { x, y, dur } = steps[idx];
    this.tweens.add({
      targets:    ship,
      x, y,
      duration:   dur / speed,
      ease:       'Sine.easeInOut',
      onComplete: () => this._fChainStep(ship, steps, idx + 1, speed, onDone),
    });
  }

  /** Count landings; once all fleet entries are accounted for, enter idle (if any alive). */
  _fOnLanded() {
    this._fLanded++;
    if (this._fLanded < this._fFleet.length) return;
    const alive = this._fFleet.filter(d => !d.dead).length;
    if (alive > 0) this._fBeginIdle();
  }

  /**
   * Idle phase: every ship drifts randomly around its slot,
   * the squadron shoots, and a timer schedules the next pattern run.
   */
  _fBeginIdle() {
    this._fInIdle = true;
    for (const data of this._fFleet) {
      if (data.dead) continue;
      data.drifting = true;
      this._fIdleDrift(data);
    }

    // (Re)start shoot loop — interval driven by squadron shoot rate
    if (this._fShootTimer) this._fShootTimer.remove();
    this._fShootTimer = this.time.addEvent({
      delay:         Math.round(1000 / FORMATION_SHOOT_RATE),
      callback:      this._fFireNext,
      callbackScope: this,
      loop:          true,
    });

    // Schedule the next pattern run
    this._fCycleTimer = this.time.delayedCall(FORMATION_CYCLE_MS, () => this._fBeginPattern());
  }

  /**
   * Jab the ship to one side, snap it back to its slot, pause, repeat.
   * Movement is fast and abrupt (Cubic ease) with a strong horizontal bias.
   * Stops when data.drifting is set to false.
   * @param {{ ship, slot, speed, drifting }} data
   */
  _fIdleDrift(data) {
    if (!data.drifting) return;

    const sign = Math.random() < 0.5 ? -1 : 1;
    const ox   = sign * DRIFT_RANGE_X * (0.7 + Math.random() * 0.3);
    const oy   = (Math.random() - 0.5) * 2 * DRIFT_RANGE_Y;
    const dur  = Math.round((120 + Math.random() * 100) / data.speed);

    // Snap to side
    this.tweens.add({
      targets:    data.ship,
      x:          data.slot.x + ox,
      y:          data.slot.y + oy,
      duration:   dur,
      ease:       'Cubic.easeOut',
      onComplete: () => {
        if (!data.drifting) return;
        // Snap back to slot centre
        this.tweens.add({
          targets:    data.ship,
          x:          data.slot.x,
          y:          data.slot.y,
          duration:   dur,
          ease:       'Cubic.easeIn',
          onComplete: () => {
            if (!data.drifting) return;
            // Short pause before next jab
            this.time.delayedCall(
              Math.round(80 + Math.random() * 180),
              () => this._fIdleDrift(data)
            );
          },
        });
      },
    });
  }

  /**
   * Pattern phase: stop drift and shooting, then stagger all ships back through
   * LOOP_PATH. Landing completes will trigger _fBeginIdle again, looping forever.
   * Stops cleanly if the entire squadron has been destroyed.
   */
  _fBeginPattern() {
    const alive = this._fFleet.filter(d => !d.dead);
    if (alive.length === 0) return;

    this._fInIdle = false;
    if (this._fShootTimer) { this._fShootTimer.remove(); this._fShootTimer = null; }

    // Reassign slots for the current living count before launching
    const newSlots = calcFormationSlots(alive.length);
    alive.forEach((data, i) => { data.slot = newSlots[i]; data.landed = false; });

    for (const data of this._fFleet) {
      data.drifting = false;
      if (!data.dead) this.tweens.killTweensOf(data.ship);
    }

    this._fLanded = 0;
    let delay = 0;
    for (const data of this._fFleet) {
      // Dead ships count immediately; living ships launch with stagger
      if (data.dead) { this._fLanded++; continue; }
      this.time.delayedCall(delay, () => this._fRunPath(data));
      delay += 200;
    }
  }

  /**
   * Called by Phaser's overlap system when a player bullet hits a formation ship.
   * Recycles the bullet and applies weapon damage; destroys the ship at 0 HP.
   * @param {Phaser.Physics.Arcade.Image} bullet
   * @param {Phaser.GameObjects.Rectangle} ship
   */
  _fOnBulletHit(bullet, ship) {
    this._weapons.pool.killAndHide(bullet);
    if (bullet.body) bullet.body.stop();

    const data = this._fFleet.find(d => d.ship === ship);
    if (!data || data.dead) return;

    data.life -= this._weapons.damage;
    if (data.life <= 0) {
      data.dead     = true;
      data.drifting = false;
      this.tweens.killTweensOf(ship);
      this._explode(ship.x, ship.y);
      RunState.addScore(SQUADRON_SHIP_LIFE);
      ship.destroy();
      if (this._fInIdle) {
        this._fReorganize();
      } else if (!data.landed) {
        // Killed mid-flight — the slot tween's onComplete will never fire,
        // so manually tick the landing counter to keep the state machine moving.
        this._fOnLanded();
      }
    }
  }

  /**
   * Tween surviving fleet members to recalculated centered slots, then resume drift.
   * Only called during idle phase.
   */
  _fReorganize() {
    const living = this._fFleet.filter(d => !d.dead);
    if (living.length === 0) return;

    const newSlots = calcFormationSlots(living.length);
    living.forEach((data, i) => {
      data.slot     = newSlots[i];
      data.drifting = false;
      this.tweens.killTweensOf(data.ship);
      this.tweens.add({
        targets:    data.ship,
        x:          data.slot.x,
        y:          data.slot.y,
        duration:   350,
        ease:       'Cubic.easeOut',
        onComplete: () => {
          if (data.dead) return;
          data.drifting = true;
          this._fIdleDrift(data);
        },
      });
    });
  }

  /**
   * Called when an enemy bullet hits the player.
   * Applies weapon damage; triggers _killPlayer at 0 HP.
   */
  _onEnemyBulletHit() {
    if (this._gameOver) return;
    this._playerLife -= this._weapons.damage;
    if (this._playerLife <= 0) this._killPlayer();
  }

  /** Freeze the world, explode the player ship, and show the game-over overlay. */
  _killPlayer() {
    if (this._gameOver) return;
    this._gameOver = true;

    this._explode(this._player.x, this._player.y);
    this._player.setVisible(false);
    if (this._player.body) this._player.body.enable = false;

    // Stop all formation activity
    if (this._fShootTimer) { this._fShootTimer.remove(); this._fShootTimer = null; }
    if (this._fCycleTimer) { this._fCycleTimer.remove(); this._fCycleTimer = null; }
    for (const data of this._fFleet ?? []) {
      data.drifting = false;
      if (!data.dead) this.tweens.killTweensOf(data.ship);
    }

    // Pause physics so nothing moves (background stops via _gameOver flag in update)
    this.physics.pause();

    // Overlay — rendered above everything; particles continue independently
    this.add.text(WIDTH / 2, HEIGHT / 2 - 30, 'GAME OVER', {
      fontSize: '42px', fill: '#ff2222', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);

    this.add.text(WIDTH / 2, HEIGHT / 2 + 30, `SCORE  ${RunState.score}`, {
      fontSize: '20px', fill: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(20);
  }

  /**
   * Spawn a one-shot particle burst at (x, y).
   * Uses Phaser 3.60+ ParticleEmitter API.
   * @param {number} x
   * @param {number} y
   */
  _explode(x, y) {
    const emitter = this.add.particles(x, y, 'particle', {
      speed:     { min: 80, max: 320 },
      angle:     { min: 0,  max: 360 },
      scale:     { start: 2.0, end: 0 },
      alpha:     { start: 1,   end: 0 },
      lifespan:  600,
      quantity:  32,
      blendMode: 'ADD',
      tint:      [0xff6600, 0xff9900, 0xffcc00, 0xffffff],
      emitting:  false,
    }).setDepth(15);

    emitter.explode(32);
    this.time.delayedCall(700, () => emitter.destroy());
  }

  /** Flash the current ship and fire a bullet downward (tween-driven); advance the sequence. */
  _fFireNext() {
    const data = this._fFleet[this._fShootIndex];
    this._fShootIndex = (this._fShootIndex + 1) % this._fFleet.length;
    if (!data || data.dead || !data.ship.active) return;

    this.tweens.add({ targets: data.ship, alpha: 0.25, duration: 80, yoyo: true, repeat: 1 });

    const startY = data.ship.y + 14;
    const bullet = this.add.rectangle(data.ship.x, startY, 3, 10, 0xff3300).setDepth(9);
    this._eBullets.push(bullet);

    const pixelsPerSec = 600 * data.speed;
    const dist         = HEIGHT + 30 - startY;
    this.tweens.add({
      targets:    bullet,
      y:          HEIGHT + 30,
      duration:   Math.round(dist / pixelsPerSec * 1000),
      ease:       'Linear',
      onComplete: () => {
        const idx = this._eBullets.indexOf(bullet);
        if (idx !== -1) this._eBullets.splice(idx, 1);
        if (bullet.active) bullet.destroy();
      },
    });
  }
}
