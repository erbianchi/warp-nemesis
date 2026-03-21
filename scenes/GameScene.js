/** @module GameScene
 * Core game loop — orchestrator only.
 * Delegates enemy spawning to WaveSpawner, movement to entity classes,
 * and collision to physics.add.overlap + manual AABB for enemy bullets. */

import { GAME_CONFIG }           from '../config/game.config.js';
import { EVENTS }                from '../config/events.config.js';
import { ScrollingBackground }   from '../systems/ScrollingBackground.js';
import { WaveSpawner }           from '../systems/WaveSpawner.js';
import { FormationController }   from '../systems/FormationController.js';
import { WeaponManager }         from '../weapons/WeaponManager.js';
import { RunState }              from '../systems/RunState.js';
import { Skirm }                 from '../entities/enemies/Skirm.js';

const { WIDTH, HEIGHT, PLAYER_SPEED, PLAYER_SPEED_DEFAULT, PLAYER_LIFE_DEFAULT } = GAME_CONFIG;

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  create() {
    this._bg      = new ScrollingBackground(this);
    this._player  = this._createPlayer();
    this._weapons = new WeaponManager(this);
    this._cursors = this.input.keyboard.createCursorKeys();
    this._wasd    = this._createWASD();
    this._space   = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    this._playerSpeed    = PLAYER_SPEED_DEFAULT;
    this._playerLife     = PLAYER_LIFE_DEFAULT;
    this._gameOver       = false;
    this._displayedScore = 0;
    this._scoreTween     = null;

    RunState.reset();

    this._buildWeaponDisplay();
    this._buildHUD();

    // ── Enemy management ────────────────────────────────────────────────────
    this._enemies    = [];   // live enemy instances
    this._eBullets   = [];   // tween-driven enemy bullet rectangles
    this._enemyGroup = this.physics.add.group();
    this._formations = [];   // active FormationControllers

    // Player bullets hit enemies
    this.physics.add.overlap(
      this._weapons.pool,
      this._enemyGroup,
      this._onBulletHitEnemy,
      null,
      this
    );

    // Enemy body touches player
    this.physics.add.overlap(
      this._player,
      this._enemyGroup,
      this._onEnemyTouchPlayer,
      null,
      this
    );

    this.events.on(EVENTS.ENEMY_FIRE,       this._onEnemyFire,  this);
    this.events.on(EVENTS.ENEMY_DIED,       this._onEnemyDied,  this);
    this.events.on(EVENTS.ALL_WAVES_COMPLETE, this._onLevelClear, this);
    this.events.on(EVENTS.SQUADRON_SPAWNED, this._onSquadronSpawned, this);

    // ── WaveSpawner ─────────────────────────────────────────────────────────
    this._spawner = new WaveSpawner(
      this,
      0,   // Level 1
      (type, x, y, stats, dance) => this._spawnEnemy(type, x, y, stats, dance)
    );

    this.time.delayedCall(2000, () => this._spawner.start());

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('MenuScene'));
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  update(_time, delta) {
    if (this._gameOver) return;

    this._bg.update(delta);
    this._movePlayer();
    this._weapons.update(delta);

    if (this._space.isDown) {
      this._weapons.tryFire(this._player.x, this._player.y);
    }

    this._spawner.update(delta);

    // Update enemies; cull anything that has gone off-screen
    for (let i = this._enemies.length - 1; i >= 0; i--) {
      const e = this._enemies[i];
      if (!e.active) { this._enemyGroup.remove(e); this._enemies.splice(i, 1); continue; }
      if (e.y > HEIGHT + 80 || e.x < -100 || e.x > WIDTH + 100) {
        this._removeEnemy(e, i);
        continue;
      }
      e.update(delta);
    }

    // Move enemy bullets; check player AABB collision
    const px = this._player.x;
    const py = this._player.y;
    for (let i = this._eBullets.length - 1; i >= 0; i--) {
      const b = this._eBullets[i];
      if (!b.active) { this._eBullets.splice(i, 1); continue; }
      if (b.y > HEIGHT + 20) { b.destroy(); this._eBullets.splice(i, 1); continue; }
      if (Math.abs(b.x - px) < 15.5 && Math.abs(b.y - py) < 23) {
        const dmg = b._damage ?? 10;
        b.destroy();
        this._eBullets.splice(i, 1);
        this._onPlayerHit(dmg);
      }
    }

    // Signal wave clear once all squadrons have spawned and no enemies remain
    if (this._spawner.isWaveActive
        && this._spawner.pendingSquadrons === 0
        && this._enemies.length === 0) {
      this._spawner.onWaveCleared();
    }
  }

  // ── Player ────────────────────────────────────────────────────────────────

  _createPlayer() {
    const p = this.add.rectangle(WIDTH / 2, HEIGHT - 80, 28, 36, 0x00ff88);
    this.physics.add.existing(p);
    p.body.setCollideWorldBounds(true);
    return p;
  }

  _createWASD() {
    return this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
  }

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

  _onPlayerHit(damage) {
    if (this._gameOver) return;
    this._playerLife -= damage;
    this._hpText.setText(`HP  ${Math.max(0, this._playerLife)}`);
    if (this._playerLife <= 0) this._killPlayer();
  }

  _killPlayer() {
    if (this._gameOver) return;
    this._gameOver = true;

    this._explode(this._player.x, this._player.y);
    this._player.setVisible(false);
    if (this._player.body) this._player.body.enable = false;

    for (const fc of this._formations) fc.stop();
    this.physics.pause();

    this.add.text(WIDTH / 2, HEIGHT / 2 - 30, 'GAME OVER', {
      fontSize: '42px', fill: '#ff2222', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);

    this.add.text(WIDTH / 2, HEIGHT / 2 + 30, `SCORE  ${RunState.score}`, {
      fontSize: '20px', fill: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(20);

    this.time.delayedCall(4000, () => this.scene.start('MenuScene'));
    this.input.keyboard.once('keydown-ENTER', () => this.scene.start('GameScene'));
  }

  _onSquadronSpawned({ dance, count }) {
    if (dance !== 'straight') return;
    const ships = this._enemies.slice(-count);
    const fc = new FormationController(this, ships);
    this._formations.push(fc);
  }

  // ── Enemy spawning ────────────────────────────────────────────────────────

  _spawnEnemy(type, x, y, stats, dance) {
    let enemy;
    switch (type) {
      case 'skirm':
      default:
        enemy = new Skirm(this, x, y, stats, dance);
        break;
    }
    this._enemies.push(enemy);
    this._enemyGroup.add(enemy);
  }

  /** Remove an off-screen enemy silently (no score awarded). */
  _removeEnemy(enemy, idx) {
    enemy.alive = false;
    enemy.setActive(false).setVisible(false);
    if (enemy.body) enemy.body.stop();
    this._enemyGroup.remove(enemy);
    enemy.destroy();
    this._enemies.splice(idx, 1);
  }

  // ── Collision handlers ────────────────────────────────────────────────────

  _onBulletHitEnemy(bullet, enemy) {
    this._weapons.pool.killAndHide(bullet);
    if (bullet.body) bullet.body.stop();
    if (!enemy.alive) return;
    enemy.takeDamage(this._weapons.damage);
  }

  _onEnemyTouchPlayer(player, enemy) {
    if (!enemy.alive) return;
    const dmg = enemy.damage ?? 10;
    enemy.die();
    this._onPlayerHit(dmg);
  }

  _onEnemyFire({ x, y, vy, damage }) {
    const bullet = this.add.rectangle(x, y, 3, 10, 0xff4400).setDepth(9);
    bullet._damage = damage;
    this._eBullets.push(bullet);

    const dist = HEIGHT + 30 - y;
    this.tweens.add({
      targets:    bullet,
      y:          HEIGHT + 30,
      duration:   Math.round((dist / vy) * 1000),
      ease:       'Linear',
      onComplete: () => {
        const idx = this._eBullets.indexOf(bullet);
        if (idx !== -1) this._eBullets.splice(idx, 1);
        if (bullet.active) bullet.destroy();
      },
    });
  }

  _onEnemyDied({ x, y, type, vx, vy, score }) {
    this._explodeForType(x, y, type, vx ?? 0, vy ?? 0);
    RunState.addScore(score);
    RunState.kills++;
    this._animateScore(RunState.score);
  }

  _animateScore(target) {
    if (this._scoreTween) this._scoreTween.stop();
    const obj = { val: this._displayedScore ?? 0 };
    this._scoreTween = this.tweens.add({
      targets:  obj,
      val:      target,
      duration: 600,
      ease:     'Linear',
      onUpdate: () => this._scoreText.setText(`SCORE  ${Math.floor(obj.val)}`),
      onComplete: () => { this._displayedScore = target; },
    });
  }

  _onLevelClear() {
    this.add.text(WIDTH / 2, HEIGHT / 2, 'LEVEL CLEAR!', {
      fontSize: '32px', fill: '#00ffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);

    this.add.text(WIDTH / 2, HEIGHT / 2 + 48, `SCORE  ${RunState.score}`, {
      fontSize: '18px', fill: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(20);

    this.time.delayedCall(4000, () => this.scene.start('MenuScene'));
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  _buildWeaponDisplay() {
    const BOX_W = 62, BOX_H = 38, GAP = 6, X0 = 8;
    const Y0    = HEIGHT - BOX_H - 8;
    const gfx   = this.add.graphics();

    this._weapons.getSlots().forEach((slot, i) => {
      const x      = X0 + i * (BOX_W + GAP);
      const filled = slot !== null;
      const border = filled ? slot.color : 0x2a2a2a;
      const bg     = filled ? 0x001428  : 0x080808;
      const css    = filled ? `#${slot.color.toString(16).padStart(6, '0')}` : '#2a2a2a';

      gfx.fillStyle(bg, 1);      gfx.fillRect(x, Y0, BOX_W, BOX_H);
      gfx.lineStyle(1, border, 1); gfx.strokeRect(x, Y0, BOX_W, BOX_H);

      this.add.text(x + 4, Y0 + 3, `${i + 1}`, {
        fontSize: '9px', fill: filled ? '#aaaaaa' : '#333333', fontFamily: 'monospace',
      });
      this.add.text(x + BOX_W / 2, Y0 + BOX_H / 2 + 3, filled ? slot.name : '----', {
        fontSize: '11px', fill: css, fontFamily: 'monospace',
      }).setOrigin(0.5);
    });
  }

  _buildHUD() {
    this._scoreText = this.add.text(WIDTH - 8, 8, 'SCORE  0', {
      fontSize: '12px', fill: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(1, 0).setDepth(10);

    this._hpText = this.add.text(8, 8, `HP  ${this._playerLife}`, {
      fontSize: '12px', fill: '#00ff88', fontFamily: 'monospace',
    }).setDepth(10);
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  _explodeForType(x, y, type, vx, vy) {
    switch (type) {
      case 'skirm': this._explodeSkirm(x, y, vx, vy); break;
      default:      this._explodeSkirm(x, y, vx, vy); break;
    }
  }

  /**
   * Skirm explosion.
   * - Radius (particle speed + count) scales with the plane's velocity.
   * - Blast is directional — sprays toward the direction of travel.
   * - Per-plane randomness in tint and scale.
   */
  _explodeSkirm(x, y, vx = 0, vy = 0) {
    const speed = Math.sqrt(vx * vx + vy * vy);

    // Direction: only meaningful above a threshold — otherwise omnidirectional
    const hasDir   = speed > 40;
    const dir      = hasDir ? Phaser.Math.RadToDeg(Math.atan2(vy, vx)) : 0;
    const spread   = hasDir ? Phaser.Math.Clamp(140 - speed * 0.1, 50, 130) : 180;

    // Radius scales with speed — faster = more particles, faster spread
    const pSpeed   = Phaser.Math.Clamp(80 + speed * 0.6, 80, 400);
    const quantity = Math.round(Phaser.Math.Clamp(16 + speed / 10, 16, 44));
    const scaleMax = Phaser.Math.Clamp(1.4 + speed / 500, 1.4, 3.0);

    // Per-plane tint randomness
    const r     = () => Math.random() < 0.5;
    const tints = [
      r() ? 0xff5500 : 0xff6600,
      r() ? 0xff8800 : 0xff9900,
      r() ? 0xffbb00 : 0xffcc00,
      r() ? 0xffffff : 0xffee88,
    ];

    const emitter = this.add.particles(x, y, 'particle', {
      speed:     { min: pSpeed * 0.25, max: pSpeed },
      angle:     { min: dir - spread, max: dir + spread },
      scale:     { start: scaleMax * (0.85 + Math.random() * 0.3), end: 0 },
      alpha:     { start: 1, end: 0 },
      lifespan:  { min: 380, max: 680 },
      blendMode: 'ADD',
      tint:      tints,
      emitting:  false,
    }).setDepth(15);

    emitter.explode(quantity);
    this.time.delayedCall(800, () => emitter.destroy());
  }

  /** Player explosion — uses Skirm blast as placeholder. */
  _explode(x, y) { this._explodeSkirm(x, y, 0, 0); }
}
