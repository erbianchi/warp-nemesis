/** @module Raptor */

import { EnemyBase } from '../EnemyBase.js';
import { GAME_CONFIG } from '../../config/game.config.js';
import { ENEMY_LEARNING_CONFIG } from '../../config/enemyLearning.config.js';
import { buildSquadSnapshot } from '../../systems/ml/EnemyPolicyMath.js';
import { stripActionModes } from '../../systems/ml/DanceWaypointNetwork.js';

const RAPTOR_WIDTH = 40;
const RAPTOR_HEIGHT = 32;
const RAPTOR_BULLET_WIDTH = 7;
const RAPTOR_BULLET_HEIGHT = 22;
const RAPTOR_BULLET_COLOR = 0x4ab8ff;
const DIAGONAL_COMPONENT = Math.SQRT1_2;
const { WIDTH: W, HEIGHT: H } = GAME_CONFIG;
const RAPTOR_SCREEN_MARGIN_X = 56;
const RAPTOR_SCREEN_MARGIN_TOP = 96;
const RAPTOR_SCREEN_MARGIN_BOTTOM = 156;
const STAR_DIRECTIONS = Object.freeze([
  { x: 0, y: 1 },
  { x: DIAGONAL_COMPONENT, y: DIAGONAL_COMPONENT },
  { x: 1, y: 0 },
  { x: DIAGONAL_COMPONENT, y: -DIAGONAL_COMPONENT },
  { x: 0, y: -1 },
  { x: -DIAGONAL_COMPONENT, y: -DIAGONAL_COMPONENT },
  { x: -1, y: 0 },
  { x: -DIAGONAL_COMPONENT, y: DIAGONAL_COMPONENT },
]);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Raptor — heavy slow gunship with shielded bulk and a radial 8-way burst.
 */
export class Raptor extends EnemyBase {
  constructor(scene, x, y, stats, dance = 'side_left') {
    super(scene, x, y, 'raptor', stats, dance);

    this._baseDisplayWidth = RAPTOR_WIDTH;
    this._baseDisplayHeight = RAPTOR_HEIGHT;
    this.setDisplaySize?.(RAPTOR_WIDTH, RAPTOR_HEIGHT);
    this.body?.setSize?.(36, 28, true);
    this._shield._baseRadius = 22;
    this._persistUntilDestroyed = true;
    this._laneClock = 0;
  }

  setupMovement() {
    this.body.setVelocity(0, 0);
    this._sideDir = this.dance === 'side_right' ? -1 : 1;
    const entryPlan = this.resolveAdaptiveMovePlan(
      this._sideDir > 0 ? W * 0.26 : W * 0.74,
      {
        candidateY: this.y,
        rangePx: 90,
        yRangePx: 48,
        marginPx: RAPTOR_SCREEN_MARGIN_X,
        topMarginPx: RAPTOR_SCREEN_MARGIN_TOP,
        bottomMarginPx: H - RAPTOR_SCREEN_MARGIN_BOTTOM,
      }
    );
    this._entryTargetX = entryPlan.x;
    this._anchorX = this._entryTargetX;
    this._anchorY = clamp(this.y, RAPTOR_SCREEN_MARGIN_TOP + 8, H - RAPTOR_SCREEN_MARGIN_BOTTOM);
    this._entryLerpX = 3.4;
    this._entryWaveY = 16;
    this._patrolRangeX = 90;
    this._patrolRangeY = 110;
    this._patrolLerpX = 3.2;
    this._patrolLerpY = 2.8;
    this._lanePhase = Math.random() * Math.PI * 2;
    this._adaptiveDecisionCooldownMs = 0;
    this._adaptiveTargetX = this._entryTargetX;

    this._useNeuralFlow = (this.dance === 'neural_flow');
    if (this._useNeuralFlow) {
      this._neuralMode     = 'hold';
      this._neuralCommitMs = 0;
    }
  }

