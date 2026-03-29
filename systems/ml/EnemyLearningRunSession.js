/** @module EnemyLearningRunSession */

import { EnemyLearningSession } from './EnemyLearningSession.js';

/**
 * Named run-session seam for telemetry capture.
 * Keeps `EnemyAdaptivePolicy` focused on orchestration while the session owns
 * sampling and event collection for a single run.
 */
export class EnemyLearningRunSession extends EnemyLearningSession {}

