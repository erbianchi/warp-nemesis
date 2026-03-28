# Warp Nemesis

Warp Nemesis is a top-down vertical shooter roguelike prototype inspired by **Firepower 2000** (SNES). The current build is a playable Phaser 3 slice with one full level, live pickups, a post-level store, browser-persisted meta progression, and browser-persisted enemy-learning data.

Built with **Phaser 3**, **TensorFlow.js**, and native ES modules. No npm, no bundler, no build step.

---

## Current Playable Slice

- **Main menu and immediate play loop**: start from the menu, launch straight into gameplay, and return to the menu with `Esc`.
- **One playable level**: Level 1 is live with 16 Skirm waves, short pacing between waves, and overlay threats that continue while the main wave flow advances.
- **Three active enemy types**:
  - **Skirm**: basic formation enemy with mixed authored and organic movement.
  - **Raptor**: heavier side-entry raider that arrives in overlapping pairs and fires burst patterns.
  - **Mine**: slow drifting hazard with a gravity well, `200` contact damage, and a dedicated blast when destroyed.
- **Learned movement policy**:
  - `Skirm` and `Raptor` reposition using persisted ML guidance instead of changing their bullet directions.
  - `Skirm` adaptive speed is intentionally capped tighter than before, with a current class max scalar of `1.15`.
  - The learned action space now includes vertical repositioning, player-lane pressure, flank choices, evade choices, and smarter shot timing.
  - Straight `Skirm` squadrons now fire through squad-owned cadence patterns instead of stacking every ship's personal fire loop into a wall of beams.
  - Level 1 squad telemetry now both bootstraps and drives the runtime Level 2-style squad directive path for cadence, spread, and vertical pressure.
- **Live weapon path**: slot 1 starts with `LASER` and can currently switch to `T-LASER` or `Y-LASER`.
- **Live bonuses**: `1-Up`, `+50 Life`, `+50 Shield`, `Cooling Boost`, `LASER x2`, `T-LASER`, `Y-LASER`, and `Weapon Upgrade`.
- **Shielded pickups**: bonuses can roll a random shield from `100` to `200` points and must be shot open before collection.
- **Laser heat system**: the main weapon uses a 30-shot heat bar with yellow-zone damage and score bonuses, plus a full overheat lockout.
- **Post-level store**: finishing the level opens a store where total score can be spent on permanent upgrades for future runs.
- **Persistent meta progression**: total score and owned store bonuses are saved in browser storage and reloaded on the next run.
- **Adaptive enemy learning**: enemy and squad telemetry is stored in browser storage at the end of each game, retrained in the background, and applied on the next run after the staged model is promoted.
- **Generic enemy destruction pipeline**: enemy deaths route through shared destroy logic, type-specific explosion profiles, and a nearby shockwave push that can shove nearby enemies aside.

## Adaptive Enemy Learning

- **Enemy fire stays native to the class**:
  - `Skirm` always shoots straight down.
  - `Raptor` always fires its native 8-way star burst.
- **Aiming improves through movement, not bullet steering**: learned models choose safer and more threatening lanes so enemies line up their native shots better.
- **Behavior is no longer just a tiny X nudge**: runtime candidates now cover horizontal and vertical repositioning, press / flank / evade / retreat modes, and shot-window selection.
- **Straight squad fire is controller-owned**: `FormationController` defines bounded per-squad volleys through `controller.shotCadence`, while each ship's own `fireRate` still influences readiness inside the squad pattern.
- **Shield and collision context are part of the data**: the dataset records player position, shield state, weapon state, enemy and squad position, and whether an enemy died by colliding with the player.
- **Projectile pressure is part of the data**: the feature set tracks nearby player-bullet threat, and bullet kills now produce a direct learned bullet-risk label instead of relying on survival alone.
- **Browser-persisted datasets**:
  - Enemy-class training data lives in `warp-nemesis.enemyLearning.dataset`.
  - Squad training data lives in `warp-nemesis.enemyLearning.squadDataset`.
  - Active model snapshots live in `warp-nemesis.enemyLearning` and `warp-nemesis.enemyLearning.squad`.
