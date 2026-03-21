/** @module GameScene
 * Core game loop — orchestrator only.
 * Delegates enemy spawning to WaveSpawner, movement to entity classes,
 * and collision to physics.add.overlap + manual AABB for enemy bullets. */

import { GAME_CONFIG }           from '../config/game.config.js';
import { EVENTS }                from '../config/events.config.js';
import { ScrollingBackground }   from '../systems/ScrollingBackground.js';
import { EffectsSystem }         from '../systems/EffectsSystem.js';
import { WaveSpawner }           from '../systems/WaveSpawner.js';
import { FormationController }   from '../systems/FormationController.js';
import { WeaponManager }         from '../weapons/WeaponManager.js';
import { RunState }              from '../systems/RunState.js';
import { Skirm }                 from '../entities/enemies/Skirm.js';

const {
  WIDTH, HEIGHT,
  PLAYER_SPEED, PLAYER_SPEED_DEFAULT, PLAYER_LIVES_DEFAULT,
  PLAYER_HP_MAX, PLAYER_HP_DEFAULT,
  PLAYER_SHIELD_MAX, PLAYER_SHIELD_DEFAULT,
  PLAYER_HEAT_MAX,
} = GAME_CONFIG;

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  create() {
    this._bg      = new ScrollingBackground(this);
    this._effects = new EffectsSystem(this);
    this._player  = this._createPlayer();
    this._weapons = new WeaponManager(this);
    this._cursors = this.input.keyboard.createCursorKeys();
    this._wasd    = this._createWASD();
    this._space   = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    this._playerSpeed    = PLAYER_SPEED_DEFAULT;
    this._playerLives    = PLAYER_LIVES_DEFAULT;
    this._playerHp       = PLAYER_HP_DEFAULT;
    this._playerShield   = PLAYER_SHIELD_DEFAULT;
    this._weaponHeat     = 0;
    this._gameOver       = false;
    this._respawning     = false;
    this._displayedScore = 0;
    this._scoreTween     = null;

    RunState.reset();

    this._buildWeaponDisplay();
    this._buildStatusBars();
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
    if (this._gameOver || this._respawning) return;

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
    const dt = delta / 1000;
    for (let i = this._eBullets.length - 1; i >= 0; i--) {
      const b = this._eBullets[i];
      if (!b.active) { this._eBullets.splice(i, 1); continue; }
      if (b.y > HEIGHT + 20) { b.destroy(); this._eBullets.splice(i, 1); continue; }

      // Apply and decay sideways push from nearby explosions (tweens only control y)
      if (b._pushVx) {
        b.x += b._pushVx * dt;
        b._pushVx *= Math.max(0, 1 - 2.5 * dt);
        if (Math.abs(b._pushVx) < 0.5) b._pushVx = 0;
      }

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
    // Triangle pointing up — nose at top-center, base at bottom.
    // Vertices span 28×36: bounding box matches the old rectangle exactly.
    // Physics body stays rectangular (Arcade AABB) — same collision footprint.
    const p = this.add.triangle(
      WIDTH / 2, HEIGHT - 80,
      14, 0,   // nose
      0,  36,  // bottom-left
      28, 36,  // bottom-right
      0x00ff88
    );
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

  _onPlayerHit(damage = 10) {
    if (this._gameOver || this._respawning) return;

    // Shield absorbs damage first
    if (this._playerShield > 0) {
      this._playerShield = Math.max(0, this._playerShield - damage);
      this._drawStatusBars();
      return;
    }

    this._playerHp -= damage;
    this._drawStatusBars();

    if (this._playerHp <= 0) {
      this._playerLives--;
      this._livesText.setText(`× ${Math.max(0, this._playerLives)}`);
      if (this._playerLives <= 0) {
        this._killPlayer();
      } else {
        this._respawnAfterDeath();
      }
    }
  }

  _respawnAfterDeath() {
    this._respawning = true;

    this._explode(this._player.x, this._player.y);
    this._player.setVisible(false);
    if (this._player.body) this._player.body.enable = false;

    for (const fc of this._formations) fc.stop();
    this._formations = [];
    this.physics.pause();

    this.time.delayedCall(1500, () => {
      // Clear all enemies
      for (let i = this._enemies.length - 1; i >= 0; i--) {
        const e = this._enemies[i];
        e.alive = false;
        this._enemyGroup.remove(e);
        e.destroy();
      }
      this._enemies = [];

      // Clear enemy bullets
      for (const b of this._eBullets) { if (b.active) b.destroy(); }
      this._eBullets = [];

      // Reset player to starting position
      this._player.x = WIDTH / 2;
      this._player.y = HEIGHT - 80;
      this._player.setVisible(true);
      if (this._player.body) {
        this._player.body.reset(WIDTH / 2, HEIGHT - 80);
        this._player.body.enable = true;
      }

      this._playerHp = PLAYER_HP_DEFAULT;
      this._drawStatusBars();

      this.physics.resume();
      this._respawning = false;

      // Re-launch the squadron that was active when the player died
      this._spawner.replayLastSquadron();
    });
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
    if (bullet.body) { bullet.body.stop(); bullet.body.enable = false; }
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

  _buildStatusBars() {
    const BAR_H = 8, BAR_GAP = 5;
    const X0     = 8;   // left margin
    const Y_TOP  = this._weaponDisplayY + (38 - (3 * BAR_H + 2 * BAR_GAP)) / 2;
    const BOX_W  = 62, GAP = 6;
    const nSlots = this._weapons.getSlots().length;
    const BAR_W  = nSlots * BOX_W + (nSlots - 1) * GAP;

    const defs = [
      { key: 'hp',     max: PLAYER_HP_MAX,    color: 0x00cc44 },
      { key: 'shield', max: PLAYER_SHIELD_MAX, color: 0x2255ff },
      { key: 'heat',   max: PLAYER_HEAT_MAX,   color: 0xff3300 },
    ];

    this._barFills = {};

    defs.forEach((def, i) => {
      const y = Y_TOP + i * (BAR_H + BAR_GAP);

      // background — origin (0,0) so x,y is top-left corner
      this.add.rectangle(X0, y, BAR_W, BAR_H, 0x111111)
        .setDepth(10).setOrigin(0, 0);

      // fill — origin (0,0), width scaled by displayWidth
      const fill = this.add.rectangle(X0, y, BAR_W, BAR_H, def.color)
        .setDepth(11).setOrigin(0, 0);
      this._barFills[def.key] = { rect: fill, max: def.max, fullW: BAR_W };

      // border
      const gfx = this.add.graphics().setDepth(12);
      gfx.lineStyle(1, 0x444444, 1);
      gfx.strokeRect(X0, y, BAR_W, BAR_H);
    });

    this._drawStatusBars();
  }

  _drawStatusBars() {
    const vals = {
      hp:     this._playerHp,
      shield: this._playerShield,
      heat:   this._weaponHeat,
    };
    for (const [key, { rect, max, fullW }] of Object.entries(this._barFills)) {
      rect.displayWidth = Math.max(0, Math.min(1, vals[key] / max)) * fullW;
    }
  }

  _buildWeaponDisplay() {
    const BOX_W = 62, BOX_H = 38, GAP = 6;
    const slots = this._weapons.getSlots();
    const X0    = WIDTH - 8 - slots.length * BOX_W - (slots.length - 1) * GAP;
    const Y0    = HEIGHT - BOX_H - 8;
    this._weaponDisplayX = X0;   // shared with _buildStatusBars
    this._weaponDisplayY = Y0;
    const gfx   = this.add.graphics();

    slots.forEach((slot, i) => {
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

    // Small ship triangle (same shape/color as player) + "× N" life count
    this.add.triangle(14, 17, 6, 0, 0, 14, 12, 14, 0x00ff88).setDepth(10);
    this._livesText = this.add.text(24, 9, `× ${this._playerLives}`, {
      fontSize: '12px', fill: '#ffffff', fontFamily: 'monospace',
    }).setDepth(10);
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  _explodeForType(x, y, type, vx, vy) {
    this._effects.explodeForType(x, y, type, vx, vy, this._enemies, this._eBullets);
  }

  /** Player explosion — uses Skirm blast as placeholder. */
  _explode(x, y) { this._effects.explodeForType(x, y, 'skirm', 0, 0, this._enemies, this._eBullets); }
}
