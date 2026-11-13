#!/usr/bin/env node
'use strict';

/**
 * PZ Studio — Monochrome Brand Asset Generator
 *
 * Deterministic, dependency-free (Node built-ins only) port of the interactive
 * brand studio (`docs/brand/studio.html`). Regenerates every brand deliverable
 * from a single source of truth so assets never drift:
 *
 *   SVG (pure <path>, zero font dependencies):
 *     - pz-logo-primary-dark.svg            (560x320, Deliverable 01)
 *     - pz-logo-primary-light.svg           (560x320, Deliverable 02)
 *     - pz-icon-standalone-dark.svg         (256x256 squircle, Deliverable 03)
 *     - pz-icon-standalone-light.svg        (256x256 squircle, Deliverable 03)
 *     - pz-wordmark-horizontal.svg          (780x200, Deliverable 04)
 *     - pz-studio-github-social-1280x640.svg (Deliverable 07)
 *     - pz-monogram-raw.svg                 (256x256 transparent symbol)
 *
 *   PNG (scanline even-odd rasterization, 4x/2x supersampled, zlib deflate):
 *     - packages/vscode-extension/icon.png  (128x128 marketplace icon)
 *     - packages/vscode-extension/resources/pzstudio-banner.png (1280x640)
 *
 *   Tokens (Deliverable 06):
 *     - tokens.css / tokens.json / tailwind-brand.config.js
 *
 * Fixed construction parameters (spec defaults): Variant 01 — Chamfer
 * Interlock, stroke weight S = 28 on the 256-unit grid.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..', '..');
const BRAND_DIR = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'packages', 'vscode-extension');

// ---------------------------------------------------------------------------
// Brand palette (Deliverable 06 — the only approved colors)
// ---------------------------------------------------------------------------

const COLORS = {
    nearBlack: '#090A0B',
    darkSurface: '#121416',
    elevatedSurface: '#202327',
    border: '#353A40',
    secondaryText: '#AEB4BB',
    primaryWhite: '#F8F8F6',
};

function hexToRgb(hex) {
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
    ];
}

function blendOver(fgHex, alpha, bgHex) {
    const fg = hexToRgb(fgHex);
    const bg = hexToRgb(bgHex);
    return fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i]));
}

// ---------------------------------------------------------------------------
// PZ monogram engine — Variant 01 "Chamfer Interlock", ported verbatim from
// the studio so coordinates match the interactive tool exactly.
// ---------------------------------------------------------------------------

function getMonogramPaths(variant, w) {
    if (variant === 1) {
        // VARIANT 01: CHAMFER INTERLOCK (Zed-inspired 45° chamfered P bowl interlocking with Z diagonal)
        const c = 26;
        const pRight = 138;
        const pBowlBottom = 148;
        const pPath = [
            `M 28 44`,
            `L ${pRight - c} 44`,
            `L ${pRight} ${44 + c}`,
            `L ${pRight} ${pBowlBottom - c}`,
            `L ${pRight - c} ${pBowlBottom}`,
            `L ${28 + w} ${pBowlBottom}`,
            `L ${28 + w} 212`,
            `L 28 212`,
            `Z`,
            `M ${28 + w} ${44 + w}`,
            `L ${28 + w} ${pBowlBottom - w}`,
            `L ${pRight - c - 6} ${pBowlBottom - w}`,
            `L ${pRight - w} ${pBowlBottom - w - 12}`,
            `L ${pRight - w} ${44 + w + 12}`,
            `L ${pRight - c - 6} ${44 + w}`,
            `Z`,
        ].join(' ');

        const zTopLeft = 144;
        const zBottomLeft = 104;
        const zRight = 228;
        const zDiagW = Math.round(w * 1.08);
        const zPath = [
            `M ${zTopLeft} 44`,
            `L ${zRight} 44`,
            `L ${zRight} ${44 + w}`,
            `L ${zBottomLeft + zDiagW} ${212 - w}`,
            `L ${zRight} ${212 - w}`,
            `L ${zRight} 212`,
            `L ${zBottomLeft} 212`,
            `L ${zBottomLeft} ${212 - w}`,
            `L ${zRight - zDiagW} ${44 + w}`,
            `L ${zTopLeft} ${44 + w}`,
            `Z`,
        ].join(' ');

        return { pPath, zPath };
    }

    throw new Error(`Unsupported monogram variant: ${variant}`);
}

/**
 * Pure Vector Glyph Engine — ported verbatim from the studio. 80-unit glyph
 * height, explicit widths, 2-decimal coordinate output.
 */
