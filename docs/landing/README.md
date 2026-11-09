# Landing page

Static landing page served at `https://escapepz.github.io/pzstudio/landing/` —
the URL the CLI's one-time first-build print (`?utm_source=cli-print`) and the
extension's one-time first-build popup (`?utm_source=ext-popup`) open. No
framework, no build step: the single `index.html` in this directory is served
as-is. The `utm_source` query parameter needs no page code — GTM captures it
from the URL automatically.

**Note the `/landing/` path**: GitHub Pages is configured with **folder
`/docs`** of the repository, so this directory (`docs/landing/`) is served
under `/landing/`. The bare `https://escapepz.github.io/pzstudio/` has no page
and never will (there is no `docs/index.html`) — always link the `/landing/`
URL. Both shipped constants (`first-run.ts`, `firstSuccess.ts`) point there.

## Deployment (owner)

### 1. GTM container id — done

The real container id `GTM-MFR8FN38` is set in `docs/landing/index.html`
(no placeholder remains) and the debug `console.info` on CTA pushes was
removed. Nothing left to do in this step.

### 2. GitHub Pages — done

On GitHub, for `escapepz/pzstudio`: **Settings → Pages → Build and deployment**,
Source = **Deploy from a branch**, folder **`/docs`**. Everything committed
under `docs/` is served at `https://escapepz.github.io/pzstudio/…`; landing
updates ship with the commit that changes `docs/landing/` on the branch Pages
deploys from — no separate branch, worktree, or sync step exists.

### 3. Wave-2 pre-launch checklist

Before the public push (Wave 2), capture the baselines — npm downloads, GitHub
traffic, marketplace installs — into the **"Campaign scoreboard"** section of
`GROWTH_PLAN.md` (growth-plan bundle, outside this repo), per the campaign design's
Wave-2 gate. The landing page must be live and the real GTM container receiving
events before the baselines are frozen.
