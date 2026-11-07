# PZ Studio — Project Cockpit Interaction Spec v1

## 1. Product intent

Project Cockpit is the primary PZ Studio surface inside VS Code.

Mental model:

> PZ Studio manages modding projects, not the editor.

A user looking at the Cockpit should be able to answer immediately:

- which project they are working in;
- whether the project is healthy;
- which mods are included, dev-only, excluded, or missing;
- whether Development Sync is running;
- what the current build target is;
- whether something must be fixed before continuing.

Command Palette, Tasks, and context menus are secondary entry points into the same operation model.

---

## 2. Top-level structure

```text
PZ STUDIO

▼ Better Farming Pack
  3 mods · Production                         ✓ Ready

  Mods
    ● Better Farming                          Included
    ◐ Debug Helpers                           Dev only
    ○ Legacy Compat                           Excluded
    ⚠ Old Items                               Missing on disk

  Development
    ● Development Sync                        Up to date
      Main + Development
      Last sync: just now

  Build
    Production                                Ready

  Project Health
    ✓ No blocking issues

  ▸ Project Files

OTHER PROJECTS
  ▸ Map Tools
  ▸ Vehicle Experiments
```

Ordering is fixed:

1. Project Header
2. Mods
3. Development
4. Build
5. Project Health
6. Project Files
7. Other Projects

Filesystem ordering must not determine the information architecture.

---

## 3. Active Project model

### 3.1 Single-project workspace

If exactly one PZ Studio project exists:

- automatically make it active;
- do not show a project picker;
- do not emit a “selected project” notification;
- render its Cockpit immediately.

### 3.2 Multi-project workspace

Exactly one project is active at a time.

Selection precedence:

1. project containing the active editor, when clearly resolvable;
2. current active project retained for this extension-host session;
3. otherwise the first discovered project.

An editor change may switch the active project only when the active editor belongs unambiguously to another discovered project.

Do not switch because of arbitrary file focus outside every project.

### 3.3 Switching project

Other Projects appears collapsed at the bottom:

```text
OTHER PROJECTS
  ▸ Map Tools
  ▸ Vehicle Experiments
```

Selecting another project switches Active Project.

Switching:

- does not run Build;
- does not mutate project files;
- updates Cockpit sections to the newly active project;
- triggers only the Project Health refresh behavior defined in §8.

Command Palette additionally exposes:

`PZ Studio: Switch Project…`

### 3.4 Active Development Sync when switching projects

If Project A is syncing and the user merely switches the Cockpit to Project B:

- A continues syncing;
- Cockpit B clearly indicates that Development Sync is currently owned by A.

Example:

```text
Development
  ○ Development Sync
    “Better Farming Pack” is currently syncing.

    Switch Sync to This Project…
```

Do not silently stop A.

---

## 4. Project Header

The header owns identity and aggregate status only.

It does not contain permanent Build or Sync primary buttons.

Healthy:

```text
Better Farming Pack
3 mods · Production                         ✓ Ready
```

Warning:

```text
Better Farming Pack
3 mods · Production                       ⚠ 2 issues
```

Syncing:

```text
Better Farming Pack
3 mods · Production                        ● Syncing
```

Blocking:

```text
Better Farming Pack
3 mods · Production                 ✕ Action required
```

### Status precedence

When multiple states exist, display one aggregate headline state using:

1. blocking Project Health error;
2. fatal Development Sync error;
3. Development Sync starting/syncing;
4. Project Health warning;
5. ready.

Detailed states remain visible in their own sections.

Do not stack multiple competing badges in the header.

### Header context menu

Allowed:

- Switch Project…
- Open Project Folder
- Refresh
- Refresh Project Health
- Project Settings / Configure Project, if such a surface exists

Do not place Build, Clean, Delete Mod, or unrelated operations here.

---

## 5. Mods section

### 5.1 Section header

```text
Mods                                      4
```

Primary section action:

`Add Mod`

Secondary actions:

- Add Mod…
- Refresh

### 5.2 Mod states

The canonical build states are:

- Included
- Dev only
- Excluded

Missing on disk is orthogonal to the build state and overrides normal row rendering for remediation purposes.

```text
● Better Farming                          Included
◐ Debug Helpers                           Dev only
○ Legacy Compat                           Excluded
⚠ Old Items                               Missing on disk
```

