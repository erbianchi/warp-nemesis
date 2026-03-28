# AGENTS.md — Warp Nemesis

## Project Overview

Top-down space shooter roguelike inspired by **Firepower 2000** (SNES). Fast-paced, vertical-scrolling action. The player pilots a starship through 7 procedurally varied levels, accumulates weapons, bonuses, and upgrades, and faces escalating threats including mid-bosses and end-bosses.

Built with **Phaser 3** (HTML/JS/CSS). Modular architecture. Single-page app, no build toolchain required — runs directly in a browser via a local HTTP server or `file://` with a Phaser CDN.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Game framework | Phaser 3 (CDN: `https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js`) |
| ML runtime | TensorFlow.js (script tag in `index.html`) |
| Language | Vanilla ES6+ modules (no TypeScript, no bundler) |
| Styling | CSS (minimal — canvas-based game, CSS handles UI chrome only) |
| Entry point | `index.html` |
| Module system | Native ES modules (`type="module"`) |

No npm, no webpack, no Vite. Keep the dev loop frictionless. A simple `python -m http.server` or VS Code Live Server is sufficient.

---

## Repository Structure

```
/
├── index.html                  # Entry point, Phaser CDN, canvas mount
├── style.css                   # Global styles (background, UI chrome)
├── main.js                     # Phaser game config, scene registry
│
├── config/
│   ├── game.config.js          # Global constants (canvas size, physics, gravity)
│   ├── enemyLearning.config.js # Adaptive enemy-learning and model-training settings
│   ├── levels.config.js        # Level definitions (enemies, waves, scrollspeed, boss)
│   ├── weapons.config.js       # All weapon definitions
│   ├── ships.config.js         # All player ship definitions
│   └── bonuses.config.js       # All bonus/pickup definitions
│
├── scenes/
│   ├── BootScene.js            # Asset preload
│   ├── MenuScene.js            # Main menu, ship select
│   ├── HUDScene.js             # Persistent HUD overlay (runs parallel to game)
│   ├── GameScene.js            # Core game loop, orchestrator
│   ├── LevelTransitionScene.js # Between-level screen (score, upgrades)
│   ├── GameOverScene.js        # Death screen
│   └── VictoryScene.js         # Win screen
│
├── entities/
│   ├── PlayerShip.js           # Player entity, state machine
│   ├── BonusPickup.js          # White octagon pickup entity
│   ├── EnemyBase.js            # Abstract base class for enemies
│   ├── enemies/
│   │   ├── Fighter.js
│   │   ├── Bomber.js
│   │   ├── Interceptor.js
│   │   ├── TurretDrone.js
│   │   ├── Kamikaze.js
│   │   └── [others as needed]
│   └── bosses/
│       ├── BossBase.js
│       └── [one file per boss, named Boss_L1.js … Boss_L7.js]
│
├── weapons/
│   ├── WeaponManager.js        # Attach/detach weapons, fire routing
│   ├── Bullet.js               # Base projectile
│   └── [one file per weapon type: Laser.js, SpreadShot.js, Missile.js, etc.]
│
├── systems/
│   ├── WaveSpawner.js          # Reads level config, schedules enemy waves
│   ├── ScrollingBackground.js  # Parallax starfield layers
│   ├── CollisionSystem.js      # All overlap/collider registrations
│   ├── BonusSystem.js          # Bonus drop logic, pickup handling
│   ├── ShieldController.js     # Reusable shield logic + shield bar visuals
│   ├── RunState.js             # Roguelike run state (singleton): score, lives, active weapons, upgrades
│   ├── EffectsSystem.js        # Explosions, screen flash, particles
│   └── ml/
│       ├── AdaptiveStatsResolver.js
│       ├── EnemyAdaptivePolicy.js
│       ├── EnemyDatasetStore.js
│       ├── EnemyFeatureEncoder.js
│       ├── EnemyLearningSession.js
│       ├── EnemyLearningStore.js
│       ├── EnemyPolicyMath.js
│       ├── LogisticRegressor.js
│       ├── SquadDatasetStore.js
│       ├── SquadFeatureEncoder.js
│       ├── SquadLearningStore.js
│       └── SquadPolicyNetwork.js
│
├── ui/
│   ├── HUD.js                  # Health bar, shield bar, weapon slots, score
│   ├── ShipSelectUI.js         # Ship selection screen component
│   └── UpgradeUI.js            # Between-level upgrade picker
│
├── assets/
│   ├── sprites/                # PNG spritesheets and individual sprites
│   ├── audio/                  # SFX and music (OGG + MP3 fallback)
│   └── tilemaps/               # Optional: Tiled JSON for level terrain
│
└── tests/
    ├── helpers/
    │   └── phaser.mock.js      # Minimal Phaser stubs (scene, physics, events) for unit tests
    ├── config/
    │   ├── game.config.test.js
    │   ├── levels.config.test.js
    │   ├── weapons.config.test.js
    │   ├── ships.config.test.js
    │   ├── bonuses.config.test.js
    │   └── events.config.test.js
    ├── systems/
    │   ├── RunState.test.js
    │   ├── WaveSpawner.test.js
    │   ├── BonusSystem.test.js
    │   ├── CollisionSystem.test.js
    │   ├── EffectsSystem.test.js
    │   ├── ScrollingBackground.test.js
    │   └── ml/
    │       ├── EnemyAdaptivePolicy.test.js
    │       ├── EnemyFeatureEncoder.test.js
    │       ├── EnemyLearningSession.test.js
    │       └── LogisticRegressor.test.js
    ├── entities/
    │   ├── PlayerShip.test.js
    │   ├── EnemyBase.test.js
    │   └── enemies/
    │       ├── Fighter.test.js
    │       ├── Bomber.test.js
    │       ├── Interceptor.test.js
    │       ├── Kamikaze.test.js
    │       └── TurretDrone.test.js
    ├── weapons/
    │   ├── WeaponManager.test.js
    │   ├── Bullet.test.js
    │   ├── Laser.test.js
    │   └── Missile.test.js
    └── ui/
        ├── HUD.test.js
        └── UpgradeUI.test.js
```

