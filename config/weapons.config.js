/** @module weapons.config
 * All weapon definitions. WeaponManager reads these by key. */

export const WEAPONS = {
  laser: {
    name:              'LASER',
    fireRate:          100,   // ms between shots (10 shots/sec)
    speed:             700,   // px/s upward
    damage:            10,
    color:             0x00ffff,
    poolSize:          80,
    shots:             [{ angle: 0, x: 0 }],
    warningTextureKey: 'bullet_laser_warning',  // single bullet, wider texture showing 2 beams
    sfxDefault:        'laserSmall_000',
    sfxWarning:        'laserOverheat_000',
  },
  tLaser: {
    name:              'T-LASER',
    fireRate:          100,
    speed:             700,
    damage:            10,
    color:             0x00ffff,
    poolSize:          120,
    shots:             [{ angle: 0, x: 0 }, { angle: -90, x: -16 }, { angle: 90, x: 16 }],
    warningTextureKey: 'bullet_laser_warning',
    sfxDefault:        'laserSmall_000',
    sfxWarning:        'laserOverheat_000',
  },
  yLaser: {
    name:              'Y-LASER',
    fireRate:          100,
    speed:             700,
    damage:            10,
    color:             0x00ffff,
    poolSize:          120,
    shots:             [{ angle: 0, x: 0 }, { angle: -45, x: -10 }, { angle: 45, x: 10 }],
    warningTextureKey: 'bullet_laser_warning',
    sfxDefault:        'laserSmall_000',
    sfxWarning:        'laserOverheat_000',
  },
  spreadShot: { fireRate: 250, speed: 550, damage: 7,  color: 0xffff00, poolSize: 60 },
  missile:    { fireRate: 600, speed: 320, damage: 40, color: 0xff6600, poolSize: 20, homing: true },
  plasma:     { fireRate: 350, speed: 400, damage: 22, color: 0xff00ff, poolSize: 30 },
  railgun:    { fireRate: 500, speed: 900, damage: 35, color: 0xffffff, poolSize: 20, piercing: true },
  dualLaser:  { fireRate: 110, speed: 700, damage: 9,  color: 0x00ffff, poolSize: 80 },
  bomb:       { fireRate: 900, speed: 180, damage: 60, color: 0xff4444, poolSize: 10 },
};
