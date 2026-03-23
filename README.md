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

## Current Implemented Slice

- **Level 1 is playable** with 16 Skirm waves and short handoffs between waves.
- **Overlay threats are live** — Raptors raid in side-entry pairs and Mines drift in with gravity wells while the normal wave flow continues.
- **Skirm formations mix scripted and organic motion** — some ships drift, some snap into sharper dances, and formation runs replay from alternating sides.
- **Bonuses are live** as white octagons: `1-Up`, `+50 Life`, `+50 Shield`, `Weapon Upgrade`, and `New Weapon`.
- **Bonuses can roll a random shield** from `100` to `200`; shielded bonuses must be shot open before the player can collect them.
- **Shields are shared tech** for player, enemies, bonuses, and future objects. They absorb damage first, show local shield bars on the holder, and burst with a blue blast when depleted.
- **Bonus pickup sounds are config-driven** so each bonus can define its own sound key or stay silent.
- **Level completion has a full exit beat** — the ship warps off the top, stars stretch into speed lines, then the background fades fully to black before the `LEVEL COMPLETE` card appears.

## Current Laser Heat

- The default laser uses a `30`-shot heat bar.
- The bar turns yellow at `70%` heat.
- Yellow shots are one beam that visually shows as two thin parallel lasers with a gap — one bullet, one damage event, fired from the center of the ship.
- Each yellow shot adds `+10%` damage and `+10%` score over base, stacking one step per shot while the bar stays yellow.
- Score keeps the bonus from hot damage already dealt, even if a later non-hot shot gets the final hit.
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

### Debug End Sequence

To jump straight to the level-ending departure sequence for quick testing, append `?debugEnd=1` to the URL before starting a run:

`http://localhost:8080/?debugEnd=1`

Start the game normally from the menu and `GameScene` will go directly into the end-of-level warp-out flow.

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
| 2 | In Progress | Playable ship, laser heat, bullet pool, HUD slice |
| 3 | In Progress | Skirm enemies, collisions, explosions, RunState |
| 4 | In Progress | Level config, wave progression, level-clear flow |
| 5 | Planned | Bosses and boss health bar |
| 6 | In Progress | Bonuses, shared shields, pickup audio, upgrade hooks |
| 7 | Planned | Ship select, passives, boss modifiers |
| 8 | Planned | Sprites, audio, parallax, polish |

---

## License

MIT