Text communicates the state. Icons and color are supplemental only.

### 5.3 Normal mod row interaction

Single click:

- selects the row only.

Selection must not unexpectedly mutate mod state.

Keep inline affordances minimal. Low-frequency actions belong in the context menu.

Context menu:

- Set Included
- Set Dev Only
- Set Excluded
- separator
- Configure Mod…
- Generate mod.info
- Rename…
- separator
- Delete…

The current-state action should be omitted or disabled.

### 5.4 State transition behavior

All state mutations use one operation model.

Example:

`Included → Dev only`

- execute the mutation;
- show transient row/section progress only if perceptible;
- refresh Mods;
- schedule the appropriate Project Health refresh;
- do not show a generic success toast if the changed row already makes success visible.

A no-op state transition is not an error.

### 5.5 Delete

Delete is a context action, not a permanent inline trash control.

Before destructive mutation:

```text
Delete “Better Farming”?

This removes the mod from the project and deletes its mod folder.

[Delete] [Cancel]
```

Cancel means no side effects.

### 5.6 Missing-on-disk row

A missing mod is not treated like a normal on-disk mod.

```text
⚠ Better Farming                          Missing on disk
```

Actions must be remediation-specific.

v1 actions:

- Remove from Project…
- Open project.json
- Refresh

A future action may offer:

- Locate / Restore Folder…

Do not expose operations requiring an existing mod folder, such as:

- Generate mod.info
- normal Configure Mod
- normal Rename
- build-state toggles

unless the operation is explicitly designed to work without the directory.

---

## 6. Development section

Development Sync is the flagship daily-loop feature.

### 6.1 Stopped

```text
Development

○ Development Sync
  Automatically sync changes while you work.

  Start Sync
```

Primary action:

`Start Sync`

### 6.2 Starting

```text
Development

◌ Starting Development Sync…
  Preparing Main + Development
```

The initial full build must have persistent visible state.

Do not rely only on a transient progress notification.

### 6.3 Running / up to date

```text
Development

● Development Sync                       Up to date
  Main + Development
  Last sync: just now
```

Actions:

- Stop Sync
- Restart Sync
- Show Output

### 6.4 Applying changes

```text
● Development Sync                       Syncing…
  4 files changed
```

After successful completion:

```text
● Development Sync                       Up to date
  Last sync: just now
```

Do not emit a success toast for every incremental batch.

### 6.5 Recoverable batch errors

If the session remains alive:

```text
⚠ Development Sync                       Needs attention
  2 files could not be synced.

  Show Problems
```

Do not describe the session as Stopped while its watcher/session remains active.

### 6.6 Fatal startup/session error

```text
✕ Development Sync                       Stopped
  Initial build failed.

  Start Again
  Show Details
```

Where structured error information exists, preserve a concise Problem / Cause / next-action hierarchy.

### 6.7 One-sync-per-window invariant

If A is running and the user attempts to start B:

```text
Development Sync is running for “Project A”.

Stop it and start syncing “Project B”?

[Switch to Project B] [Cancel]
```

On confirmation:

1. stop A completely;
2. ensure watcher/session cleanup has completed;
3. start B;
4. update persistent Development state.

If stopping A fails:

- do not start B;
- present an actionable error.

---

## 7. Build section

### 7.1 Default target

The section displays the effective configured/default build target.

Production:

```text
Build

Production                                  Ready
Build
```

Both:

```text
Build

Production + Development                    Ready
Build
```

Primary Build uses the configured/effective target.

It must not ask for the target on every invocation.

### 7.2 Secondary variants

Expose as secondary actions:

- Build
- Build Production
- Build Development
- Build Both
- separator
- Clean Build Output

An explicit variant overrides the configured target.

It must not be combined with a configured target in a way that generates conflicting flags.

### 7.3 Build states

Only display states the system can actually establish:

- Ready
- Building…
- Completed
- Failed

Do not claim “Up to date” without a real freshness/dependency model.

Building:

```text
Build

Production                              Building…
```

Failed:

```text
Build

Production                                 Failed
  Output directory is in use.

  Try Again
  Show Details
```

Completed may later decay back to Ready or return to Ready after a meaningful project change.

### 7.4 Clean

Clean is a secondary maintenance operation.

It does not receive equal prominence with Build.

