# Warp Nemesis

A top-down space shooter roguelike inspired by **Firepower 2000** (SNES). Pilot a starship through 7 procedurally varied levels, collect weapons and upgrades, and fight your way to the Supreme Command AI.

Built with **Phaser 3** — no build toolchain, no npm, runs directly in a browser.

---

## Gameplay

- **3 playable ships** with distinct stats and passive abilities
- **2 weapon slots** — slot 1 starts with the laser, slot 2 fills via drops and level-transition picks
- **Roguelike progression** — choose 1 of 3 upgrades between each level; no two runs are the same
- **7 levels** with escalating enemy waves, mid-bosses, and end-bosses
- **Permadeath** — 3 lives per run by default
- **Boss modifiers** from level 3 onward (enraged speed, double projectiles, extra shield)

## Current Laser Heat

- The default laser uses a `30`-shot heat bar.
- The bar turns yellow at `70%` heat.
- Yellow shots fire as two side-by-side lasers, but they behave as one shared hot shot.
- Each yellow shot adds `+10%` damage and `+10%` score over base, stacking one step per shot while the bar stays yellow.
- Either yellow beam can apply the full boosted shot, but the pair does not double-dip if both beams overlap the same target.
- A full overheat locks firing until `20` shots of heat have cooled off.

---

## Controls

| Action | Keys |
|---|---|
| Move | Arrow keys or WASD |
| Start game | Enter or Space |
| Back to menu | Escape |

---

## Running Locally

Requires a local HTTP server (ES modules don't load over `file://`).

```bash
# Python (any machine with Python 3)
python -m http.server 8080

# Node
npx serve .
```

Then open [http://localhost:8080](http://localhost:8080).

No internet connection required — Phaser is bundled locally as `phaser.min.js`.

---

## Running Tests

Uses Node's built-in test runner — no dependencies needed.

```bash
# All tests
node --test tests/**/*.test.js

# Single file
node --test tests/systems/ScrollingBackground.test.js

# With coverage (Node 22+)
node --test --experimental-test-coverage tests/**/*.test.js
```

---

## Tech Stack

| | |
|---|---|
| Framework | [Phaser 3](https://phaser.io) |
| Language | Vanilla ES6+ modules |
| Tests | Node built-in `node:test` |
| Build | None |

---

## Project Structure

```
├── index.html              # Entry point
├── main.js                 # Phaser config and scene registry
├── style.css               # Minimal chrome (black bg, centered canvas)
├── phaser.min.js           # Phaser 3 (local)
│
├── config/                 # All game constants and balance data
├── scenes/                 # Phaser scenes (Boot, Menu, Game, HUD, …)
├── entities/               # Player, enemies, bosses
├── weapons/                # Weapon types and bullet pool
├── systems/                # Starfield, wave spawner, collisions, effects
├── ui/                     # HUD, ship select, upgrade picker
└── tests/                  # Unit tests mirroring the source tree
```

---

## Ships

| Ship | Armor | Speed | Shield | Passive |
|---|---|---|---|---|
| Vanguard | High | Medium | — | +20% bullet damage |
| Phantom | Low | High | Medium | Dodge roll (brief invincibility) |
| Fortress | Very High | Low | High | Auto-repair (slow HP regen) |

---

## Development Status

| Phase | Status | Description |
|---|---|---|
| 1 | ✅ Done | Skeleton — menu, starfield, moveable ship |
| 2 | Planned | Player entity, laser, bullet pool, HUD |
| 3 | Planned | Enemies, collisions, effects, RunState |
| 4 | Planned | Level config, progression, game over |
| 5 | Planned | Bosses and boss health bar |
| 6 | Planned | All weapons, bonuses, upgrade UI |
| 7 | Planned | Ship select, passives, boss modifiers |
| 8 | Planned | Sprites, audio, parallax, polish |

---

## License

MIT
