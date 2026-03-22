import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS } from '../../config/levels.config.js';
import { ENEMIES } from '../../config/enemies.config.js';

/** Return all squadron templates from a wave (pool mode or static mode). */
function getSquadrons(wave) {
  return wave.squadronPool ?? wave.squadrons ?? [];
}

describe('LEVELS', () => {
  it('exports a non-empty array of levels', () => {
    assert.ok(Array.isArray(LEVELS));
    assert.ok(LEVELS.length >= 1);
  });

  it('each level has required top-level fields', () => {
    for (const level of LEVELS) {
      assert.ok(typeof level.id          === 'number', `L${level.id}: id`);
      assert.ok(typeof level.theme       === 'string', `L${level.id}: theme`);
      assert.ok(typeof level.scrollSpeed === 'number', `L${level.id}: scrollSpeed`);
      assert.ok(typeof level.difficultyBase === 'number', `L${level.id}: difficultyBase`);
      assert.ok(Array.isArray(level.waves),             `L${level.id}: waves`);
      assert.ok(level.waves.length >= 1,                `L${level.id}: ≥1 wave`);
      assert.ok('boss' in level,                        `L${level.id}: boss`);
    }
  });

  it('level ids are sequential starting at 1', () => {
    LEVELS.forEach((level, i) => assert.equal(level.id, i + 1));
  });

  it('difficultyBase increases (or stays equal) across levels', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      assert.ok(LEVELS[i].difficultyBase >= LEVELS[i - 1].difficultyBase,
        `L${LEVELS[i].id} difficultyBase must be >= L${LEVELS[i - 1].id}`);
    }
  });

  it('scrollSpeed increases (or stays equal) across levels', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      assert.ok(LEVELS[i].scrollSpeed >= LEVELS[i - 1].scrollSpeed,
        `L${LEVELS[i].id} scrollSpeed must be >= L${LEVELS[i - 1].id}`);
    }
  });

  describe('waves', () => {
    it('each wave has id, difficultyFactor, and a squadron source', () => {
      for (const level of LEVELS) {
        for (const wave of level.waves) {
          assert.ok(typeof wave.id              === 'number', `L${level.id} W${wave.id}: id`);
          assert.ok(typeof wave.difficultyFactor === 'number', `L${level.id} W${wave.id}: difficultyFactor`);
          // Must have either a pool or a static list
          const hasPool   = Array.isArray(wave.squadronPool);
          const hasStatic = Array.isArray(wave.squadrons);
          assert.ok(hasPool || hasStatic, `L${level.id} W${wave.id}: needs squadronPool or squadrons`);
        }
      }
    });

    it('pool waves declare squadronCount', () => {
      for (const level of LEVELS) {
        for (const wave of level.waves) {
          if (Array.isArray(wave.squadronPool)) {
            assert.ok(typeof wave.squadronCount === 'number',
              `L${level.id} W${wave.id}: pool wave needs squadronCount`);
          }
        }
      }
    });

    it('wave ids within a level are sequential starting at 1', () => {
      for (const level of LEVELS) {
        level.waves.forEach((wave, i) => assert.equal(wave.id, i + 1,
          `L${level.id}: wave id should be ${i + 1}`));
      }
    });
  });

  describe('Level 1 Wave 1', () => {
    const wave = LEVELS[0].waves[0];

    it('uses roguelike pool mode', () => {
      assert.ok(Array.isArray(wave.squadronPool));
    });

    it('pool has ≥ squadronCount templates so draws are non-trivial', () => {
      assert.ok(wave.squadronPool.length >= wave.squadronCount,
        `pool (${wave.squadronPool.length}) should be >= squadronCount (${wave.squadronCount})`);
    });

    it('squadronCount is a positive number', () => {
      assert.ok(typeof wave.squadronCount === 'number' && wave.squadronCount >= 1);
    });

    it('every pool template has a unique id', () => {
      const ids = wave.squadronPool.map(sq => sq.id);
      assert.equal(new Set(ids).size, ids.length, 'pool template ids must be unique');
    });

    it('every pool template has a dance', () => {
      for (const sq of wave.squadronPool) {
        assert.ok(typeof sq.dance === 'string' && sq.dance.length > 0,
          `template "${sq.id}" needs a dance`);
      }
    });

    it('every pool template spawns at most 16 skirms', () => {
      for (const sq of wave.squadronPool) {
        assert.ok(sq.planes.length <= 16,
          `template "${sq.id}" exceeds the 16-skirm cap`);
      }
    });

  });

  describe('Level 1 pacing', () => {
    it('contains exactly 16 waves', () => {
      assert.equal(LEVELS[0].waves.length, 16);
    });

    it('keeps every wave transition under 2 seconds', () => {
      for (const wave of LEVELS[0].waves) {
        assert.ok(
          wave.interSquadronDelay < 2,
          `L1 W${wave.id}: transition delay must stay under 2 seconds`
        );
      }
    });

    it('includes at least one 16-skirm wave template somewhere in the level', () => {
      const hasSixteenShipTemplate = LEVELS[0].waves.some((wave) => (
        getSquadrons(wave).some((sq) => sq.planes.length === 16)
      ));

      assert.ok(hasSixteenShipTemplate, 'expected at least one 16-skirm template in Level 1');
    });
  });

  describe('squadrons', () => {
    const VALID_FORMATIONS = ['line', 'V', 'wedge', 'diamond', 'cluster', 'spread'];
    const VALID_EDGES      = ['top', 'left', 'right'];

    it('each squadron template has valid formation, entryEdge, and ≥1 plane', () => {
      for (const level of LEVELS) {
        for (const wave of level.waves) {
          for (const sq of getSquadrons(wave)) {
            assert.ok(VALID_FORMATIONS.includes(sq.formation),
              `L${level.id} W${wave.id} "${sq.id}": unknown formation "${sq.formation}"`);
            assert.ok(VALID_EDGES.includes(sq.entryEdge),
              `L${level.id} W${wave.id} "${sq.id}": unknown entryEdge "${sq.entryEdge}"`);
            assert.ok(Array.isArray(sq.planes) && sq.planes.length >= 1,
              `L${level.id} W${wave.id} "${sq.id}": needs ≥1 plane`);
            assert.ok(sq.planes.length <= 16,
              `L${level.id} W${wave.id} "${sq.id}": must not exceed 16 planes`);
          }
        }
      }
    });

    it('controller configs, when present, define a usable path', () => {
      for (const level of LEVELS) {
        for (const wave of level.waves) {
          for (const sq of getSquadrons(wave)) {
            if (!sq.controller) continue;
            assert.ok(Array.isArray(sq.controller.path) && sq.controller.path.length >= 1,
              `L${level.id} W${wave.id} "${sq.id}": controller needs a path`);
          }
        }
      }
    });
  });

  describe('planes', () => {
    it('every plane type references a known ENEMIES entry', () => {
      for (const level of LEVELS) {
        for (const wave of level.waves) {
          for (const sq of getSquadrons(wave)) {
            for (const plane of sq.planes) {
              assert.ok(plane.type in ENEMIES,
                `L${level.id} W${wave.id} "${sq.id}": unknown enemy type "${plane.type}"`);
              if ('dance' in plane) {
                assert.ok(typeof plane.dance === 'string' && plane.dance.length > 0,
                  `L${level.id} W${wave.id} "${sq.id}": plane.dance must be a non-empty string`);
              }
            }
          }
        }
      }
    });

    it('plane modifier values, when present, are positive numbers', () => {
      const fields = ['hpModifier', 'damageModifier', 'speedModifier', 'fireRateModifier'];
      for (const level of LEVELS) {
        for (const wave of level.waves) {
          for (const sq of getSquadrons(wave)) {
            for (const plane of sq.planes) {
              for (const field of fields) {
                if (field in plane) {
                  assert.ok(typeof plane[field] === 'number' && plane[field] > 0,
                    `L${level.id}: plane.${field} must be a positive number`);
                }
              }
            }
          }
        }
      }
    });
  });
});