  setupWeapon() {}

  getNativeFireBursts(speed = this.bulletSpeed) {
    return STAR_DIRECTIONS.map(direction => ({
      vx: direction.x * speed,
      vy: direction.y * speed,
      width: RAPTOR_BULLET_WIDTH,
      height: RAPTOR_BULLET_HEIGHT,
      color: RAPTOR_BULLET_COLOR,
    }));
  }

  update(delta) {
    if (!this.alive) return;
    this._advanceFlight(delta);
    super.update(delta);
  }

  fire() {
    this.emitNativeFireBursts();
  }

  _advanceFlight(delta) {
    this._laneClock += delta;

    const stillEntering = this._sideDir > 0
      ? this.x < this._entryTargetX
      : this.x > this._entryTargetX;

    if (stillEntering) {
      const targetY = clamp(
        this._anchorY + Math.sin(this._laneClock / 880 + this._lanePhase) * this._entryWaveY,
        RAPTOR_SCREEN_MARGIN_TOP,
        H - RAPTOR_SCREEN_MARGIN_BOTTOM
      );
      this.moveTowardPoint(
        this._entryTargetX,
        targetY,
        delta,
        this._entryLerpX,
        2.4
      );
      return;
    }

    if (this._useNeuralFlow) {
      this._advanceNeuralFlowPhrase(delta);
      return;
    }

    if (!this.canUseAdaptiveBehavior()) {
      this.unlockAdaptiveBehavior();
    }

    const baseTargetX = this._anchorX + Math.sin(this._laneClock / 1000 + this._lanePhase) * this._patrolRangeX;
    const targetY = clamp(
      this._anchorY + Math.sin(this._laneClock / 760 + this._lanePhase * 0.85) * this._patrolRangeY,
      RAPTOR_SCREEN_MARGIN_TOP,
      H - RAPTOR_SCREEN_MARGIN_BOTTOM
    );
    this._adaptiveDecisionCooldownMs -= delta;

    if (this._adaptiveDecisionCooldownMs <= 0) {
      const plan = this.resolveAdaptiveMovePlan(baseTargetX, {
        candidateY: targetY,
        rangePx: 72,
        marginPx: RAPTOR_SCREEN_MARGIN_X,
        yRangePx: 64,
        topMarginPx: RAPTOR_SCREEN_MARGIN_TOP,
        bottomMarginPx: H - RAPTOR_SCREEN_MARGIN_BOTTOM,
      });
      this._adaptiveTargetX = plan.x;
      this._anchorY = plan.y;
      this._adaptiveDecisionCooldownMs = 180;
    }

    this.moveTowardPoint(
      this._adaptiveTargetX,
      this._anchorY,
      delta,
      this._patrolLerpX * (this.adaptiveProfile?.currentSpeedScalar ?? 1),
      this._patrolLerpY
    );
  }

  /**
   * Neural-flow patrol: commitment-window approach.
   * Every (durationMs + holdMs) the network is queried for the next action
   * mode and anchor targets are updated.  Movement uses the existing lerp.
   * @param {number} delta  ms since last frame
   */
  _advanceNeuralFlowPhrase(delta) {
    this._neuralCommitMs -= delta;

    if (this._neuralCommitMs <= 0) {
      if (!this.canUseAdaptiveBehavior()) {
        this.unlockAdaptiveBehavior();
      }
      const cfg     = ENEMY_LEARNING_CONFIG.neuralDance ?? {};
      const newMode = this._sampleNeuralMode(this._neuralMode);
      this._neuralMode         = newMode;
      this._adaptiveActionMode = newMode;

      const anchor          = this._resolveNeuralAnchor(newMode);
      this._adaptiveTargetX = anchor.x;
      this._anchorY         = anchor.y;

      const timing          = (cfg.phraseTiming ?? {})[newMode] ?? { durationMs: 500, holdMs: 300 };
      this._neuralCommitMs  = timing.durationMs + timing.holdMs;
    }

    this.moveTowardPoint(
      this._adaptiveTargetX,
      this._anchorY,
      delta,
      this._patrolLerpX * (this.adaptiveProfile?.currentSpeedScalar ?? 1),
      this._patrolLerpY
    );
  }