function buildVectorTextPaths(text, startX, startY, height, tracking) {
    const scale = height / 80;
    let cursorX = startX;
    let dList = [];

    const glyphDefs = {
        P: {
            w: 60,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return (
                    `M ${p(0, 0)} L ${p(46, 0)} L ${p(60, 14)} L ${p(60, 36)} L ${p(46, 50)} L ${p(15, 50)} L ${p(15, 80)} L ${p(0, 80)} Z ` +
                    `M ${p(15, 14)} L ${p(15, 36)} L ${p(40, 36)} L ${p(45, 31)} L ${p(45, 19)} L ${p(40, 14)} Z`
                );
            },
        },
        Z: {
            w: 60,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(60, 0)} L ${p(60, 14)} L ${p(20, 66)} L ${p(60, 66)} L ${p(60, 80)} L ${p(0, 80)} L ${p(0, 66)} L ${p(40, 14)} L ${p(0, 14)} Z`;
            },
        },
        S: {
            w: 58,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(12, 0)} L ${p(58, 0)} L ${p(58, 14)} L ${p(15, 14)} L ${p(15, 33)} L ${p(46, 33)} L ${p(58, 45)} L ${p(58, 68)} L ${p(46, 80)} L ${p(0, 80)} L ${p(0, 66)} L ${p(43, 66)} L ${p(43, 47)} L ${p(12, 47)} L ${p(0, 35)} L ${p(0, 12)} Z`;
            },
        },
        T: {
            w: 58,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(58, 0)} L ${p(58, 14)} L ${p(36.5, 14)} L ${p(36.5, 80)} L ${p(21.5, 80)} L ${p(21.5, 14)} L ${p(0, 14)} Z`;
            },
        },
        U: {
            w: 60,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(15, 0)} L ${p(15, 65)} L ${p(45, 65)} L ${p(45, 0)} L ${p(60, 0)} L ${p(60, 68)} L ${p(48, 80)} L ${p(12, 80)} L ${p(0, 68)} Z`;
            },
        },
        D: {
            w: 62,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return (
                    `M ${p(0, 0)} L ${p(44, 0)} L ${p(62, 18)} L ${p(62, 62)} L ${p(44, 80)} L ${p(0, 80)} Z ` +
                    `M ${p(15, 14)} L ${p(15, 66)} L ${p(38, 66)} L ${p(47, 57)} L ${p(47, 23)} L ${p(38, 14)} Z`
                );
            },
        },
        I: {
            w: 18,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(18, 0)} L ${p(18, 80)} L ${p(0, 80)} Z`;
            },
        },
        O: {
            w: 64,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return (
                    `M ${p(14, 0)} L ${p(50, 0)} L ${p(64, 14)} L ${p(64, 66)} L ${p(50, 80)} L ${p(14, 80)} L ${p(0, 66)} L ${p(0, 14)} Z ` +
                    `M ${p(15, 15)} L ${p(15, 65)} L ${p(49, 65)} L ${p(49, 15)} Z`
                );
            },
        },
        E: {
            w: 56,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(56, 0)} L ${p(56, 14)} L ${p(15, 14)} L ${p(15, 33)} L ${p(48, 33)} L ${p(48, 47)} L ${p(15, 47)} L ${p(15, 66)} L ${p(56, 66)} L ${p(56, 80)} L ${p(0, 80)} Z`;
            },
        },
        V: {
            w: 62,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(16, 0)} L ${p(31, 58)} L ${p(46, 0)} L ${p(62, 0)} L ${p(39, 80)} L ${p(23, 80)} Z`;
            },
        },
        L: {
            w: 54,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(15, 0)} L ${p(15, 66)} L ${p(54, 66)} L ${p(54, 80)} L ${p(0, 80)} Z`;
            },
        },
        N: {
            w: 62,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 0)} L ${p(16, 0)} L ${p(47, 54)} L ${p(47, 0)} L ${p(62, 0)} L ${p(62, 80)} L ${p(46, 80)} L ${p(15, 26)} L ${p(15, 80)} L ${p(0, 80)} Z`;
            },
        },
        G: {
            w: 64,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(14, 0)} L ${p(60, 0)} L ${p(60, 14)} L ${p(15, 14)} L ${p(15, 66)} L ${p(49, 66)} L ${p(49, 47)} L ${p(32, 47)} L ${p(32, 34)} L ${p(64, 34)} L ${p(64, 66)} L ${p(50, 80)} L ${p(14, 80)} L ${p(0, 66)} L ${p(0, 14)} Z`;
            },
        },
        _: {
            w: 52,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(0, 70)} L ${p(52, 70)} L ${p(52, 82)} L ${p(0, 82)} Z`;
            },
        },
        '/': {
            w: 36,
            d: (x, y, s) => {
                const p = (vx, vy) =>
                    `${(x + vx * s).toFixed(2)} ${(y + vy * s).toFixed(2)}`;
                return `M ${p(24, 0)} L ${p(36, 0)} L ${p(12, 80)} L ${p(0, 80)} Z`;
            },
        },
    };

    for (const ch of text) {
        if (ch === ' ') {
            cursorX += 26 * scale;
            continue;
        }
        const def = glyphDefs[ch];
        if (!def) continue;
        dList.push(def.d(cursorX, startY, scale));
        cursorX += def.w * scale + tracking;
    }

    return {
        pathData: dList.join(' '),
        totalWidth: cursorX - startX - tracking,
    };
}

/**
 * Parse an absolute M/L/Z path string (as emitted by the two engines above)
 * into polygon rings, for rasterization under the even-odd fill rule.
 */
function parsePathToRings(d) {
    const rings = [];
    let current = null;
    const tokens = d.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === 'M') {
            current = [];
            rings.push(current);
            current.push([parseFloat(tokens[++i]), parseFloat(tokens[++i])]);
        } else if (t === 'L') {
            current.push([parseFloat(tokens[++i]), parseFloat(tokens[++i])]);
        } else if (t === 'Z') {
            // Ring complete; next M opens a new one.
        } else {
            throw new Error(`Unsupported path token: ${t}`);
        }
    }
    return rings.filter((r) => r.length >= 3);
}

// ---------------------------------------------------------------------------
// SVG deliverable builder — ported from the studio's generateDeliverableSVG
// with fixed width/height attributes for standalone files and overlays
// omitted (the studio only renders overlays as interactive toggles).
// ---------------------------------------------------------------------------

function svgOpen(viewBoxW, viewBoxH, title) {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxW} ${viewBoxH}" width="${viewBoxW}" height="${viewBoxH}" fill="none">\n` +
        `  <title>${title}</title>`
    );
}

