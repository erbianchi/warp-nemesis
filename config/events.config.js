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

  // Enemies
  ENEMY_KILLED:   'enemy:killed',
  BOSS_PHASE:     'boss:phase_changed',

  // Scoring / state
  SCORE_CHANGED:  'run:score_changed',
  LIVES_CHANGED:  'run:lives_changed',

  // Weapons / bonuses
  WEAPON_CHANGED:  'weapon:changed',
  BONUS_COLLECTED: 'bonus:collected',
};
