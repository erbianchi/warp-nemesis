/** @module game.config */

export const GAME_CONFIG = {
  WIDTH: 480,
  HEIGHT: 640,

  PLAYER_SPEED: 300,        // base movement speed (px/s) at speed tier 1
  PLAYER_LIVES_DEFAULT: 3,  // lives at the start of a run
  WEAPON_SLOTS: 2,

  PLAYER_HP_MAX: 200,       // maximum HP
  PLAYER_HP_DEFAULT: 10,    // starting HP
  PLAYER_SHIELD_MAX: 400,   // maximum shield
  PLAYER_SHIELD_DEFAULT: 0, // starting shield (no shield by default)
  PLAYER_HEAT_MAX: 30,      // weapon heat capacity measured in shots
  PLAYER_HEAT_RECOVERY_MS: 100,       // recover 1 shot of heat every 100 ms
  PLAYER_OVERHEAT_RECOVERY_SHOTS: 20, // shots of heat that must clear before firing resumes
  PLAYER_HEAT_WARNING_RATIO: 0.8,     // yellow/blinking warning threshold
  PLAYER_HEAT_WARNING_BLINK_MS: 160,  // blink cadence once the warning threshold is reached

  SPEED_MIN: 1,            // minimum speed tier
  SPEED_MAX: 5,            // maximum speed tier
  PLAYER_SPEED_DEFAULT: 1, // player starting speed tier

  STAR_COUNT: 140,
  STAR_SPEED_MIN: 40,
  STAR_SPEED_MAX: 220,
};
