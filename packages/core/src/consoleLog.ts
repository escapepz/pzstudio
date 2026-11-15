/**
 * Stage-3 classification for assembled console.txt entries: turns the
 * `ParsedEntry[]` produced by `assembleEntries` into deduplicated findings,
 * session tables and stats.
 *
 * Per entry, in order:
 *  1. stats — `byLevel` counts every leveled entry; `DEBUG` entries are
 *     count-and-dropped per channel before anything else (the `includeDebug`
 *     option threads in a later task, default off).
 *  2. session metadata — the first `dd-mm-yyyy hh:mm:ss` body pins
 *     `sessionStart`; a `GameThread exited.` body sets `gameExited`.
 *  3. `Mod`-channel table lines — `loading <id>` / `mod "<id>" overrides
 *     <path>` populate the session (never findings); `refusing to list <id>`
 *     becomes a first-class `mod-rejected` finding.
 *  4. WARN/ERROR/SEVERE entries run the single-line classifier table
 *     (body-prefix matches), then continuation promotion (a matched
 *     `KahluaException` promotes the block to `lua-syntax-error`; `zombie.*`
 *     frames to `engine-exception`), then the mandatory `unclassified` bucket
 *     — no ERROR/WARN/SEVERE line is ever silently dropped.
 *
 * Findings dedup by `(category, message, top frame text)`, accumulating
 * `count` and widening the `firstLine`/`lastLine` span.
 *
 * This module is pure (no I/O, no Node builtins) and imports only from
 * `./consoleLogParse`.
 */

import { extractFrames, extractKahluaException } from './consoleLogParse';
import type { ParsedEntry, ParsedFrame } from './consoleLogParse';

export type ConsoleLogCategory =
    | 'lua-syntax-error'
    | 'lua-runtime-error'
    | 'require-failure'
    | 'recursive-require'
    | 'script-warning'
    | 'engine-exception'
    | 'mod-rejected'
    | 'translation'
    | 'unclassified';

export interface ConsoleLogFinding {
    category: ConsoleLogCategory;
    severity: 'error' | 'warning' | 'info';
    message: string;
    modId?: string;
    sourceFile?: string;
    line?: number;
    frames?: ParsedFrame[];
    count: number;
    firstLine: number;
    lastLine: number;
}

export interface ConsoleLogSession {
    loadedModIds: string[];
    rejectedModIds: string[];
}

/** Virtual path (normalized, forward slashes) -> mod id. */
export interface ConsoleLogTables {
    overrideMap: Map<string, string>;
}

export interface ConsoleLogStats {
    totalLines: number;
    byLevel: Record<string, number>;
    debugByChannel: Record<string, number>;
    junkCount: number;
}

export interface BuildFindingsResult {
    findings: ConsoleLogFinding[];
    stats: ConsoleLogStats;
    session: ConsoleLogSession;
    tables: ConsoleLogTables;
    sessionStart?: string;
    gameExited: boolean;
}

// Session-start body printed at startup: `15-11-2026 13:28:36`.
const SESSION_START = /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/;

// gameExited heuristic (design §Windows / live-file robustness).
const GAME_EXITED = 'GameThread exited.';

// Single-line classifier table (design §Stage 3); first body-prefix match
// wins. Severity comes from the table, not the envelope level. Rules are
// anchored regexes, so a `pattern` is exactly the design's body-prefix match;
// the parens in the require-shaped headlines stay escaped, which also keeps
// the browser-safety gate's bare-`require` scan from misreading classifier
// data as a CommonJS call.
interface BodyClassifierRule {
    pattern: RegExp;
    category: ConsoleLogCategory;
    severity: ConsoleLogFinding['severity'];
}

