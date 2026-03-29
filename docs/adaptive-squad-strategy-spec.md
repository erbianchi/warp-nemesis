# Adaptive Squad Strategy Spec

## Goal

Make the adaptive enemy system feel alive.

The player should be able to read intent from a squad in under two seconds:

- `suppress`: the squad compresses around the player lane and keeps a firing lane pinned.
- `crossfire`: left and right wings hold offset lanes and alternate pressure.
- `encircle`: wings widen, center pressure holds, and the player is boxed into a corridor.
- `collapse`: the formation converges and pushes lower for a short kill window.
- `feint`: center mass eases off, side elements bait movement, then the next row fires.
- `scatter`: the squad widens, rises, and stops feeding bullets into a bad lane.

## Problems In The Old System

- Enemy learning stored bullet and collision labels, but runtime behavior only ranked on survival and offense.
- Squad learning produced only scalar cadence and spacing changes, so waves looked different but not strategic.
- Straight formations only refreshed directives at coarse phase boundaries, so they did not react to the player in the moment.
- Cold-start behavior was too neutral because untrained models collapsed to `0.5` and there was little tactical fallback.

## Fix List

- Carry bullet-risk and collision-risk labels all the way from telemetry to runtime scoring.
- Blend neural outputs with readable heuristics so the first few runs already look intentional.
- Convert squad predictions into named doctrines instead of raw scalar-only tweaks.
- Refresh squad directives during idle drift and before every volley, not only on long pattern transitions.
- Let doctrine control both where ships sit and which ships fire.
- Gate enemy firing on favorable windows so enemies stop shooting blindly into obvious death lanes.
- Add a shared wing-doctrine controller for armed non-formation squads so Raptors and non-straight Skirms can coordinate too.
- Keep Mine overlays out of doctrine control; they stay authored denial hazards, not tactical wings.
- Lock the behavior down with tests that assert doctrine choice, volley selection, and risk-aware ranking.

## Runtime Design

### Enemy scorer

Each enemy candidate move is scored with four signals:

- `survival`
- `offense`
- `collision risk`
- `bullet risk`

The runtime score is:

`survival + offense - collision risk - bullet risk - spatial penalties`

The live scorer blends:

- heuristic tactical priors for immediate readability
- learned neural predictions when enough samples exist

This keeps early runs readable and lets the model gradually personalize movement later.

### Squad strategist

The squad model still predicts:

- `win`
- `pressure`
- `collision`

Those outputs are blended with live heuristics and then translated into a doctrine.

The doctrine controls:

- firing pattern selection
- spacing and lane width
- drift tightness
- vertical pressure
- focus lane
- flank offset
- per-ship tactical anchor in idle

### Formation controller responsibilities

`FormationController` must:

- refresh squad directives during idle movement and before each volley
- reposition ships around a doctrine-specific anchor, not only their static slot
- choose shooters with doctrine-aware selection rules

New volley patterns:

- `focus_lane`
- `crossfire`
- `encircle`
- `collapse`
- `stagger_pin`

### Wing doctrine controller responsibilities

`WingDoctrineController` must:

- own volley timing for armed non-formation squads
- resolve a doctrine anchor per live ship and feed it back into class-native movement
- preserve class-native fire shapes, especially the Raptor star burst
- wait until adaptive movement is actually ready before giving a ship doctrine-owned firing windows
- exclude Mine-only overlays from this flow so hazard behavior stays readable

## Acceptance Criteria

- Level 1 straight formations visibly change intent while the player is moving, not only when a new cycle begins.
- Overlay Raptor pairs visibly hold mirrored lanes and fire as a coordinated wing instead of two unrelated raiders.
- A high bullet-threat situation causes squads to widen or scatter instead of continuing the same volley cadence.
- Pressure-heavy squads visibly compress or collapse toward the player lane.
- Wide squads can hold mirrored lanes and fire from both sides instead of behaving like a single blob.
- Enemy fire timing respects favorable windows and avoids obviously suicidal bullet lanes.

## Test Coverage

The adaptive suite should verify:

- bullet and collision risk propagate from training labels to runtime candidate ranking
- squad directives can resolve to distinct doctrines
- `FormationController` uses doctrine-specific volley selection
- `WingDoctrineController` applies mirrored anchors and native-volley coordination for Raptor wings
- tactical directives change slot/idle targets, not just cadence scalars
