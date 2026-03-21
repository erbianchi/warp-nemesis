/** @module levels.config */

export const LEVELS = [
  {
    id: 1,
    theme: 'Asteroid Belt',
    scrollSpeed: 80,
    difficultyBase: 1.0,
    midBoss: null,
    boss: null,

    waves: [
      {
        id: 1,
        difficultyFactor: 1.0,
        interSquadronDelay: 0,
        squadronCount: 1,
        squadronPool: [
          {
            id: 'w1_formation',
            dance: 'straight',
            formation: 'line',
            entryEdge: 'top', entryX: 0.5, spacing: 60,
            planes: [
              { type: 'skirm' },
              { type: 'skirm' },
              { type: 'skirm' },
              { type: 'skirm' },
              { type: 'skirm' },
              { type: 'skirm' },
              { type: 'skirm' },
              { type: 'skirm' },
            ],
          },
        ],
      },
    ],
  },
];