---

## Architecture Principles

### 1. Scene separation
- `GameScene` is the **orchestrator only**. It does not contain game logic directly. It creates systems, passes references, and delegates.
- `HUDScene` runs **in parallel** with `GameScene` (Phaser scene.launch). It reads from `RunState`.
- Scenes communicate via **Phaser events** (`this.events.emit`) or via the shared `RunState` singleton. No direct scene-to-scene method calls.

### 2. RunState is the single source of truth
`RunState.js` holds everything that persists across levels in a run:
- Current score
- Lives remaining
- Shield level
- Active weapon loadout (slots 1–4)
- Upgrades purchased
- Level reached
- Total kills

All scenes and systems read from and write to `RunState`. It is not a Phaser object — it is a plain JS singleton (exported object). Reset it on new game start.

### 3. Config-driven design
Game balance lives in `config/`. No magic numbers scattered in entity files. Every weapon, enemy, bonus, and level is defined in its config file and referenced by key string.

Example pattern:
```js
// config/weapons.config.js
export const WEAPONS = {
  laser: { damage: 10, fireRate: 200, speed: 600, color: 0x00ffff, spread: 0 },
  spreadShot: { damage: 7, fireRate: 300, speed: 500, color: 0xffff00, spread: 15 },
  missile: { damage: 40, fireRate: 800, speed: 350, homing: true },
  // ...
};
```

### 4. Entity composition over inheritance
`PlayerShip` and enemies use **composition**: they hold references to systems (WeaponManager, EffectsSystem) injected at construction. Avoid deep inheritance chains beyond the single `EnemyBase` → concrete enemy layer.