const BODY_CLASSIFIERS: BodyClassifierRule[] = [
    // require-failure headline: a quoted path between a leading `require` and
    // a trailing `) failed` — both ends are part of the shape.
    {
        pattern: /^require\("[^"]+"\)\s+failed/,
        category: 'require-failure',
        severity: 'warning',
    },
    {
        pattern: /^recursive require\(\):/,
        category: 'recursive-require',
        severity: 'warning',
    },
    {
        pattern: /^Could not find icon:/,
        category: 'script-warning',
        severity: 'warning',
    },
    {
        pattern: /^no such mesh/,
        category: 'script-warning',
        severity: 'warning',
    },
    {
        pattern: /^no such sound/,
        category: 'script-warning',
        severity: 'warning',
    },
    {
        pattern: /^new tag discovered/,
        category: 'script-warning',
        severity: 'warning',
    },
    {
        pattern: /^Sanitizing container name/,
        category: 'script-warning',
        severity: 'warning',
    },
    {
        pattern: /^Invalid SpriteConfig/,
        category: 'script-warning',
        severity: 'warning',
    },
    {
        pattern: /^Missing translation/,
        category: 'translation',
        severity: 'warning',
    },
    {
        pattern: /^translator:/,
        category: 'translation',
        severity: 'warning',
    },
];

// Mod-channel table lines (design §Attribution ladder, tier 2).
const MOD_LOADING = /^loading (\S+)$/;
const MOD_OVERRIDE = /^mod "([^"]+)" overrides (.+)$/;
const MOD_REFUSING = /^refusing to list (\S+)$/;

// Dedup key separator — never occurs in log bodies, so the composite key
// (category, message, top frame text) cannot collide across field boundaries.
const KEY_SEP = '\u0000';

/**
 * Classifies assembled entries into findings, session tables and stats.
 * `totalLines` and `junkCount` are the caller's assemble-stage totals, passed
 * through into `stats` so the summary always proves the full-file parse.
 */