  /**
   * Query the DanceWaypointNetwork for the next action mode.
   * Applies mode hysteresis; falls back to position-scoring argmax when untrained.
   * @param {string} currentMode
   * @returns {string}
   */
  _sampleNeuralMode(currentMode) {
    const policy  = this.scene?._enemyAdaptivePolicy;
    const network = policy?.getDanceNetwork?.();
    const cfg     = ENEMY_LEARNING_CONFIG.neuralDance ?? {};

    if (network?.isTrained) {
      const temperature = this._resolveNeuralTemperature(network);
      const player      = this._getPlayerSnapshot();
      const threat      = this._getPlayerBulletThreatSnapshot();
      const liveEnemies = this.scene?._enemies ?? [];
      const squad       = buildSquadSnapshot(liveEnemies, this._squadId ?? null, this);
      const weapon      = this.scene?._weapons?.getLearningSnapshot?.() ?? {};

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
        const hysteresis    = cfg.modeHysteresisThreshold ?? 0.15;
        const MODES         = ['hold', 'press', 'flank', 'evade', 'retreat'];
        const currentModeIdx = MODES.indexOf(currentMode);
        const newModeIdx     = MODES.indexOf(mode);
        if (currentModeIdx >= 0 && newModeIdx >= 0 && mode !== currentMode) {
          if ((probabilities[newModeIdx] ?? 0) - (probabilities[currentModeIdx] ?? 0) < hysteresis) {
            return currentMode;
          }
        }
        return mode;
      }
    }

    // Fallback: position-scoring argmax
    if (policy?.resolveBehavior) {
      const anchors = this._buildAdaptiveAnchors(this.x, this.y, 72, 56, {
        marginPx: RAPTOR_SCREEN_MARGIN_X,
        topMarginPx: RAPTOR_SCREEN_MARGIN_TOP,
        bottomMarginPx: H - RAPTOR_SCREEN_MARGIN_BOTTOM,
      });
      const best = policy.resolveBehavior({
        enemy:      this,
        enemyType:  this.enemyType,
        candidates: anchors.map(a => ({ x: a.x, y: a.y, speedScalar: 1, actionMode: a.mode })),
      });
      return best?.actionMode ?? 'hold';
    }

    return 'hold';
  }

  /**
   * Map an action mode to a movement anchor position (Raptor bounds).
   * @param {string} mode
   * @returns {{ x: number, y: number }}
   */
  _resolveNeuralAnchor(mode) {
    const player = this._getPlayerSnapshot();
    const threat = this._getPlayerBulletThreatSnapshot();
    const clampX = (x) => Math.max(RAPTOR_SCREEN_MARGIN_X, Math.min(W - RAPTOR_SCREEN_MARGIN_X, x));
    const clampY = (y) => Math.max(RAPTOR_SCREEN_MARGIN_TOP, Math.min(H - RAPTOR_SCREEN_MARGIN_BOTTOM, y));

    switch (mode) {
      case 'press':
        return {
          x: clampX(player.x ?? this.x),
          y: clampY(Math.min((player.y ?? this.y) - 100, this.y + 80)),
        };
      case 'flank': {
        const px   = player.x ?? W / 2;
        const side = this.x <= px ? -1 : 1;
        return {
          x: clampX(px + side * (100 + Math.random() * 40)),
          y: clampY(this.y + (Math.random() - 0.5) * 60),
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
          y: clampY(this.y - 70 - Math.random() * 40),
        };
      case 'hold':
      default:
        return { x: clampX(this.x), y: clampY(this.y) };
    }
  }

  /**
   * Compute softmax temperature from training data volume.
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
}