- **Datasets are bounded**: both enemy and squad datasets keep only a recent rolling window so obsolete early-run behavior does not dominate forever.
- **Background retraining**: end-of-game transitions save datasets immediately, then queue TensorFlow retraining in the background so the screen does not freeze.
- **Staged promotion**: retrained weights are staged and promoted on the next game load. The current run never changes mid-game.
- **Runtime squad directives**: the stored squad network is now queried by `FormationController` after the basic dance completes so straight squads can adapt cadence, spread, and vertical slot pressure at runtime.

## Current Store

The store appears after a completed level and uses persistent `totalScore` banked from completed levels only.

Current items:

- `+50 HP` for `50000`
- `+50 SHIELD` for `50000`

Both bonuses are permanent and applied at the beginning of all future games.

## Current Bonus and Weapon Notes

- Pickup labels for weapon-flavored bonuses are sourced from the weapon config, so `T-LASER` and `Y-LASER` stay in sync with the actual equipped weapon names.
- `LASER x2` stacks the slot-1 laser damage multiplier.
- `Cooling Boost` temporarily speeds up laser heat recovery.
- `Weapon Upgrade` is still present as a pending hook and does not yet unlock a broader upgrade tree.

## Laser Heat

- The default laser uses a `30`-shot heat bar.
- The bar turns yellow at `70%` heat.
- Yellow shots are one bullet rendered as a twin-beam warning laser.
- Each yellow shot adds `+10%` damage and `+10%` score over base, stacking while the bar stays yellow.
- A full overheat locks firing until `20` shots of heat have cooled off.

## Controls

| Action | Keys |
|---|---|
| Move | Arrow keys or WASD |
| Fire | Hold Space |
| Start game | Enter or Space |
| Back to menu | Escape |

## Running Locally

Requires a local HTTP server because ES modules do not load over `file://`.

```bash
# Python 3
python -m http.server 8080

# Node
npx serve .
```

Then open [http://localhost:8080](http://localhost:8080).

Phaser is bundled locally as [`phaser.min.js`](./phaser.min.js). TensorFlow.js is currently loaded by script tag from a CDN for in-browser training.

### Debug End Sequence

To jump straight to the level-complete departure sequence for quick testing, append `?debugEnd=1` to the URL before starting a run:

`http://localhost:8080/?debugEnd=1`

## Running Tests

Uses Node's built-in test runner.

```bash
# All tests
node --test tests/**/*.test.js

# Single file
node --test tests/systems/ScrollingBackground.test.js

# Coverage (Node 22+)
node --test --experimental-test-coverage tests/**/*.test.js
```

## Tech Stack

| | |
|---|---|
| Framework | [Phaser 3](https://phaser.io) |
| ML | [TensorFlow.js](https://www.tensorflow.org/js) |
| Language | Vanilla ES6+ modules |
| Tests | Node built-in `node:test` |
| Build | None |

## Project Structure

```text
├── index.html              # Entry point
├── main.js                 # Phaser config and scene registry
├── style.css               # Minimal chrome
├── phaser.min.js           # Local Phaser 3 runtime
│
├── config/                 # Balance data and game constants
├── scenes/                 # Phaser scenes
├── entities/               # Enemies and pickups
├── weapons/                # Weapon logic and bullet pool
├── systems/                # Spawner, effects, run state, meta progression
│   └── ml/                 # Adaptive enemy learning, datasets, and model storage
├── ui/                     # UI components and scene helpers
└── tests/                  # Unit tests mirroring the source tree
    └── systems/ml/         # ML regression and persistence tests
```

## Planned / Not Yet Implemented

The long-term game direction is still larger than the current playable slice. These pieces are still partial or missing:

- ship select and the full three-ship roster
- bosses and levels 2 through 7
- the broader weapon roster beyond the live laser variants
- full between-level upgrade drafting
- victory flow and endgame content polish

## Development Status

| Phase | Status | Description |
|---|---|---|
| 1 | Done | Skeleton, menu, starfield, moveable player |
| 2 | Done | Core firing loop, bullet pool, heat HUD slice |
| 3 | Done | Enemy spawning, collisions, explosions, RunState |
| 4 | Done | Level progression, level-clear flow, post-level store |
| 5 | Planned | Bosses and boss health bar |
| 6 | In Progress | Bonuses, shared shields, weapon pickups, pickup audio |
| 7 | In Progress | Meta progression, store, ship select, per-run upgrade drafting |
| 8 | Planned | Additional content, art, audio, and polish |

## License

MIT