export function buildFindings(
    entries: ParsedEntry[],
    totalLines: number,
    junkCount: number,
): BuildFindingsResult {
    const findings: ConsoleLogFinding[] = [];
    const byKey = new Map<string, ConsoleLogFinding>();
    const byLevel: Record<string, number> = {};
    const debugByChannel: Record<string, number> = {};
    const loadedModIds: string[] = [];
    const rejectedModIds: string[] = [];
    const overrideMap = new Map<string, string>();
    let sessionStart: string | undefined;
    let gameExited = false;

    for (const entry of entries) {
        const level = entry.level;
        if (level) {
            byLevel[level] = (byLevel[level] ?? 0) + 1;
        }

        // DEBUG lines are count-and-drop (includeDebug threads in later).
        if (level === 'DEBUG') {
            const channel = entry.channel ?? '';
            debugByChannel[channel] = (debugByChannel[channel] ?? 0) + 1;
            continue;
        }

        const body = entry.body.trim();

        // Session metadata: startup timestamp and game-exit marker.
        if (sessionStart === undefined && SESSION_START.test(body)) {
            sessionStart = body;
        }
        if (body === GAME_EXITED) {
            gameExited = true;
        }

        // Mod-channel session tables; `refusing to list` is a first-class
        // finding at any envelope level, the other lines are never findings.
        if (entry.channel === 'Mod') {
            const loading = MOD_LOADING.exec(body);
            if (loading) {
                if (!loadedModIds.includes(loading[1])) {
                    loadedModIds.push(loading[1]);
                }
                continue;
            }
            const override = MOD_OVERRIDE.exec(body);
            if (override) {
                overrideMap.set(normalizeVirtualPath(override[2]), override[1]);
                continue;
            }
            const refusing = MOD_REFUSING.exec(body);
            if (refusing) {
                pushFinding(findings, byKey, {
                    category: 'mod-rejected',
                    severity: 'error',
                    message: body,
                    modId: refusing[1],
                    count: 1,
                    firstLine: entry.lineNo,
                    lastLine: entry.lineNo,
                });
                if (!rejectedModIds.includes(refusing[1])) {
                    rejectedModIds.push(refusing[1]);
                }
                continue;
            }
        }

        // Only WARN/ERROR/SEVERE entries can become findings.
        if (level !== 'WARN' && level !== 'ERROR' && level !== 'SEVERE') {
            continue;
        }

        // Single-line classifier table (body prefix).
        const classified = classifyBody(body);
        if (classified) {
            pushFinding(findings, byKey, {
                category: classified.category,
                severity: classified.severity,
                message: body,
                count: 1,
                firstLine: entry.lineNo,
                lastLine: entry.lineNo,
            });
            continue;
        }

        // Continuation promotion on ERROR entries: a matched KahluaException
        // promotes the block to lua-syntax-error; otherwise zombie.* frames
        // make it an engine-exception. lua-runtime-error stays dormant until a
        // real log pins the runtime-error shape.
        if (level === 'ERROR') {
            const kahlua = extractKahluaException(entry.continuations);
            if (kahlua) {
                pushFinding(findings, byKey, {
                    category: 'lua-syntax-error',
                    severity: 'error',
                    message: kahlua.message,
                    line: kahlua.line,
                    frames: extractFrames(entry.continuations),
                    count: 1,
                    firstLine: entry.lineNo,
                    lastLine: entry.lineNo,
                });
                continue;
            }
            const frames = extractFrames(entry.continuations);
            if (frames.some((frame) => frame.kind === 'engine')) {
                pushFinding(findings, byKey, {
                    category: 'engine-exception',
                    severity: 'error',
                    message: body,
                    frames,
                    count: 1,
                    firstLine: entry.lineNo,
                    lastLine: entry.lineNo,
                });
                continue;
            }
        }

        // Mandatory unclassified bucket — nothing is silently dropped.
        pushFinding(findings, byKey, {
            category: 'unclassified',
            severity: level === 'WARN' ? 'warning' : 'error',
            message:
                entry.continuations.length > 0
                    ? body + '\n' + entry.continuations.join('\n')
                    : body,
            count: 1,
            firstLine: entry.lineNo,
            lastLine: entry.lineNo,
        });
    }

    return {
        findings,
        stats: { totalLines, byLevel, debugByChannel, junkCount },
        session: { loadedModIds, rejectedModIds },
        tables: { overrideMap },
        sessionStart,
        gameExited,
    };
}

/** Runs the body-prefix classifier table; first match wins. */
function classifyBody(body: string): {
    category: ConsoleLogCategory;
    severity: ConsoleLogFinding['severity'];
} | null {
    for (const rule of BODY_CLASSIFIERS) {
        if (rule.pattern.test(body)) {
            return { category: rule.category, severity: rule.severity };
        }
    }
    return null;
}

/**
 * Appends a finding, collapsing it into the previous occurrence when
 * `(category, message, top frame text)` match: `count` accumulates and the
 * `firstLine`/`lastLine` span widens to cover both occurrences.
 */
function pushFinding(
    findings: ConsoleLogFinding[],
    byKey: Map<string, ConsoleLogFinding>,
    finding: ConsoleLogFinding,
): void {
    const topFrame =
        finding.frames && finding.frames.length > 0
            ? finding.frames[0].text
            : '';
    const key =
        finding.category + KEY_SEP + finding.message + KEY_SEP + topFrame;
    const existing = byKey.get(key);
    if (existing) {
        existing.count += finding.count;
        if (finding.firstLine < existing.firstLine) {
            existing.firstLine = finding.firstLine;
        }
        if (finding.lastLine > existing.lastLine) {
            existing.lastLine = finding.lastLine;
        }
        return;
    }
    byKey.set(key, finding);
    findings.push(finding);
}

// Override paths are virtual paths; the game prints Windows separators on
// some surfaces, so they are normalized to forward slashes.
function normalizeVirtualPath(path: string): string {
    return path.trim().replace(/\\/g, '/');
}
