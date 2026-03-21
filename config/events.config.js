/** @module events.config
 * All Phaser event name constants. Never use inline strings for events. */

export const EVENTS = {
  // Run lifecycle
  GAME_START:     'game:start',
  GAME_OVER:      'game:over',
  LEVEL_COMPLETE: 'level:complete',
  LEVEL_START:    'level:start',

  // Player
  PLAYER_HIT:     'player:hit',
  PLAYER_DIED:    'player:died',
  HEALTH_CHANGED: 'player:health_changed',
  SHIELD_CHANGED: 'player:shield_changed',

  // Enemies / waves
  ENEMY_KILLED:        'enemy:killed',
  ENEMY_DIED:          'enemy:died',      // emitted by EnemyBase on death (score, drops)
  ENEMY_FIRE:          'enemy:fire',      // emitted by enemy entities when shooting
  BOSS_PHASE:          'boss:phase_changed',
  WAVE_START:          'wave:start',
  WAVE_COMPLETE:       'wave:complete',
  ALL_WAVES_COMPLETE:  'wave:all_complete',
  SQUADRON_SPAWNED:    'squadron:spawned',  // emitted after all planes in a squadron are spawned

  // Scoring / state
  SCORE_CHANGED:  'run:score_changed',
  LIVES_CHANGED:  'run:lives_changed',

  // Weapons / bonuses
  WEAPON_CHANGED:  'weapon:changed',
  BONUS_COLLECTED: 'bonus:collected',
};