function generateDeliverableSVG(type) {
    const { pPath, zPath } = getMonogramPaths(1, 28);

    if (type === 'primary-dark' || type === 'primary-light') {
        const isLight = type === 'primary-light';
        const bg = isLight ? COLORS.primaryWhite : COLORS.nearBlack;
        const fg = isLight ? COLORS.nearBlack : COLORS.primaryWhite;
        const ruleColor = isLight ? COLORS.nearBlack : COLORS.border;

        const wordmark = buildVectorTextPaths('STUDIO', 0, 0, 22, 13.5);
        const wordmarkX = ((560 - wordmark.totalWidth) / 2).toFixed(2);
        const wordmarkY = 248;

        const mScale = 0.84;
        const mOffsetX = ((560 - 256 * mScale) / 2).toFixed(2);
        const mOffsetY = 14;

        return [
            svgOpen(
                560,
                320,
                `PZ Studio — Primary Logo (${isLight ? 'Light Surface #F8F8F6' : 'Dark Surface #090A0B'})`,
            ),
            `  <rect width="560" height="320" fill="${bg}" />`,
            `  <!-- PZ Geometric Monogram (Pure Vector Path) -->`,
            `  <g transform="translate(${mOffsetX}, ${mOffsetY}) scale(${mScale})" fill="${fg}" fill-rule="evenodd">`,
            `    <path id="pz-monogram-p" d="${pPath}" />`,
            `    <path id="pz-monogram-z" d="${zPath}" />`,
            `  </g>`,
            `  <!-- Structural Hairline Separator -->`,
            `  <rect x="172" y="226" width="216" height="1.5" fill="${ruleColor}" opacity="${isLight ? '0.25' : '0.85'}" />`,
            `  <!-- STUDIO Geometric Wordmark (Pure Vector Path) -->`,
            `  <g transform="translate(${wordmarkX}, ${wordmarkY})" fill="${fg}" fill-rule="evenodd">`,
            `    <path id="pz-wordmark-studio" d="${wordmark.pathData}" />`,
            `  </g>`,
            `</svg>`,
        ].join('\n');
    }

    if (type === 'icon-dark' || type === 'icon-light') {
        const isLight = type === 'icon-light';
        const bg = isLight ? COLORS.primaryWhite : COLORS.nearBlack;
        const border = isLight ? COLORS.nearBlack : COLORS.border;
        const fg = isLight ? COLORS.nearBlack : COLORS.primaryWhite;

        return [
            svgOpen(
                256,
                256,
                `PZ Studio — Standalone App Icon (${isLight ? 'Light' : 'Dark'})`,
            ),
            `  <rect x="4" y="4" width="248" height="248" rx="56" fill="${bg}" stroke="${border}" stroke-width="4" />`,
            `  <g fill="${fg}" fill-rule="evenodd">`,
            `    <path id="pz-icon-p" d="${pPath}" />`,
            `    <path id="pz-icon-z" d="${zPath}" />`,
            `  </g>`,
            `</svg>`,
        ].join('\n');
    }

    if (type === 'horizontal-wordmark') {
        const bg = COLORS.nearBlack;
        const fg = COLORS.primaryWhite;
        const muted = COLORS.secondaryText;
        const ruleColor = COLORS.border;

        const mScale = 0.58;
        const mOffsetX = 44;
        const mOffsetY = ((200 - 256 * mScale) / 2).toFixed(2);

        const fullWordmark = buildVectorTextPaths('PZ STUDIO', 0, 0, 38, 12);
        const descriptorPaths = buildVectorTextPaths(
            'DEV_TOOLS // ENGINE',
            0,
            0,
            12.5,
            4.5,
        );

        return [
            svgOpen(780, 200, 'PZ Studio — Horizontal Wordmark Lockup'),
            `  <rect width="780" height="200" fill="${bg}" />`,
            `  <!-- Left PZ Monogram Mark -->`,
            `  <g transform="translate(${mOffsetX}, ${mOffsetY}) scale(${mScale})" fill="${fg}" fill-rule="evenodd">`,
            `    <path id="pz-horiz-p" d="${pPath}" />`,
            `    <path id="pz-horiz-z" d="${zPath}" />`,
            `  </g>`,
            `  <!-- Vertical Technical Separator (#353A40) -->`,
            `  <rect x="214" y="52" width="2" height="96" fill="${ruleColor}" opacity="0.95" />`,
            `  <!-- Right PZ STUDIO Geometric Wordmark (Pure Vector Paths) -->`,
            `  <g transform="translate(244, 62)" fill="${fg}" fill-rule="evenodd">`,
            `    <path id="pz-horiz-wordmark" d="${fullWordmark.pathData}" />`,
            `  </g>`,
            `  <!-- Technical Descriptor (DEV_TOOLS // ENGINE in Pure Vector Paths) -->`,
            `  <g transform="translate(244, 124)" fill="${muted}" fill-rule="evenodd">`,
            `    <path id="pz-wordmark-descriptor" d="${descriptorPaths.pathData}" />`,
            `  </g>`,
            `</svg>`,
        ].join('\n');
    }

    if (type === 'raw-monogram') {
        return [
            svgOpen(256, 256, 'PZ Studio — Raw Monogram Symbol'),
            `  <g fill="${COLORS.primaryWhite}" fill-rule="evenodd">`,
            `    <path d="${pPath}" />`,
            `    <path d="${zPath}" />`,
            `  </g>`,
            `</svg>`,
        ].join('\n');
    }

    if (type === 'github-banner') {
        const fullWordmark = buildVectorTextPaths('PZ STUDIO', 0, 0, 48, 14);
        const subDescriptor = buildVectorTextPaths(
            'DEV_TOOLS // ENGINE',
            0,
            0,
            20,
            7,
        );
        let gridLines = [];
        for (let x = 64; x < 1280; x += 64) {
            gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="640" />`);
        }
        for (let y = 64; y < 640; y += 64) {
            gridLines.push(`<line x1="0" y1="${y}" x2="1280" y2="${y}" />`);
        }

        return [
            svgOpen(1280, 640, 'PZ Studio — GitHub Social Preview (1280x640)'),
            `  <rect width="1280" height="640" fill="${COLORS.nearBlack}" />`,
            `  <!-- Technical Grid -->`,
            `  <g stroke="${COLORS.border}" stroke-width="1" opacity="0.35">`,
            `    ${gridLines.join('\n    ')}`,
            `  </g>`,
            `  <!-- Outer Structural Frame (64px inset: grid-aligned, inside GitHub's 40pt repo-card safe border) -->`,
            `  <rect x="64" y="64" width="1152" height="512" fill="none" stroke="${COLORS.border}" stroke-width="2" />`,
            `  <!-- Corner Crosshairs -->`,
            `  <path d="M 56 64 H 72 M 64 56 V 72 M 1208 64 H 1224 M 1216 56 V 72 M 56 576 H 72 M 64 568 V 584 M 1208 576 H 1224 M 1216 568 V 584" stroke="${COLORS.primaryWhite}" stroke-width="2" />`,
            `  <!-- Left Elevated Squircle Monogram Module -->`,
            `  <rect x="112" y="168" width="304" height="304" rx="64" fill="${COLORS.darkSurface}" stroke="${COLORS.border}" stroke-width="2" />`,
            `  <g transform="translate(136, 192)" fill="${COLORS.primaryWhite}" fill-rule="evenodd">`,
            `    <path d="${pPath}" />`,
            `    <path d="${zPath}" />`,
            `  </g>`,
            `  <!-- Right Brand Lockup & Pure Vector Typography -->`,
            `  <g transform="translate(476, 224)" fill="${COLORS.primaryWhite}" fill-rule="evenodd">`,
            `    <path d="${fullWordmark.pathData}" />`,
            `  </g>`,
            `  <rect x="476" y="308" width="660" height="2" fill="${COLORS.border}" />`,
            `  <g transform="translate(476, 336)" fill="${COLORS.secondaryText}" fill-rule="evenodd">`,
            `    <path d="${subDescriptor.pathData}" />`,
            `  </g>`,
            `  <rect x="476" y="392" width="140" height="8" fill="${COLORS.primaryWhite}" />`,
            `  <rect x="628" y="392" width="280" height="8" fill="${COLORS.elevatedSurface}" stroke="${COLORS.border}" />`,
            `</svg>`,
        ].join('\n');
    }

    throw new Error(`Unknown deliverable type: ${type}`);
}

// ---------------------------------------------------------------------------
// Design token exports — ported verbatim from the studio's token exporter.
// ---------------------------------------------------------------------------

function getTokenExports() {
    const css = `/* tokens.css — PZ Studio Monochromatic Brand & UI Design Tokens */
:root {
  /* Primary Monochromatic Surface Hierarchy */
  --pz-color-near-black: #090A0B;
  --pz-color-dark-surface: #121416;
  --pz-color-elevated-surface: #202327;

  /* Structural Dividers & Technical Grids */
  --pz-color-border: #353A40;

  /* Typography & Iconography Foregrounds */
  --pz-color-secondary-text: #AEB4BB;
  --pz-color-primary-white: #F8F8F6;

  /* Typography Stacks */
  --pz-font-sans: 'Space Grotesk', 'Inter', -apple-system, sans-serif;
  --pz-font-mono: 'JetBrains Mono', 'Geist Mono', monospace;

  /* Geometric Construction Constants */
  --pz-logo-grid-unit: 32px;
  --pz-logo-clear-space: 1x;
  --pz-logo-min-icon-size: 16px;
  --pz-logo-min-wordmark-width: 80px;
}`;

    const json = JSON.stringify(
        {
            $schema: 'https://tr.designtokens.org/format/',
            pzStudio: {
                color: {
                    nearBlack: {
                        $value: '#090A0B',
                        $type: 'color',
                        $description:
                            'Primary dark canvas & terminal background',
                    },
                    darkSurface: {
                        $value: '#121416',
                        $type: 'color',
                        $description: 'Secondary panels, cards & IDE sidebars',
                    },
                    elevatedSurface: {
                        $value: '#202327',
                        $type: 'color',
                        $description:
                            'Interactive controls, active tabs & badges',
                    },
                    border: {
                        $value: '#353A40',
                        $type: 'color',
                        $description:
                            '1px structural hairlines & construction grids',
                    },
                    secondaryText: {
                        $value: '#AEB4BB',
                        $type: 'color',
                        $description:
                            'Technical descriptors, CLI logs & muted labels',
                    },
                    primaryWhite: {
                        $value: '#F8F8F6',
                        $type: 'color',
                        $description:
                            'Primary brand mark, display headings & light surface',
                    },
                },
                typography: {
                    display: {
                        $value: 'Space Grotesk, Inter, sans-serif',
                        $type: 'fontFamily',
                    },
                    monospace: {
                        $value: 'JetBrains Mono, Geist Mono, monospace',
                        $type: 'fontFamily',
                    },
                },
            },
        },
        null,
        2,
    );

    const tailwind = `// tailwind-brand.config.js — PZ Studio Monochromatic Developer Theme
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        pz: {
          black: '#090A0B',
          surface: '#121416',
          elevated: '#202327',
          border: '#353A40',
          secondary: '#AEB4BB',
          white: '#F8F8F6',
        },
      },
      fontFamily: {
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'Geist Mono', 'monospace'],
      },
    },
  },
};`;

    return { css, json, tailwind };
}

// ---------------------------------------------------------------------------
// PNG rasterizer — scanline even-odd polygon fill with supersampling,
// deflated via Node zlib. No image libraries.
// ---------------------------------------------------------------------------

function rectangleRing(x, y, w, h) {
    return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
    ];
}

