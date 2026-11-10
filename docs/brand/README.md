# PZ Studio — Monochrome Brand Identity

Developer-first monochrome brand system in the visual language of modern
developer tooling (Zed / OpenCode / ZCode): pure geometric vector
construction, a strict six-token monochrome palette, technical grids, and
restrained uppercase typography. Zero external font dependencies — every
deliverable is pure `<path>` geometry.

This directory is the canonical brand source. Everything here is generated
deterministically by one script; never hand-edit the artifacts.

## Regenerating the assets

```bash
node docs/brand/tools/generate-brand-assets.cjs
```

The script ports the construction engine from [`studio.html`](./studio.html)
verbatim (Variant 01 — Chamfer Interlock, stroke weight S = 28 on the
256-unit grid) and emits:

| File | Purpose |
| --- | --- |
| `pz-logo-primary-dark.svg` | Primary lockup, dark surface `#090A0B` (560×320) |
| `pz-logo-primary-light.svg` | Primary lockup, light surface `#F8F8F6` (560×320) |
| `pz-icon-standalone-dark.svg` | Squircle app icon, dark (256×256, rx = 22%) |
| `pz-icon-standalone-light.svg` | Squircle app icon, light (256×256, rx = 22%) |
| `pz-wordmark-horizontal.svg` | Horizontal wordmark + `DEV_TOOLS // ENGINE` descriptor (780×200) |
| `pz-studio-github-social-1280x640.svg` | GitHub org social preview (1280×640) |
| `pz-monogram-raw.svg` | Transparent 256×256 monogram symbol (favicon/avatar source) |
| `tokens.css` / `tokens.json` / `tailwind-brand.config.js` | Design token exports (CSS variables, W3C design tokens, Tailwind theme) |
| `packages/vscode-extension/icon.png` | 128×128 marketplace icon (rasterized from the squircle icon) |
| `packages/vscode-extension/resources/pzstudio-banner.png` | 1280×640 marketplace/README banner (rasterized from the social preview) |
| `studio.html` | Interactive parametric brand studio (variants, stroke weights, grid/safe-zone overlays, inspector) |

The rasterized PNGs are produced by a built-in scanline even-odd rasterizer
(supersampled, zlib-deflated) so the pipeline needs no image libraries and
stays reproducible byte-for-byte.

## 05.1 // Geometric construction

- Canvas: **256×256 units**, subdivided into an **8×8 modular grid** (32U per module).
- Both **P** and **Z** share an identical stroke weight **S** and a negative-space
  diagonal seam of **0.5S**.
- Chamfer angle: **45°** (Variant 01 — Chamfer Interlock). The P's outer bowl
  chamfer locks onto the Z's diagonal spine; both glyphs share capline and
  baseline planes.

## 05.2 // Clear space

Maintain an unobstructed zone of at least **1x** on all four sides of the
monogram, where **x** equals the vertical interior counter height of the P
(or 1× stroke width **S** for compact UI headers).

## 05.3 // Minimum scale thresholds

| Surface | Minimum |
| --- | --- |
| Standalone icon | **16×16 px** |
| Horizontal wordmark | **80 px width** |
| Primary vertical lockup | **96 px width** |

Below 80 px horizontal width, omit the STUDIO wordmark and use the standalone
PZ monogram exclusively.

## Color tokens (the only approved colors)

| Token | Hex | RGB | Role |
| --- | --- | --- | --- |
| Near Black | `#090A0B` | rgb(9, 10, 11) | Primary background / CLI canvas |
| Dark Surface | `#121416` | rgb(18, 20, 22) | Cards / IDE panels / containers |
| Elevated Surface | `#202327` | rgb(32, 35, 39) | Interactive controls / badges |
| Border | `#353A40` | rgb(53, 58, 64) | 1px hairline dividers / grids |
| Secondary Text | `#AEB4BB` | rgb(174, 180, 187) | Technical labels / CLI output |
| Primary White | `#F8F8F6` | rgb(248, 248, 246) | Primary mark / light background |

Contrast: `#F8F8F6` on `#090A0B` is **19.4:1** and `#AEB4BB` on `#090A0B` is
**9.6:1** — both WCAG AAA.

## Typography

- **Display & wordmark** — Space Grotesk / Inter (geometric sans), weight 700,
  tracking +0.14em to +0.18em, uppercase. Brand SVGs never depend on it: the
  wordmark is pure vector paths.
- **Technical descriptors** — JetBrains Mono / Geist Mono, weight 400–600,
  tabular numerals. Used for CLI stream output, version badges, and
  coordinate telemetry (`@pzstudio/cli v0.42210.0`, `ERR_MOD_INFO_MISSING`).

## DO // Approved

- [+] Use strictly the six monochromatic tokens (`#090A0B` … `#F8F8F6`) across all surfaces.
- [+] Render the geometric PZ monogram with crisp vector edges, uniform stroke
  weight, and high-contrast negative space.
- [+] Frame product surfaces with 1px structural borders (`#353A40`), technical
  grids, and restrained uppercase typography.
- [+] Pair the geometric wordmark with monospace operational metadata
  (`@pzstudio/cli`, `v0.42210.0`).

## DON'T // Forbidden (legacy gaming aesthetics are retired)

- [×] **No red accents** (`#FF0000`), crimson borders, neon glows, or multi-color gaming gradients.
- [×] **No zombie mascots or gore** — no illustrations, blood drips, scratches, or distressed grunge textures.
- [×] **No pixel-art jagged edges** — no 8-bit staircase pixelation or crumbling voxel fragments on the P or Z glyphs.
- [×] **No redundant `</>` clip-art** — never append generic code-bracket icons
  next to the monogram, and never apply 3D bevels or drop shadows.

## Where the brand is applied

- **VS Code extension** — `icon.png` (marketplace),
  `resources/pzstudio-icon.svg` (activity bar, `currentColor`),
  `resources/pzstudio-banner.png` (README/marketplace banner).
- **First-success landing** — `docs/landing/index.html` (inline monogram +
  token palette, no external font/CDN dependency beyond GTM).
- **CLI** — monochrome operational voice: `[INFO]` / `[WARN]` / `[ERROR]` /
  `[OK]` stream labels in the mono/secondary token colors; severity colors in
  diagnostics are functional, not brand accents.
- **GitHub org** — social preview banner (`pz-studio-github-social-1280x640.svg`).

The retired zombie-era `.images/` uploads (banner, poster, minimal icon) were
removed from the repository; this monochrome kit is the only brand source.