### 5. Object pools everywhere
Use Phaser's `this.physics.add.group({ classType, maxSize, runChildUpdate })` for bullets, explosions, and enemies. Never `new Bullet()` without a pool. Performance is non-negotiable in a fast-paced shooter.

---

## Game Design Specification

### Player Ships

Three ships, selectable at menu. Each has distinct stats and a passive ability.

| Ship | Armor | Speed | Shield | Passive |
|---|---|---|---|---|
| Vanguard | High | Medium | None | +20% bullet damage |
| Phantom | Low | High | Medium | Dodge roll (brief invincibility) |
| Fortress | Very High | Low | High | Auto-repair (slow HP regen) |

All ships start with the same base weapon (single laser) in slot 1. Slot 2 starts empty.

### Weapon System

- Player has **2 weapon slots**.
- Slot 1 starts loaded with the laser. Slot 2 is unlocked empty and filled via drops or level-transition picks.
- Both weapons fire simultaneously when the fire key is held.
- Weapons are picked up as bonuses or chosen at level transition.

**Weapon roster (minimum, expand as needed):**

| ID | Name | Behavior |
|---|---|---|
| `laser` | Laser | Single fast beam, straight |
| `spreadShot` | Spread Shot | 3-way fan |
| `missile` | Missile | Slow, homing, high damage |
| `plasma` | Plasma Burst | Short-range, area damage |
| `railgun` | Railgun | Pierces multiple enemies |
| `dualLaser` | Dual Laser | Two parallel beams |
| `bomb` | Proximity Bomb | Drops behind, area explosion |

### Bonus / Pickup System

Enemies drop bonuses on death (probability per enemy type defined in config).

| Bonus | Effect |
|---|---|
| Shield Recharge | Restore shield to full |
| Health Pack | +25 HP |
| Weapon Drop | Random weapon for an empty slot |
| Score Multiplier | 2x score for 10 seconds |
| Speed Boost | +30% speed for 8 seconds |
| Nuke | Screen-clear explosion |
| Extra Life | +1 life |

### Level Structure

7 levels. Each level = scrolling background + wave sequence + optional mid-boss + end-boss.

| Level | Theme | Scroll Speed | Mid-boss | End-boss |
|---|---|---|---|---|
| 1 | Asteroid Belt | Slow | None | Destroyer Mk.I |
| 2 | Enemy Carrier Approach | Medium | Interceptor Squad | Carrier Gunship |
| 3 | Ion Storm Nebula | Medium | Shield Drone | Nebula Leviathan |
| 4 | Enemy Shipyard | Fast | Constructor Mech | Shipyard Core |
| 5 | Black Hole Perimeter | Fast | Gravity Mines | Event Horizon Guard |
| 6 | Flagship Escort | Very Fast | Escort Wing | Flagship Prow |
| 7 | Command Core | Very Fast | Twin Commanders | Supreme Command AI |

Between each level: `LevelTransitionScene` — shows score delta, offers **3 upgrade choices** (player picks 1). Upgrades are drawn from a pool weighted by run history (no duplicate offers).

### Roguelike Elements

- **Permadeath** per run (configurable: 3 lives default).
- **Upgrade picks** between levels shape each run differently.
- **Weapon drops are random** within a weighted pool (can be configured per level).
- **Boss modifiers**: from level 3 onward, bosses roll one random modifier (enraged speed, extra shield, double projectiles).
- **Run seed**: optional, for reproducibility and sharing.

### Difficulty Scaling

- Enemy HP and damage scale linearly per level via a multiplier in `levels.config.js`.
- Scroll speed increases. Enemy movement patterns become more aggressive.
- No infinite scaling — 7 levels is a closed arc.

### Adaptive Enemy Learning

- Training happens at the end of each game, won or lost.
- Raw gameplay datasets are stored in browser storage, then models are retrained on the full stored dataset.
- Enemy and squad datasets are bounded to a recent rolling window. Do not let training data grow without limit.
- Retraining must run in the background. End-of-run transitions should save datasets immediately and queue TensorFlow work without freezing the screen.
- Enemy fire direction is class-native and must stay class-native:
  - `Skirm` shoots downward.
  - `Raptor` shoots its star burst.
