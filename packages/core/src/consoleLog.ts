/**
 * Stage-3 classification for assembled console.txt entries: turns the
 * `ParsedEntry[]` produced by `assembleEntries` into deduplicated findings,
 * session tables and stats.
 *
 * Per entry, in order:
 *  1. stats — `byLevel` counts every leveled entry; `DEBUG` entries are
 *     count-and-dropped per channel before anything else (the `includeDebug`
 *     option re-enables them for session handling, default off — they never
 *     become findings).
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
 * This module is browser-safe (no Node builtins, no `process`): the
 * classifier stays pure; `analyzeConsoleLog` performs I/O only through the
 * injected `ProjectFileSystem` contract from `@pzstudio/platform`.
 */

import type { ProjectFileSystem } from '@pzstudio/platform';
import {
    assembleEntries,
    extractFrames,
    extractKahluaException,
} from './consoleLogParse';
import type { ParsedEntry, ParsedFrame } from './consoleLogParse';
import { collectLuaBasenames } from './consoleLogSource';

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
 * `includeDebug` (default false) re-enables DEBUG entries for session
 * handling — they stay finding-free either way.
 */
export function buildFindings(
    entries: ParsedEntry[],
    totalLines: number,
    junkCount: number,
    includeDebug = false,
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

        // DEBUG lines are count-and-drop; includeDebug re-enables them for
        // session handling (the level gate below still keeps them finding-free).
        if (level === 'DEBUG') {
            const channel = entry.channel ?? '';
            debugByChannel[channel] = (debugByChannel[channel] ?? 0) + 1;
            if (!includeDebug) {
                continue;
            }
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

// ---------------------------------------------------------------------------
// Attribution ladder + full-log analysis (consumed by CLI / extension)
// ---------------------------------------------------------------------------

/** One mod's workspace-side attribution context. */
export interface ConsoleLogModContext {
    modId: string;
    displayName?: string;
    sourceRootUri: string;
}

export interface ConsoleLogProjectContext {
    mods?: ConsoleLogModContext[];
}

export interface AnalyzeConsoleLogOptions {
    includeDebug?: boolean;
}

export interface ConsoleLogReport {
    log: {
        path: string;
        sessionStart?: string;
        gameExited: boolean;
        totalLines: number;
        readError?: string;
    };
    stats: ConsoleLogStats;
    session: ConsoleLogSession;
    findings: ConsoleLogFinding[];
}

// Attribution ladder tier 1: the SEVERE `Error found in LUA file:` full path
// (design §Attribution ladder). Matches anywhere in the body; the version
// folder is optional for layouts without one.
const SEVERE_LUA_PATH =
    /Contents\/mods\/(?<modFolder>[^/]+)\/(?:(?<ver>common|42(?:\.\d+)?)\/)?media\/lua\/(?<rel>.+)$/i;

/**
 * Reads, parses, classifies and mod-attributes a console.txt session in one
 * pass. The log is read through the injected filesystem; a locked or
 * mid-write file (game still running) resolves as a report with
 * `log.readError` set and zeroed results — never a throw. Every attribution
 * tier is intersected with the session's `loadedModIds`, and genuinely
 * ambiguous candidates leave the finding unattributed (never misattributed).
 */
export async function analyzeConsoleLog(
    fs: ProjectFileSystem,
    logUri: string,
    context?: ConsoleLogProjectContext,
    options?: AnalyzeConsoleLogOptions,
): Promise<ConsoleLogReport> {
    let text: string;
    try {
        const bytes = await fs.read(logUri);
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (error) {
        return {
            log: {
                path: logUri,
                gameExited: false,
                totalLines: 0,
                readError: String(error),
            },
            stats: {
                totalLines: 0,
                byLevel: {},
                debugByChannel: {},
                junkCount: 0,
            },
            session: { loadedModIds: [], rejectedModIds: [] },
            findings: [],
        };
    }

    const assembled = assembleEntries(text.split(/\r\n|\r|\n/));
    const built = buildFindings(
        assembled.entries,
        assembled.totalLines,
        assembled.junkCount,
        options?.includeDebug,
    );
    await attributeFindings(built, assembled.entries, fs, context);

    return {
        log: {
            path: logUri,
            sessionStart: built.sessionStart,
            gameExited: built.gameExited,
            totalLines: built.stats.totalLines,
        },
        stats: built.stats,
        session: built.session,
        findings: built.findings,
    };
}

/**
 * Attribution ladder over the classifier's findings, in order:
 *  1. SEVERE full-path parse → mod id + exact workspace file,
 *  2. override-table match on path-like message tokens,
 *  3. basename → workspace lookup (42-over-common precedence),
 *  4. frame display-name owners (`Lua((MOD:<name>))` / B41 `| MOD: <name>`).
 *
 * The classifier's own attribution (`mod-rejected`) always stands; `line`
 * carried from the KahluaException pass is untouched.
 */
async function attributeFindings(
    result: BuildFindingsResult,
    entries: ParsedEntry[],
    fs: ProjectFileSystem,
    context: ConsoleLogProjectContext | undefined,
): Promise<void> {
    const loadedModIds = new Set(result.session.loadedModIds);
    // Every tier intersects with the session's loaded mods — an inactive mod
    // is never attributed.
    const contextMods = (context?.mods ?? []).filter((mod) =>
        loadedModIds.has(mod.modId),
    );

    // Tier-1 bookkeeping: a `SEVERE:` body belongs to the SEVERE line itself
    // and to the entry printed right after it (the paired ERROR block).
    const severeBodyByLine = new Map<number, string>();
    let pendingSevereBody: string | undefined;
    for (const entry of entries) {
        if (entry.kind === 'severe') {
            pendingSevereBody = entry.body;
            severeBodyByLine.set(entry.lineNo, entry.body);
            continue;
        }
        if (pendingSevereBody !== undefined) {
            severeBodyByLine.set(entry.lineNo, pendingSevereBody);
            pendingSevereBody = undefined;
        }
    }

    const entryByLine = new Map<number, ParsedEntry>();
    for (const entry of entries) {
        entryByLine.set(entry.lineNo, entry);
    }

    // Tier-3 bookkeeping: basename -> workspace URIs per context mod, built
    // lazily on the first finding that needs it.
    let basenameIndex:
        | Promise<Map<string, Array<{ modId: string; uri: string }>>>
        | undefined;
    const ensureBasenameIndex = () => {
        if (basenameIndex === undefined) {
            basenameIndex = buildBasenameIndex(fs, contextMods);
        }
        return basenameIndex;
    };

    for (const finding of result.findings) {
        if (finding.modId !== undefined) {
            continue;
        }

        // Tier 1 — SEVERE full-path parse → mod + exact workspace file.
        const severeBody = severeBodyByLine.get(finding.firstLine);
        if (severeBody !== undefined) {
            const path = SEVERE_LUA_PATH.exec(severeBody);
            if (path) {
                const modFolder = path.groups.modFolder;
                const contextMod = contextMods.find(
                    (mod) => mod.modId === modFolder,
                );
                if (contextMod) {
                    finding.modId = contextMod.modId;
                    if (path.groups.ver !== undefined) {
                        finding.sourceFile = `${contextMod.sourceRootUri}/${path.groups.ver}/media/lua/${path.groups.rel}`;
                    }
                    continue;
                }
                if (loadedModIds.has(modFolder)) {
                    // Workspace unknown (external mod): attribute the mod id
                    // only — no click-to-file target.
                    finding.modId = modFolder;
                    continue;
                }
            }
        }

        // Tier 2 — override table: path-like message tokens normalized to
        // forward slashes, matched against the virtual-path keys.
        if (finding.modId === undefined) {
            for (const token of pathTokens(finding.message)) {
                const overrideModId = overrideMapModIdFor(
                    token,
                    result.tables.overrideMap,
                );
                if (
                    overrideModId !== undefined &&
                    loadedModIds.has(overrideModId)
                ) {
                    finding.modId = overrideModId;
                    break;
                }
            }
        }

        // Tier 3 — basename → workspace lookup (42-over-common precedence).
        if (finding.sourceFile === undefined && contextMods.length > 0) {
            const frames = attributionFrames(
                finding,
                entryByLine.get(finding.firstLine),
            );
            const basename = frames.find((frame) => frame.file)?.file;
            if (basename !== undefined) {
                const owners = (await ensureBasenameIndex()).get(
                    basename.toLowerCase(),
                );
                if (owners && owners.length > 0) {
                    const ownerModIds = new Set(
                        owners.map((owner) => owner.modId),
                    );
                    if (ownerModIds.size === 1) {
                        const owner = owners[0];
                        if (finding.modId === undefined) {
                            finding.modId = owner.modId;
                            finding.sourceFile = owner.uri;
                        } else if (finding.modId === owner.modId) {
                            finding.sourceFile = owner.uri;
                        }
                        // A basename owned by a different mod than an earlier
                        // tier attributed would contradict it — leave the
                        // finding as is (never misattribute).
                    }
                }
            }
        }

        // Tier 4 — frame display-name owners, unambiguous only.
        if (finding.modId === undefined && contextMods.length > 0) {
            const frames = attributionFrames(
                finding,
                entryByLine.get(finding.firstLine),
            );
            for (const frame of frames) {
                if (frame.owner === undefined) {
                    continue;
                }
                const matches = contextMods.filter(
                    (mod) => mod.displayName === frame.owner,
                );
                if (matches.length === 1) {
                    finding.modId = matches[0].modId;
                    break;
                }
            }
        }
    }
}

/**
 * Frame data for attribution: the finding's own frames where the classifier
 * attached them (lua-syntax-error / engine-exception), otherwise re-derived
 * from the originating entry — `unclassified` findings carry no frames by
 * contract, but their block's frames still name basenames and owners.
 */
function attributionFrames(
    finding: ConsoleLogFinding,
    entry: ParsedEntry | undefined,
): ParsedFrame[] {
    if (finding.frames !== undefined && finding.frames.length > 0) {
        return finding.frames;
    }
    if (entry !== undefined) {
        return extractFrames(entry.continuations);
    }
    return [];
}

/** Indexes every eligible context mod's Lua basenames → `{ modId, uri }`. */
async function buildBasenameIndex(
    fs: ProjectFileSystem,
    mods: ConsoleLogModContext[],
): Promise<Map<string, Array<{ modId: string; uri: string }>>> {
    const index = new Map<string, Array<{ modId: string; uri: string }>>();
    for (const mod of mods) {
        const byBasename = await collectLuaBasenames(fs, mod);
        for (const [basename, uris] of byBasename) {
            const owners = uris.map((uri) => ({ modId: mod.modId, uri }));
            const existing = index.get(basename);
            if (existing) {
                existing.push(...owners);
            } else {
                index.set(basename, owners);
            }
        }
    }
    return index;
}

/**
 * Path-like tokens in a finding message: whitespace/quote-delimited runs
 * containing a slash, with surrounding bracket/paren punctuation stripped
 * (quoted-path failure headlines, `C:/Program Files (x86)/...`). Windows
 * separators normalize to forward slashes before the override-table match.
 */
function pathTokens(message: string): string[] {
    const tokens: string[] = [];
    for (const raw of message.split(/[\s"']+/)) {
        const token = raw.replace(/^[[(]+/, '').replace(/[)\],;]+$/, '');
        if (/[/\\]/.test(token)) {
            tokens.push(token.replace(/\\/g, '/'));
        }
    }
    return tokens;
}

/**
 * Longest override key the token equals or ends with at a `/` boundary —
 * the game prints resolved physical paths (`<game-root>/<virtual path>`)
 * while the override table holds the virtual path itself.
 */
function overrideMapModIdFor(
    token: string,
    overrideMap: Map<string, string>,
): string | undefined {
    let best: { key: string; modId: string } | undefined;
    for (const [key, modId] of overrideMap) {
        if (token === key || token.endsWith(`/${key}`)) {
            if (best === undefined || key.length > best.key.length) {
                best = { key, modId };
            }
        }
    }
    return best?.modId;
}
