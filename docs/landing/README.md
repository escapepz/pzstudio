# Landing page

Static landing page served at `https://escapepz.github.io/pzstudio/` — the URL the CLI's
one-time first-build print (`?utm_source=cli-print`) and the extension's one-time
first-build popup (`?utm_source=ext-popup`) open. No framework, no build step: the
single `index.html` in this directory is published as-is. The `utm_source` query
parameter needs no page code — GTM captures it from the URL automatically.

## Publish steps (owner)

### 1. Replace the GTM container id

In `docs/landing/index.html`, find the snippet marked:

```html
<!-- OWNER: replace with the real container id before publishing -->
```

and replace the single `GTM-XXXXXXX` occurrence in the Google Tag Manager snippet
with the real container id. Until replaced, the page still renders fine locally (the
placeholder container request just fails — harmless); do not publish with the
placeholder.

### 2. Enable GitHub Pages

On GitHub, for `escapepz/pzstudio`: **Settings → Pages → Build and deployment**,
set **Source: Deploy from a branch**, **Branch: `gh-pages`**, folder **`/ (root)`**.
The site then serves at `https://escapepz.github.io/pzstudio/`.

### 3. Create / update the `gh-pages` orphan branch

The `gh-pages` branch is a standalone orphan branch containing only `index.html`,
synced from this directory via a temporary worktree (never merge `gh-pages` into a
code branch). Commands below assume the repo is checked out next to the worktree as
`../pzstudio` — adjust that path if your checkout is named differently.

One-time creation (Git Bash):

```bash
git fetch origin
git worktree add --detach ../pzstudio-gh-pages
cd ../pzstudio-gh-pages
git checkout --orphan gh-pages
git rm -rf .
cp ../pzstudio/docs/landing/index.html index.html
git add index.html
git commit -m "docs: publish landing page from docs/landing/"
git push -u origin gh-pages
cd ../pzstudio
git worktree remove ../pzstudio-gh-pages
```

(PowerShell: replace the `cp` line with `Copy-Item ..\pzstudio\docs\landing\index.html index.html`.)

Later updates to the landing page (Git Bash):

```bash
git fetch origin
git worktree add ../pzstudio-gh-pages gh-pages
cd ../pzstudio-gh-pages
cp ../pzstudio/docs/landing/index.html index.html
git add index.html
git commit -m "docs: publish landing page from docs/landing/"
git push origin gh-pages
cd ../pzstudio
git worktree remove ../pzstudio-gh-pages
```

If `git worktree remove` complains about leftovers, append `--force`.

### 4. Wave-2 pre-launch checklist

Before the public push (Wave 2), capture the baselines — npm downloads, GitHub
traffic, marketplace installs — into the **"Campaign scoreboard"** section of
`GROWTH_PLAN.md` (growth-plan bundle, outside this repo), per the campaign design's
Wave-2 gate. The landing page must be live and the real GTM container receiving
events before the baselines are frozen.