function roundedRectRing(x, y, w, h, r) {
    const seg = Math.max(2, Math.round(r / 8));
    const ring = [];
    const corner = (cx, cy, a0, a1) => {
        for (let i = 0; i <= seg; i++) {
            const a = a0 + (a1 - a0) * (i / seg);
            ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
    };
    // Clockwise from the top-left arc end.
    corner(x + r, y + r, Math.PI, 1.5 * Math.PI); // top-left
    corner(x + w - r, y + r, 1.5 * Math.PI, 2 * Math.PI); // top-right
    corner(x + w - r, y + h - r, 0, 0.5 * Math.PI); // bottom-right
    corner(x + r, y + h - r, 0.5 * Math.PI, Math.PI); // bottom-left
    return ring;
}

function transformRings(rings, scaleX, scaleY, tx, ty) {
    return rings.map((ring) =>
        ring.map(([x, y]) => [x * scaleX + tx, y * scaleY + ty]),
    );
}

/**
 * Canvas: Float32Array(W*H*4) RGBA in 0..255, alpha 0..255.
 * Each layer blends source-over using supersampled coverage.
 */
function createCanvas(w, h) {
    return {
        w,
        h,
        data: new Float32Array(w * h * 4), // starts fully transparent
    };
}

function drawLayer(canvas, rings, color, ss) {
    const { w, h } = canvas;
    const HW = w * ss;
    const HH = h * ss;
    const hi = new Uint8Array(HW * HH);

    const scaled = rings.map((ring) => ring.map(([x, y]) => [x * ss, y * ss]));

    for (let j = 0; j < HH; j++) {
        const ys = j + 0.5;
        const xs = [];
        for (const ring of scaled) {
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const [x1, y1] = ring[i];
                const [x2, y2] = ring[(i + 1) % n];
                if ((y1 <= ys && y2 > ys) || (y2 <= ys && y1 > ys)) {
                    xs.push(x1 + ((ys - y1) * (x2 - x1)) / (y2 - y1));
                }
            }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        const row = j * HW;
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const start = Math.max(0, Math.ceil(xs[k] - 0.5));
            const end = Math.min(HW, Math.ceil(xs[k + 1] - 0.5));
            for (let x = start; x < end; x++) hi[row + x] = 1;
        }
    }

    // Box-downsample to coverage and blend.
    const [r, g, b] = color;
    const block = ss * ss;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sum = 0;
            for (let sy = 0; sy < ss; sy++) {
                const row = (y * ss + sy) * HW;
                for (let sx = 0; sx < ss; sx++) {
                    sum += hi[row + x * ss + sx];
                }
            }
            const cov = sum / block;
            if (cov === 0) continue;
            const idx = (y * w + x) * 4;
            const d = canvas.data;
            d[idx] = d[idx] * (1 - cov) + r * cov;
            d[idx + 1] = d[idx + 1] * (1 - cov) + g * cov;
            d[idx + 2] = d[idx + 2] * (1 - cov) + b * cov;
            d[idx + 3] = Math.min(255, d[idx + 3] + cov * 255);
        }
    }
}

