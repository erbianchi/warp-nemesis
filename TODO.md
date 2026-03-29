# Adaptive Squad Pressure Overhaul

## Goal

Make enemy squads feel alive on screen:

- Raptors must stop hovering on their lane.
- Skirm squads must stop reading like dancers with random shots.
- Squads must choose a visible attack, commit to it, and only fire when the geometry is threatening.

## Player-Facing Acceptance Criteria

- [x] A Raptor pair enters, commits within a short window, brackets or collapses on the player lane, and fires during that attack window.
- [x] A still player is punished by Raptor pressure instead of being allowed to idle safely.
- [x] A Skirm formation completes its readable entry path, then transitions into a coordinated pressure phase instead of drifting harmlessly.
- [x] Skirm volleys happen during visible pressure windows, not just because cooldowns are ready.
- [x] Squad controllers expose runtime behavior metrics so pressure can be inspected from the dev console.

## Metrics To Track In Runtime

- [x] `timeToCommitMs`
- [x] `pressureOccupancyMs`
- [x] `bracketMs`
- [x] `coordinatedVolleyCount`
- [x] `playerDisplacementPxMax`
- [x] `forcedReactionCount`
- [x] `deadAirMs`

## Work Breakdown

### 1. Config and Tracking

- [x] Add explicit squad pressure timing and geometry config to `config/enemyLearning.config.js`.
- [x] Keep new balance values in config instead of hardcoding them in controllers.
- [x] Add a tracked TODO entry for each gameplay milestone completed.

### 2. Wing Doctrine Runtime

- [x] Remove moving-home targeting from `systems/WingDoctrineController.js`.
- [x] Replace x-sorted wing roles with stable role assignment based on squad order.
- [x] Add explicit objective phases for wings:
  - [x] `entry`
  - [x] `commit`
  - [x] `attack`
  - [x] `recover`
- [x] Make objectives hold for a real window instead of retargeting every replan.
- [x] Make wing anchors derive from objective geometry, not from blended current position.
- [x] Gate wing volleys so they only happen during a valid attack window.
- [x] Count a coordinated volley only when geometry is valid.
- [x] Track visible pressure metrics for wings.
- [x] Expose wing behavior snapshots and metrics to the dev console.

### 3. Raptor Pressure

- [x] Keep Raptor native star-burst fire intact.
- [x] Make Raptor post-entry movement honor committed doctrine anchors strongly enough to leave the entry lane.
- [x] Make Raptor attack windows visible with a lower pressure line and a stable bracket.
- [x] Ensure Raptors do not keep firing while still just drifting into place.

### 4. Formation Pressure Runtime

- [x] Keep authored formation entry paths readable in `systems/FormationController.js`.
- [x] Stop treating idle as endless drift plus free-fire.
- [x] Add explicit post-entry assault phases for formations:
  - [x] `commit`
  - [x] `attack`
  - [x] `recover`
- [x] Use doctrine to shape the assault anchors, not to smear every path step.
- [x] Make front-row / flank roles visibly different during attack.
- [x] Gate formation volleys behind attack geometry.
- [x] Track formation pressure metrics and expose them to the dev console.

### 5. Skirm Coordination

- [x] Make Skirm squads attack soon after forming up.
- [x] Prevent long harmless idle windows before the first real attack.
- [x] Make crossfire, collapse, and suppress patterns visually distinct.

### 6. Validation

- [x] Run focused tests for Raptors, Skirms, and formation flow.
- [x] Verify no syntax regressions in the modified controllers.
- [ ] Live browser playtest and feel check.

## Notes

- Mines stay excluded from squad doctrine pressure work.
- Do not reintroduce “soft drift with smarter names” as the main behavior layer.