“Already clean” is a successful result, not an error.

---

## 8. Project Health section

Doctor is the engine behind Project Health.

“Run Doctor” remains available as a power-user operation but is no longer the primary user mental model.

### 8.1 Healthy

```text
Project Health
✓ Ready
```

### 8.2 Warnings

```text
Project Health
⚠ 2 issues

  Preview image is missing
  Template cache is not populated
```

### 8.3 Blocking errors

```text
Project Health
✕ 1 blocking issue

  Mod “better_farming” folder is missing
```

### 8.4 Diagnostic row

Where possible:

```text
⚠ Output directory is inside this project

  This may cause Development Sync to process its own output.

  Change Output Folder…
```

Actions may derive from stable diagnostic codes when a deterministic safe remediation exists.

Do not infer actions from arbitrary diagnostic message text.

### 8.5 Health refresh policy

Refresh after meaningful changes:

- Active Project changes
- project.json changes
- Add/Delete/Rename Mod
- mod build state changes
- mod configuration changes
- setup/import completes
- Build completes
- initial Development Sync startup succeeds/fails
- explicit Refresh Health

Do not run a full health refresh because of:

- tree expansion/collapse;
- `getChildren`/render cycles;
- arbitrary source saves;
- every incremental Development Sync batch;
- repaint events.

While the first result is being computed:

```text
Project Health
◌ Checking…
```

### 8.6 Stale state

If a previous health result exists and a refresh is running, keep displaying the previous result until the refresh completes.

Do not temporarily flash Ready merely because a report is currently unavailable.

---

## 9. Project Files

Collapsed by default.

```text
▸ Project Files
```

Expanded:

```text
▼ Project Files
  ▸ workshop
  ▸ BetterFarming
  ▸ DebugHelpers
  project.json
```

Purpose:

- convenient navigation;
- not a replacement for the built-in VS Code Explorer.

Do not recreate advanced general filesystem functionality.

“Show All Files” belongs to this section or its section menu, not to the primary project workflow.

---

## 10. Other Projects

Collapsed by default:

```text
OTHER PROJECTS
  ▸ Map Tools
  ▸ Vehicle Experiments
```

Inactive projects are intentionally low-detail.

Example row:

```text
Map Tools                                  ⚠ 1 issue
```

Do not render a complete nested Cockpit for every inactive project.

Reasons:

- Active Project remains the cognitive focus.
- background work remains bounded;
- multi-root workspaces stay manageable.

Selecting a row switches Active Project.

---

## 11. Empty and onboarding states

### 11.1 Empty unrelated workspace

```text
PZ STUDIO

Start developing Project Zomboid mods.

Create New Project
Set Up Existing Mod
```

No warning notification.

### 11.2 Existing-mod detection

When confidence is high and no `project.json` exists:

```text
PZ STUDIO

Project Zomboid mod detected

Set up this mod for builds, Development Sync,
and project health checks.

Set Up Existing Mod
```

A contextual notification may say:

```text
PZ Studio found a Project Zomboid mod in this workspace.

Set it up for Development Sync, builds, and project health checks.

[Set Up] [Not Now]
```

`Not Now`:

- dismisses the notification;
- leaves the Cockpit CTA available;
- causes no file changes.

### 11.3 Detection confidence

Strong evidence may include:

- mod.info
- Build 42 branch containing `media/`
- recognizable PZ mod layout

Supporting evidence may include:

- poster.png
- relevant Lua/media folders
- known PZ metadata

Do not notify on weak evidence alone.

---

## 12. Set Up Existing Mod flow

This is a first-class acquisition flow.

Stages:

```text
Detect
→ Analyze
→ Preview
→ Confirm
→ Set Up
→ Health Check
→ Development Sync CTA
```

### Preview requirement

Before mutation:

```text
Set up “Better Farming” with PZ Studio

Detected
✓ Build 42 mod structure
✓ media/
✓ mod.info
✓ poster.png

PZ Studio will create
+ project.json
+ workshop/description.txt
+ recommended VS Code configuration

Existing mod files will not be moved or overwritten.

Set Up Project
Cancel
```

Invariant:

> Adoption is non-destructive unless a later explicit step clearly states otherwise.

Any required modification to an existing file must be disclosed before confirmation.

---

## 13. Operation model