- Better aiming comes from learned positioning, lane choice, speed selection, and shot timing, not by steering bullets toward the player.
- The learned action space should be broad enough to feel meaningful: vertical repositioning, flank / press / evade / retreat choices, and bullet-aware avoidance are all valid control surfaces.
- Collision deaths are part of the feature set and should influence avoidance, especially when the player has a shield up.
- Bullet kills must also be a first-class learning signal. Do not rely on survival labels alone for bullet avoidance.
- Each class has a hard maximum adaptive speed in config. The learning system may choose within the class range, but never beyond it.
- Level 1 squad telemetry bootstraps the future Level 2 squad neural network so data collection starts before Level 2 becomes playable.
- The squad network should have a live runtime consumer. For straight formations, `FormationController` is the seam that should query the squad model and turn it into bounded cadence / spread / vertical-pressure directives.

---

## Unit Testing

### Runner
Uses Node's built-in **`node:test`** module — zero dependencies, native ES module support.

```bash
# Run all tests
node --test --experimental-vm-modules tests/**/*.test.js

# Run a specific file
node --test tests/systems/RunState.test.js

# Run with coverage (Node 22+)
node --test --experimental-test-coverage tests/**/*.test.js
```

Test files are named `*.test.js` and live in `tests/` mirroring the source tree.

