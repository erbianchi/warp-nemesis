/** @module Skirm */

import { EnemyBase }    from '../EnemyBase.js';
import { GAME_CONFIG }  from '../../config/game.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { buildSquadSnapshot } from '../../systems/ml/EnemyPolicyMath.js';
import { stripActionModes } from '../../systems/ml/DanceWaypointNetwork.js';

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

  _scaleDuration(durationMs, speedScalar = this.adaptiveProfile?.currentSpeedScalar ?? 1) {
    const requestedMultiplier = (this._baseMovementSpeedMultiplier ?? 1) * speedScalar;
    const resolvedMultiplier = this.resolveMovementDurationScale?.(requestedMultiplier) ?? requestedMultiplier;
    return Math.max(1, Math.round(durationMs / resolvedMultiplier));
  }

  _travelDurationTo(targetX, targetY, durationMs, speedScalar = this.adaptiveProfile?.currentSpeedScalar ?? 1) {
    const requestedDuration = this._scaleDuration(durationMs, speedScalar);
    return this.resolveTravelDurationMs?.(requestedDuration, targetX, targetY) ?? requestedDuration;
  }

  _adaptivePlan(baseX, candidateY = this.y, rangePx = 72, marginPx = 30, commit = true, yRangePx = 56) {
    return this.resolveAdaptiveMovePlan(baseX, {
      candidateY,
      rangePx,
      yRangePx,
      marginPx,
      topMarginPx: 24,
      bottomMarginPx: H - 96,
      commit,
    });
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
      case 'fan_out':      this._danceFanOut();       break;
      case 'neural_flow':  this._danceNeuralFlow();   break;
      default:             break;
    }
  }

  setupWeapon() {}

  fire() {
    this.emitNativeFireBursts({ yOffset: 12 });
  }

  // ── Dances ──────────────────────────────────────────────────────────────────

  /**
   * sweep_left / sweep_right — arc in from top, curve across the screen,
   * shoot while moving, exit off the opposite side.
   * dir: -1 = sweep left, 1 = sweep right
   */
  _danceSweep(dir) {
    const scene = this.scene;
    const midY  = H * 0.38 + Math.random() * H * 0.16;
    const midPlan  = this._adaptivePlan(
      dir === 1 ? W * 0.68 + Math.random() * 40 : W * 0.28 - Math.random() * 40,
      midY,
      84
    );
    const exitX = dir === 1 ? W + 70 : -70;
    const exitY = midY + 60 + Math.random() * 80;

    scene.tweens.add({
      targets:  this,
      x: midPlan.x, y: midY,
      duration: this._travelDurationTo(midPlan.x, midY, 1100, midPlan.speedScalar),
      ease:     'Sine.easeOut',
      onComplete: () => {
        if (!this.alive) return;
        this.unlockAdaptiveBehavior();
        scene.tweens.add({
          targets:  this,
          x: exitX, y: exitY,
          duration: this._travelDurationTo(exitX, exitY, 900),
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

      const ny = y + 70 + Math.random() * 50;
      const plan = this._adaptivePlan(x + dir * (70 + Math.random() * 50), ny, 78);

      scene.tweens.add({
        targets:  this,
        x: plan.x, y: ny,
        duration: this._travelDurationTo(plan.x, ny, 350 + Math.random() * 150, plan.speedScalar),
        ease:     'Sine.easeInOut',
        onComplete: () => {
          this.unlockAdaptiveBehavior();
          zig(plan.x, ny, -dir);
        },
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

      const ny = y + 55 + Math.random() * 65;
      const plan = this._adaptivePlan(x + (Math.random() - 0.5) * 120, ny, 90, 35);

      scene.tweens.add({
        targets:  this,
        x: plan.x, y: ny,
        duration: this._travelDurationTo(plan.x, ny, 420 + Math.random() * 260, plan.speedScalar),
        ease:     'Sine.easeInOut',
        onComplete: () => {
          this.unlockAdaptiveBehavior();
          drift(plan.x, ny);
        },
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
      const ny = y + 38 + Math.random() * 38;
      const plan = this._adaptivePlan(x + dir * stepX, ny, 84, 28);
      const nextDir = plan.x <= 40 ? 1 : plan.x >= W - 40 ? -1 : -dir;

      scene.tweens.add({
        targets:  this,
        x: plan.x, y: ny,
        duration: this._travelDurationTo(plan.x, ny, 120 + Math.random() * 80, plan.speedScalar),
        ease:     'Expo.easeOut',
        onComplete: () => {
          if (!this.alive) return;
          this.unlockAdaptiveBehavior();
          scene.time.delayedCall(
            this._scaleDuration(45 + Math.random() * 80),
            () => jink(plan.x, ny, nextDir)
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
    const centerY = H * 0.26 + Math.random() * H * 0.10;
    const centerPlan = this._adaptivePlan(
      Phaser.Math.Clamp(this.x, 90, W - 90),
      centerY,
      76,
      90
    );
    const centerX = centerPlan.x;
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
    const centerY = H * 0.30 + Math.random() * H * 0.10;
    const centerPlan = this._adaptivePlan(
      Phaser.Math.Clamp(this.x, 96, W - 96),
      centerY,
      72,
      96
    );
    const centerX = centerPlan.x;
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
    const midY     = H * 0.28 + Math.random() * H * 0.18;
    const midPlan  = this._adaptivePlan(W * 0.35 + Math.random() * W * 0.30, midY, 92);
    const midX     = midPlan.x;
    const hoverMs  = 500 + Math.random() * 400;

    scene.tweens.add({
      targets:  this,
      x: midX, y: midY,
      duration: this._travelDurationTo(midX, midY, 1000, midPlan.speedScalar),
      ease:     'Sine.easeOut',
      onComplete: () => {
        if (!this.alive) return;
        this.unlockAdaptiveBehavior();
        // brief hover drift
        const hoverPlan = this._adaptivePlan(midX + (Math.random() - 0.5) * 40, midY, 64, 40);
        const hx = hoverPlan.x;
        const hy = midY + (Math.random() - 0.5) * 20;
        scene.tweens.add({
          targets:  this,
          x: hx, y: hy,
          duration: this._travelDurationTo(hx, hy, hoverMs, hoverPlan.speedScalar),
          ease:     'Sine.easeInOut',
          onComplete: () => {
            if (!this.alive) return;
            const player = scene._player;
            const divePlan = player
              ? this._adaptivePlan(player.x + (Math.random() - 0.5) * 60, H + 80, 88)
              : this._adaptivePlan(midX, H + 80, 88);
            scene.tweens.add({
              targets:  this,
              x: divePlan.x, y: H + 80,
              duration: this._travelDurationTo(divePlan.x, H + 80, 1000, divePlan.speedScalar),
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
    const spreadY = H * 0.14 + Math.random() * H * 0.14;
    const spreadPlan = this._adaptivePlan(this.x + (Math.random() - 0.5) * W * 0.65, spreadY, 110, 40);
    const spreadX = spreadPlan.x;
    const holdMs  = 900 + Math.random() * 500;

    scene.tweens.add({
      targets:  this,
      x: spreadX, y: spreadY,
      duration: this._travelDurationTo(spreadX, spreadY, 750, spreadPlan.speedScalar),
      ease:     'Sine.easeOut',
      onComplete: () => {
        if (!this.alive) return;
        this.unlockAdaptiveBehavior();
        // slight drift while holding
        const holdPlan = this._adaptivePlan(
          spreadX + (Math.random() - 0.5) * 30,
          spreadY + (Math.random() - 0.5) * 15,
          36,
          40
        );
        scene.tweens.add({
          targets:  this,
          x: holdPlan.x,
          y: holdPlan.y,
          duration: this._travelDurationTo(holdPlan.x, holdPlan.y, holdMs, holdPlan.speedScalar),
          ease:     'Sine.easeInOut',
          onComplete: () => {
            if (!this.alive) return;
            const player = scene._player;
            const divePlan = player
              ? this._adaptivePlan(player.x + (Math.random() - 0.5) * 70, H + 80, 92)
              : this._adaptivePlan(spreadX, H + 80, 92);
            scene.tweens.add({
              targets:  this,
              x: divePlan.x, y: H + 80,
              duration: this._travelDurationTo(divePlan.x, H + 80, 950, divePlan.speedScalar),
              ease:     'Cubic.easeIn',
              onComplete: () => this._exitSilent(),
            });
          },
        });
      },
    });
  }

  // ── Neural-flow dance ────────────────────────────────────────────────────────

  /**
   * A learned phrase-sequencer dance driven by DanceWaypointNetwork.
   *
   * The network predicts the next behavioral mode (hold/press/flank/evade/retreat)
   * given the current game state.  Each mode maps to a movement anchor; the
   * existing EnemyAdaptivePolicy position-scoring system refines the exact target
   * within that anchor.  The enemy commits to each phrase for a configured dwell
   * window before re-querying the network.
   */
  _danceNeuralFlow() {
    const scene = this.scene;
    const cfg = ENEMY_LEARNING_CONFIG.neuralDance ?? {};
    const maxPhrases = cfg.maxPhrasesBeforeExit ?? 8;
    let phrases = 0;
    let lastMode = 'hold';

    // Enter the play area first — always top-screen, then unlock adaptive.
    const entryX = this.x + (Math.random() - 0.5) * 80;
    const entryY = H * 0.18 + Math.random() * H * 0.12;
    const entryPlan = this._adaptivePlan(entryX, entryY, 80);

    scene.tweens.add({
      targets:  this,
      x: entryPlan.x, y: entryY,
      duration: this._travelDurationTo(entryPlan.x, entryY, 680, entryPlan.speedScalar),
      ease:     'Sine.easeOut',
      onComplete: () => {
        if (!this.alive) return;
        this.unlockAdaptiveBehavior();
        runPhrase();
      },
    });

    const runPhrase = () => {
      if (!this.alive) return;
      if (phrases >= maxPhrases) { this._exitSilent(); return; }
      if (this.y > H + 40)       { this._exitSilent(); return; }
      phrases++;

      const mode = this._sampleNeuralMode(lastMode);
      lastMode = mode;
      this._adaptiveActionMode = mode;

      const anchor = this._resolveNeuralAnchor(mode);
      const plan   = this._adaptivePlan(anchor.x, anchor.y, 72, 30, true, 56);

      const timing = (cfg.phraseTiming ?? {})[mode] ?? { durationMs: 500, holdMs: 300 };
      const ease   = mode === 'evade' ? 'Expo.easeOut' : 'Sine.easeInOut';

      scene.tweens.add({
        targets:  this,
        x: plan.x, y: plan.y,
        duration: this._travelDurationTo(plan.x, plan.y, timing.durationMs, plan.speedScalar),
        ease,
        onComplete: () => {
          if (!this.alive) return;
          const holdMs = this._scaleDuration(timing.holdMs);
          if (holdMs > 0) {
            scene.time.delayedCall(holdMs, runPhrase);
          } else {
            runPhrase();
          }
        },
      });
    };
  }

  /**
   * Query the DanceWaypointNetwork for the next action mode.
   * Falls back to the position-scoring argmax when the network is untrained.
   * Applies mode hysteresis to prevent rapid oscillation.
   * @param {string} currentMode
   * @returns {string}
   */
  _sampleNeuralMode(currentMode) {
    const policy  = this.scene?._enemyAdaptivePolicy;
    const network = policy?.getDanceNetwork?.();
    const cfg     = ENEMY_LEARNING_CONFIG.neuralDance ?? {};

    if (network?.isTrained) {
      const temperature = this._resolveNeuralTemperature(network);
      const player  = this._getPlayerSnapshot();
      const threat  = this._getPlayerBulletThreatSnapshot();
      const liveEnemies = this.scene?._enemies ?? [];
      const squad   = buildSquadSnapshot(liveEnemies, this._squadId ?? null, this);
      const weapon  = this.scene?._weapons?.getLearningSnapshot?.() ?? {};

      const sample = policy._encoder?.buildSample?.({
        enemyType: this.enemyType,
        player,
        weapon,
        enemyX:    this.x,
        enemyY:    this.y,
        speed:     this.speed,
        squad,
        threat,
        actionMode: 'hold', // placeholder — stripped before inference
      });
      if (sample) {
        const encoded = policy._encoder.encodeSample(sample);
        const { mode, probabilities } = network.sample(
          stripActionModes(encoded.vector),
          temperature
        );
        // Hysteresis: require meaningful probability shift to switch modes
        const hysteresis = cfg.modeHysteresisThreshold ?? 0.15;
        const currentModeIdx = ['hold','press','flank','evade','retreat'].indexOf(currentMode);
        const newModeIdx     = ['hold','press','flank','evade','retreat'].indexOf(mode);
        if (currentModeIdx >= 0 && newModeIdx >= 0 && mode !== currentMode) {
          if ((probabilities[newModeIdx] ?? 0) - (probabilities[currentModeIdx] ?? 0) < hysteresis) {
            return currentMode;
          }
        }
        return mode;
      }
    }

    // Fallback: use position-scoring to pick the best anchor mode
    if (policy?.resolveBehavior) {
      const anchors = this._buildAdaptiveAnchors(this.x, this.y, 72, 56, {
        marginPx: 30, topMarginPx: 24, bottomMarginPx: H - 96,
      });
      const best = policy.resolveBehavior({
        enemy:     this,
        enemyType: this.enemyType,
        candidates: anchors.map(a => ({ x: a.x, y: a.y, speedScalar: 1, actionMode: a.mode })),
      });
      return best?.actionMode ?? 'hold';
    }

    return 'hold';
  }

  /**
   * Map an action mode to a movement anchor position.
   * @param {string} mode
   * @returns {{ x: number, y: number }}
   */
  _resolveNeuralAnchor(mode) {
    const player = this._getPlayerSnapshot();
    const threat = this._getPlayerBulletThreatSnapshot();
    const clampX = (x) => Math.max(30, Math.min(W - 30, x));
    const clampY = (y) => Math.max(24, Math.min(H - 96, y));

    switch (mode) {
      case 'press':
        return {
          x: clampX(player.x ?? this.x),
          y: clampY(Math.min((player.y ?? this.y) - 90, this.y + 60)),
        };
      case 'flank': {
        const px    = player.x ?? W / 2;
        const side  = this.x <= px ? -1 : 1;
        return {
          x: clampX(px + side * (80 + Math.random() * 40)),
          y: clampY(this.y + (Math.random() - 0.5) * 40),
        };
      }
      case 'evade':
        return {
          x: clampX(threat.suggestedSafeX ?? this.x),
          y: clampY(threat.suggestedSafeY ?? this.y),
        };
      case 'retreat':
        return {
          x: clampX(this.x),
          y: clampY(this.y - 50 - Math.random() * 40),
        };
      case 'hold':
      default:
        return { x: clampX(this.x), y: clampY(this.y) };
    }
  }

  /**
   * Compute softmax temperature from training data volume.
   * More samples → lower temperature → more exploitative.
   * @param {import('../../systems/ml/DanceWaypointNetwork.js').DanceWaypointNetwork} network
   * @returns {number}
   */
  _resolveNeuralTemperature(network) {
    const cfg      = ENEMY_LEARNING_CONFIG.neuralDance ?? {};
    const tInit    = cfg.temperatureInitial        ?? 2.0;
    const tFinal   = cfg.temperatureFinal          ?? 0.7;
    const converge = cfg.temperatureSampleConverge ?? 200;
    const t = Math.min((network?.sampleCount ?? 0) / Math.max(1, converge), 1);
    return tInit - (tInit - tFinal) * t;
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
      const stepPlan = this._adaptivePlan(step.x, step.y, 52, 32, false, 30);
      scene.tweens.add({
        targets:  this,
        x:        stepPlan.x,
        y:        stepPlan.y,
        duration: this._travelDurationTo(stepPlan.x, stepPlan.y, step.duration ?? 320, stepPlan.speedScalar),
        ease:     step.ease ?? 'Sine.easeInOut',
        onComplete: () => {
          if (!this.alive) return;
          const pauseMs = step.pauseMs ?? 0;
          const nextIndex = index + 1;
          if (nextIndex % loopPoints.length === 0) {
            this.unlockAdaptiveBehavior();
          }
          if (pauseMs > 0) {
            scene.time.delayedCall(this._scaleDuration(pauseMs), () => runStep(nextIndex));
            return;
          }
          runStep(nextIndex);
        },
      });
    };

    scene.tweens.add({
      targets:  this,
      x:        entryTarget.x,
      y:        entryTarget.y,
      duration: this._travelDurationTo(entryTarget.x, entryTarget.y, opts.enterDuration ?? 720),
      ease:     opts.enterEase ?? 'Sine.easeOut',
      onComplete: () => runStep(0),
    });
  }

  /** Remove this enemy silently (off-screen exit — no score). */
  _exitSilent() {
    if (!this.alive) return;
    this.alive = false;
    this.markEscaped?.();
    this.setActive(false).setVisible(false);
    if (this.body) this.body.enable = false;
    this.destroy();
  }
}