Every meaningful operation follows the conceptual lifecycle:

```text
Idle
→ Resolving Context
→ Awaiting Input / Confirmation
→ Running
→ Succeeded | Failed | Cancelled
```

Development Sync has a longer lifecycle:

```text
Stopped
→ Starting
→ Running
   ↳ Syncing
   ↳ Needs attention
→ Stopping
→ Stopped
```

### Universal rules

#### Cancel

Cancel means:

- no mutation;
- no fallback selection;
- no second hidden prompt;
- no misleading “project not found” warning.

#### Error

Expected/domain error:

- concise problem;
- useful cause/context;
- recommended next action;
- Details as a secondary action.

Unexpected error:

- safe generic message;
- Show Details;
- Report Issue where appropriate.

#### Success

Do not toast every successful operation.

Prefer persistent state changes when the result is already visible:

- mod state changes → row state changes;
- Build succeeds → Build section changes;
- Sync starts → Development section changes.

Use a success notification only when confirmation would otherwise be invisible.

---

## 14. OutputChannel role

OutputChannel is a diagnostics/details surface.

It is not the primary state UI.

Use it for:

- command details;
- verbose/debug information;
- per-file sync detail;
- unexpected errors;
- troubleshooting.

Expected error example:

```text
Couldn’t build “Better Farming Pack”.

The output folder is in use.

Try Again
Show Details
```

`Show Details` opens/focuses the PZ Studio OutputChannel.

Do not require users to discover hidden details themselves.

---

## 15. Command Palette role

Keep Command Palette support for discoverability and keyboard-driven workflows.

Commands map onto Cockpit operations rather than defining an independent interaction model.

Target commands include:

- PZ Studio: Create New Project
- PZ Studio: Set Up Existing Mod
- PZ Studio: Switch Project…
- PZ Studio: Add Mod…
- PZ Studio: Build
- PZ Studio: Build Production
- PZ Studio: Build Development
- PZ Studio: Build Both
- PZ Studio: Start Development Sync
- PZ Studio: Stop Development Sync
- PZ Studio: Check Project Health
- PZ Studio: Show Output

Prefer product terminology over internal CLI terminology.

In particular:

`watch` → **Development Sync**

---

## 16. VS Code Tasks

Tasks remain a power-user and automation surface.

Their domain semantics must match normal Build:

- Production task means Production regardless of configured default;
- Development task means Development;
- Both task means Both;
- Clean task means Clean.

Tasks must not construct conflicting flags by layering their explicit target on top of the configured target.

Presentation may differ from the Cockpit, but domain semantics may not.

---

## 17. UX invariants

These are design gates for v1.

1. Project-first, not command-first.
2. One Active Project at a time.
3. One Development Sync session per VS Code window.
4. Cancel means no side effects.
5. Same operation has the same domain semantics across every entry point.
6. Important long-running state is persistently visible.
7. Expected failures explain the next useful action.
8. Default UX hides advanced implementation details.
9. Existing-mod adoption is conservative and non-destructive.
10. PZ Studio owns the modding workflow; companion tooling owns code editing/intelligence.
11. Tree state is domain state first, filesystem state second.
12. Never claim a state the underlying engine cannot establish.

---

## 18. v1 priority boundary

### Required before the first Cockpit UX release

- Active Project model
- Project Cockpit hierarchy
- coherent Mods states/actions
- persistent Development Sync state
- unified Build semantics
- Project Health model + bounded refresh
- actionable errors
- cancellation consistency
- normalized Task semantics
- removal of invalid missing-mod actions

### Acquisition milestone

- existing-mod detection
- Set Up Existing Mod
- preview/confirmation flow
- first-value onboarding

### Not required for the 1,000-install milestone

- custom Lua editor/language tooling
- web dashboard
- Steam authentication
- direct Workshop publishing
- multi-project concurrent Development Sync
- team/collaboration system
- AI features
- custom visual mod builder

---

## 19. Success criterion

The primary user journey becomes:

```text
Open workspace
→ project detected / created / set up
→ Cockpit shows the project's state
→ fix blocking issue if necessary
→ Start Development Sync
→ edit + save
→ changes sync successfully
→ Build when a production artifact is needed
```

The user should not need to understand which CLI command, global anchor, template transport, or internal runner produces those outcomes.
