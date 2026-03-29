/** @module EnemyTelemetryCollector */

import { EnemyLearningRunSession } from './EnemyLearningRunSession.js';

/**
 * Small facade around run-session creation so telemetry wiring stays out of
 * the main adaptive-policy facade.
 */
export class EnemyTelemetryCollector {
  /**
   * @param {object} policy
   */
  constructor(policy) {
    this._policy = policy;
  }

  /**
   * @param {object} options
   * @returns {EnemyLearningRunSession}
   */
  createRunSession(options) {
    if (!this._policy?._state) this._policy?.load?.();
    return new EnemyLearningRunSession({
      ...options,
      encoder: this._policy?._encoder,
      squadEncoder: this._policy?._squadEncoder,
      sampleIntervalMs: this._policy?._config?.sampleIntervalMs,
    });
  }
}