// --- PNG encoding (RGBA, 8-bit, filter 0, single IDAT) ----------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

function encodePNG(canvas) {
    const { w, h, data } = canvas;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h * 4; i++) {
        rgba[i] = Math.max(0, Math.min(255, Math.round(data[i])));
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const stride = w * 4;
    const raw = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    const idat = zlib.deflateSync(raw, { level: 9 });

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------------------
// Bitmap deliverables
// ---------------------------------------------------------------------------

/**
 * 128x128 marketplace app icon — the studio's squircle tile (rx=22%) with the
 * monogram at half scale. Corners stay transparent.
 */
function renderIconPNG() {
    const { pPath, zPath } = getMonogramPaths(1, 28);
    const canvas = createCanvas(128, 128);

    drawLayer(
        canvas,
        [roundedRectRing(2, 2, 124, 124, 28)],
        hexToRgb(COLORS.border),
        4,
    );
    drawLayer(
        canvas,
        [roundedRectRing(4, 4, 120, 120, 26)],
        hexToRgb(COLORS.nearBlack),
        4,
    );
    drawLayer(
        canvas,
        transformRings(
            [...parsePathToRings(pPath), ...parsePathToRings(zPath)],
            0.5,
            0.5,
            0,
            0,
        ),
        hexToRgb(COLORS.primaryWhite),
        4,
    );

    return encodePNG(canvas);
}

/**
 * 1280x640 GitHub social preview / marketplace banner — rasterized from the
 * same geometry as the github-banner SVG deliverable (paint order preserved).
 */
function renderBannerPNG() {
    const { pPath, zPath } = getMonogramPaths(1, 28);
    const canvas = createCanvas(1280, 640);
    const ss = 2;

    // Background canvas.
    drawLayer(
        canvas,
        [rectangleRing(0, 0, 1280, 640)],
        hexToRgb(COLORS.nearBlack),
        ss,
    );

    // Technical grid (#353A40 at 0.35 opacity over the near-black canvas).
    const gridColor = blendOver(COLORS.border, 0.35, COLORS.nearBlack);
    for (let x = 64; x < 1280; x += 64) {
        drawLayer(canvas, [rectangleRing(x, 0, 1, 640)], gridColor, ss);
    }
    for (let y = 64; y < 640; y += 64) {
        drawLayer(canvas, [rectangleRing(0, y, 1280, 1)], gridColor, ss);
    }

    // Outer structural frame (2px stroke via nested rects, 64px inset —
    // GitHub repo-card safe border).
    drawLayer(
        canvas,
        [rectangleRing(64, 64, 1152, 512)],
        hexToRgb(COLORS.border),
        ss,
    );
    drawLayer(
        canvas,
        [rectangleRing(66, 66, 1148, 508)],
        hexToRgb(COLORS.nearBlack),
        ss,
    );

    // Corner crosshairs (2px white strokes, centered on the frame corners).
    const white = hexToRgb(COLORS.primaryWhite);
    const crosshairBars = [
        [56, 63, 16, 2],
        [63, 56, 2, 16],
        [1208, 63, 16, 2],
        [1215, 56, 2, 16],
        [56, 575, 16, 2],
        [63, 568, 2, 16],
        [1208, 575, 16, 2],
        [1215, 568, 2, 16],
    ];
    for (const [x, y, w, h] of crosshairBars) {
        drawLayer(canvas, [rectangleRing(x, y, w, h)], white, ss);
    }

    // Left elevated squircle monogram module (2px border via nested rings).
    drawLayer(
        canvas,
        [roundedRectRing(112, 168, 304, 304, 64)],
        hexToRgb(COLORS.border),
        ss,
    );
    drawLayer(
        canvas,
        [roundedRectRing(114, 170, 300, 300, 62)],
        hexToRgb(COLORS.darkSurface),
        ss,
    );
    drawLayer(
        canvas,
        transformRings(
            [...parsePathToRings(pPath), ...parsePathToRings(zPath)],
            1,
            1,
            136,
            192,
        ),
        white,
        ss,
    );

    // Right brand lockup: wordmark, hairline, descriptor, progress modules.
    const wordmark = buildVectorTextPaths('PZ STUDIO', 0, 0, 48, 14);
    drawLayer(
        canvas,
        transformRings(parsePathToRings(wordmark.pathData), 1, 1, 476, 224),
        white,
        ss,
    );
    drawLayer(
        canvas,
        [rectangleRing(476, 308, 660, 2)],
        hexToRgb(COLORS.border),
        ss,
    );
    const descriptor = buildVectorTextPaths('DEV_TOOLS // ENGINE', 0, 0, 20, 7);
    drawLayer(
        canvas,
        transformRings(parsePathToRings(descriptor.pathData), 1, 1, 476, 336),
        hexToRgb(COLORS.secondaryText),
        ss,
    );
    drawLayer(canvas, [rectangleRing(476, 392, 140, 8)], white, ss);
    drawLayer(
        canvas,
        [rectangleRing(628, 392, 280, 8)],
        hexToRgb(COLORS.elevatedSurface),
        ss,
    );
    // 1px border of the elevated module (#353A40 outline).
    const borderColor = hexToRgb(COLORS.border);
    drawLayer(canvas, [rectangleRing(628, 392, 280, 1)], borderColor, ss);
    drawLayer(canvas, [rectangleRing(628, 399, 280, 1)], borderColor, ss);
    drawLayer(canvas, [rectangleRing(628, 392, 1, 8)], borderColor, ss);
    drawLayer(canvas, [rectangleRing(907, 392, 1, 8)], borderColor, ss);

    return encodePNG(canvas);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const written = [];
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        written.push(
            `${path.relative(ROOT, file)} (${Buffer.byteLength(content)} B)`,
        );
    };
    const writeBinary = (file, buffer) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buffer);
        written.push(`${path.relative(ROOT, file)} (${buffer.length} B)`);
    };

    // SVG deliverables.
    write(
        path.join(BRAND_DIR, 'pz-logo-primary-dark.svg'),
        generateDeliverableSVG('primary-dark'),
    );
    write(
        path.join(BRAND_DIR, 'pz-logo-primary-light.svg'),
        generateDeliverableSVG('primary-light'),
    );
    write(
        path.join(BRAND_DIR, 'pz-icon-standalone-dark.svg'),
        generateDeliverableSVG('icon-dark'),
    );
    write(
        path.join(BRAND_DIR, 'pz-icon-standalone-light.svg'),
        generateDeliverableSVG('icon-light'),
    );
    write(
        path.join(BRAND_DIR, 'pz-wordmark-horizontal.svg'),
        generateDeliverableSVG('horizontal-wordmark'),
    );
    write(
        path.join(BRAND_DIR, 'pz-studio-github-social-1280x640.svg'),
        generateDeliverableSVG('github-banner'),
    );
    write(
        path.join(BRAND_DIR, 'pz-monogram-raw.svg'),
        generateDeliverableSVG('raw-monogram'),
    );

    // PNG deliverables.
    writeBinary(path.join(EXT_DIR, 'icon.png'), renderIconPNG());
    writeBinary(
        path.join(EXT_DIR, 'resources', 'pzstudio-banner.png'),
        renderBannerPNG(),
    );

    // Token exports.
    const tokens = getTokenExports();
    write(path.join(BRAND_DIR, 'tokens.css'), tokens.css);
    write(path.join(BRAND_DIR, 'tokens.json'), tokens.json);
    write(path.join(BRAND_DIR, 'tailwind-brand.config.js'), tokens.tailwind);

    console.log('PZ Studio brand assets generated:');
    for (const f of written) console.log(`  - ${f}`);
}

main();