### What to test
- **Config files**: validate shape, required keys, no missing references (e.g. every level's boss key exists in enemy config).
- **Systems**: pure logic in `RunState`, `WaveSpawner`, `BonusSystem` — input/output, state transitions, edge cases.
- **Entities**: construction, stat initialization, damage/death logic — anything not dependent on the Phaser render loop.
- **Weapons**: damage values, fire-rate gating, bullet pool allocation.
- **UI**: state-to-display mappings (e.g. correct health bar width for given HP).

### What NOT to test
- Phaser internals (rendering, physics engine, scene lifecycle).
- Anything that requires a live canvas or WebGL context.
- Integration between Phaser objects — cover those with manual playtesting.

### Phaser mock (`tests/helpers/phaser.mock.js`)
All Phaser dependencies are stubbed here. Import it at the top of any test that instantiates a class that uses Phaser APIs. The mock provides minimal no-op implementations of `scene`, `physics.add`, `events`, `add.group`, etc. — enough for logic to run without a browser.

### Conventions
- Use `node:test` (`test`, `describe`, `it`) and `node:assert` (`assert.strictEqual`, `assert.deepStrictEqual`, `assert.throws`).
- One `describe` block per class/module, multiple `it` blocks for cases.
- Prefer many small focused tests over large integration-style tests.
- Each test file is self-contained: import only what it needs, set up state in `beforeEach`, tear down in `afterEach`.
- Test file names match source: `systems/RunState.js` → `tests/systems/RunState.test.js`.

---

## Coding Conventions

- **ES6 modules** throughout. One class or system per file. Named exports preferred.
- **No globals** except the Phaser game instance in `main.js`.
- **Event names** are string constants defined in `config/events.config.js`. Never inline event name strings.
- **JSDoc** on all public methods. Minimal but present.
- **Defensive config access**: if a config key is missing, throw a descriptive error at load time, not silently at runtime.
- File names: `PascalCase.js` for classes, `camelCase.config.js` for configs.
- No CSS frameworks. `style.css` is minimal: black background, canvas centered, a loading overlay.

---

## Development Phases (Step by Step)

We build incrementally. Each phase produces a **playable, runnable state**. Never leave the game broken between phases.

### Phase 1 — Skeleton
- `index.html`, `style.css`, `main.js`
- `BootScene` with placeholder assets (colored rectangles)
- `MenuScene` with a Start button
- `GameScene` with a moveable player rectangle
- `ScrollingBackground` (simple starfield, no parallax yet)

### Phase 2 — Player & Shooting
- `PlayerShip` entity with keyboard movement
- `WeaponManager` + `Laser` weapon
- Bullet pool
- Basic `HUDScene` (health bar only)

### Phase 3 — Enemies & Collisions
- `EnemyBase` + `Fighter` enemy
- `WaveSpawner` (hardcoded single wave)
- `CollisionSystem` (bullet/enemy, enemy/player)
- `EffectsSystem` (explosion placeholder)
- `RunState` initialized

### Phase 4 — Level Config & Progression
- `levels.config.js` wired into `WaveSpawner`
- `LevelTransitionScene` (no upgrade UI yet, just "Continue")
- `GameOverScene`

### Phase 5 — Bosses
- `BossBase` + `Boss_L1`
- Boss health bar in HUD
- Boss patterns (phase-based)

### Phase 6 — Weapons & Bonuses
- All weapon types
- `BonusSystem` + pickup drops
- Weapon slot UI in HUD
- `UpgradeUI` in `LevelTransitionScene`

### Phase 7 — Ships & Roguelike Layer
- `ShipSelectUI` in `MenuScene`
- All 3 player ships with passives
- Boss modifiers
- Run seed system

### Phase 8 — Polish
- Parallax starfield layers
- Sprite assets replacing rectangles
- SFX and music
- Screen shake, flash effects
- Performance audit (object pool review)
- `VictoryScene`

---

## Asset Conventions

- Sprites: PNG, power-of-two dimensions where possible.
- Spritesheets: defined in `BootScene` with explicit frame dimensions.
- Audio: OGG primary, MP3 fallback. Load both in `BootScene`.
- Placeholder assets: colored rectangles via Phaser Graphics during early phases — do not block development on art.

---

## Running the Game

```bash
# From project root
python -m http.server 8080
# then open http://localhost:8080
```

Or use VS Code Live Server extension.

Do not open `index.html` directly as `file://` — ES modules require HTTP.

---

## Current State (as of 2026-03-28)

### What is implemented and working
- `BootScene` — generates placeholder textures (player, skirm, bullets, particles, bonus octagon) and preloads the current SFX set
- `MenuScene` — Start button, transitions to GameScene
- `GameScene` — main loop: player movement, weapon firing, enemy management, player/enemy/bonus collision, bonus pickups, shared shield handling, score/lives/status HUD, and the level-clear exit sequence
- `ScrollingBackground` — scrolling starfield with warp speed-lines and fade-to-black support for level completion
- `WeaponManager` — laser weapon, bullet pool, 2-slot display, heat / warning-shot behavior, overheat cooling sound
- `RunState` — score and kill tracking
- `EnemyBase` — abstract base class for enemies with optional reusable shield support
- `Skirm` — first enemy type; formation and organic dances including abrupt/jinking motion
- `Raptor` — side-entry heavy raider that arrives in overlapping pairs and fires 8-way blue bursts
- `Mine` — slow overlay hazard with heavy contact damage and a Phaser gravity well
- `FormationController` — squadron dance controller with alternating side entries, reforming, drift, moving fire, and top-side returns
- `WaveSpawner` — roguelike pool-based wave/squadron/plane system; stat resolution; formation positions; squadron staggered spawning; overlay raid scheduling
- `systems/ml/*` — adaptive enemy learning stack with browser-persisted datasets, TensorFlow-backed retraining, staged model promotion, and Level 1 squad bootstrapping for the future Level 2 squad network
- `BonusSystem` — weighted bonus drops, shielded pickups, collection payloads, pickup-sound routing
- `BonusPickup` — white octagon pickup entity with slower drift and optional shield shell
- `ShieldController` — reusable shield ring, local shield bar, shield damage routing, break animation hook
- `EffectsSystem` — explosions, shield break blasts, floating damage / pickup text, gravity-well particles
- `levels.config.js` — currently **1 playable level** with **16 Skirm waves**, overlay Raptor/Mine events, and short wave-to-wave pacing
- `bonuses.config.js` — live bonus definitions, pickup motion tuning, pickup sounds, random bonus shield roll config
- `enemies.config.js` — `skirm`, `raptor`, and `mine` stats + `standard`, `heavy`, `light`, `ace` plane presets with shield modifiers and per-class adaptive speed caps
- `debug.config.js` — URL query driven runtime debug flags such as `?debugEnd=1` for jumping straight to the level-complete sequence

### Current adaptive-learning behavior
- End-of-game learning saves raw enemy and squad datasets into browser storage.
- Enemy bullet kills produce a direct bullet-risk training label in addition to generic survival pressure.
- Enemy and squad datasets are pruned to a recent rolling window before retraining.
- Retraining is queued in the background so level-complete and game-over screens stay responsive.
- Retrained weights are staged and promoted on the next game load; the current run never changes mid-flight.
- `Skirm` keeps its downward shot and `Raptor` keeps its native star burst. Learned policy affects movement, positioning, and allowed speed within class bounds.
- Straight-formation `Skirm` squads fire through `FormationController` cadence patterns. Do not stack a squad controller loop on top of each ship's autonomous fire loop.
- After the first basic dance completes, `FormationController` also queries the squad network at runtime and applies bounded cadence / spread / vertical-slot directives to the living squad.
- Player-bullet threat and survival pressure are part of the runtime decision process, so enemies can actively dodge and choose better shot windows.
- Level 1 squad telemetry already feeds the future Level 2 squad neural network.
- The current `Skirm` adaptive top speed is intentionally conservative to keep Level 1 readable.

### What is stub / not yet implemented
- `PlayerShip.js` — empty; player is currently a plain rectangle in GameScene
- All enemy types except Skirm (`Fighter`, `Bomber`, `Interceptor`, `Kamikaze`, `TurretDrone`)
- All bosses (`BossBase`, `Boss_L1` … `Boss_L7`)
- All weapons except laser (`SpreadShot`, `Missile`, `Plasma`, `Railgun`, `DualLaser`, `Bomb`)
- `CollisionSystem` — overlap/collider setup still lives in `GameScene`
- `HUDScene`, `LevelTransitionScene`, `GameOverScene`, `VictoryScene` — empty stubs
- `ships.config.js` — still empty
- Levels 2–7 — not defined

### Key architectural rules
- **Do not add anything to the game that was not explicitly requested.** No HUD elements, text overlays, menus, or features unless asked.
- `GameScene` is the orchestrator only — it creates systems, delegates, and listens to events. No raw game logic inline.
- All event names live in `config/events.config.js`. Never inline event strings.
- Formation (straight dance) is driven by `FormationController`, not by individual enemy entities.
- Squad firing cadence for straight formations belongs in `FormationController` via per-squad controller config such as `shotCadence`. Individual `fireRate` still matters as readiness within the squad cadence.
- `WaveSpawner` emits `SQUADRON_SPAWNED` after each squadron spawns; `GameScene` listens to create `FormationController` for straight-dance squadrons.
- Keep `config/` as the authoritative source for all balance numbers.
- Heavy model retraining should stay off the critical render path. Save datasets synchronously if needed, but queue TensorFlow retraining in the background.
- Phaser **3.x** only. Arcade Physics throughout — no Matter.js.
- Target **60fps** on a mid-range laptop.

## Notes for Codex

- Only implement what is explicitly requested. Do not add creative decisions, UI, or features on your own.
- When adding a new entity or system, wire it into `GameScene` and verify the game still runs before proceeding.
- When modifying `RunState`, check all consumers for consistency.
- Phaser version: **3.x** (not Phaser 2 / CE). Use `this.physics.add`, `this.add.group`, Arcade Physics throughout — no Matter.js unless explicitly requested.
- The game must run at **60fps** on a mid-range laptop. Profile before adding particle-heavy effects.
