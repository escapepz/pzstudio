/**
 * Stage-1 envelope peelers for Project Zomboid console.txt lines.
 *
 * Three line families are recognised, tried in order:
 *  1. the padded console envelope (`LOG  : General      f:0> ...`),
 *  2. the SEVERE family (`SEVERE: ...`, defensively `WARNING:` / `INFO:`),
 *  3. JUL header captions (`Nov 15, 2026 1:30:13 PM zombie.Lua.LuaManager
 *     RunLuaInternal]`).
 *
 * This module is pure (no I/O, no Node builtins): callers feed raw lines and
 * get a PeeledLine back. Unknown lines come back as `kind: 'other'` — nothing
 * is ever dropped; later stages own classification and continuations.
 *
 * Stage 2 lives here too: `assembleEntries` groups peeled lines into entries
 * with their tab-prefixed continuations (capped at 64 lines), and the dormant
 * continuation extractors (`extractKahluaException`, `extractFrames`)
 * classify continuation content for later classification stages.
 */

export type ConsoleLogLevel =
    | 'TRACE'
    | 'NOISE'
    | 'DEBUG'
    | 'LOG'
    | 'WARN'
    | 'ERROR'
    | 'SEVERE'
    | 'WARNING'
    | 'INFO';

export interface PeeledLine {
    kind: 'envelope' | 'severe' | 'jul-header' | 'other';
    /** envelope + severe only */
    level?: ConsoleLogLevel;
    /** envelope only, trimmed */
    channel?: string;
    /** f: value */
    frame?: number;
    /** from `at <caller>` clause, or body-embedded promotion */
    caller?: string;
    /** remainder after `> ` / after `SEVERE: ` */
    body?: string;
    /** jul-header only */
    julClass?: string;
    /** jul-header only */
    julMethod?: string;
    raw: string;
}

const PADDED_ENVELOPE =
    /^(?<level>LOG|WARN|ERROR|DEBUG|TRACE|NOISE)\s{0,2}:\s+(?<channel>[A-Za-z]+)\s+f:(?<frame>\d+)(?:[,\s]+(?:t|st):[\d,]+)*(?:\s+at\s+(?<caller>[^>\r\n]+?)\s*)?>\s?(?<body>.*)$/;

const BODY_EMBEDDED_CALLER = /^([A-Za-z0-9_$.()]+)> (.*)$/;

const SEVERE_FAMILY = /^(?<level>SEVERE|WARNING|INFO)\s*:\s*(?<body>.*)$/;

const JUL_HEADER =
    /^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} (?:AM|PM) (?<julClass>[\w.]+) (?<julMethod>\w+)\]$/;

export function peelLine(raw: string): PeeledLine {
    const padded = PADDED_ENVELOPE.exec(raw);
    if (padded) {
        const groups = padded.groups;
        let caller = groups.caller;
        let body = groups.body;
        if (!caller) {
            const promoted = BODY_EMBEDDED_CALLER.exec(body);
            if (promoted) {
                caller = promoted[1];
                body = promoted[2];
            }
        }
        return {
            kind: 'envelope',
            level: groups.level as ConsoleLogLevel,
            channel: groups.channel,
            frame: parseInt(groups.frame, 10),
            caller,
            body,
            raw,
        };
    }

    const severe = SEVERE_FAMILY.exec(raw);
    if (severe) {
        return {
            kind: 'severe',
            level: severe.groups.level as ConsoleLogLevel,
            body: severe.groups.body,
            raw,
        };
    }

    const jul = JUL_HEADER.exec(raw);
    if (jul) {
        return {
            kind: 'jul-header',
            julClass: jul.groups.julClass,
            julMethod: jul.groups.julMethod,
            raw,
        };
    }

    return { kind: 'other', raw };
}

/** One assembled log entry: an envelope/severe/jul-header line plus its continuations. */
export interface ParsedEntry {
    kind: 'envelope' | 'severe' | 'jul-header';
    level?: ConsoleLogLevel;
    channel?: string;
    frame?: number;
    caller?: string;
    body: string;
    /** 1-based */
    lineNo: number;
    /** following tab-prefixed lines, verbatim (tabs kept) */
    continuations: string[];
    /** true when truncated at the 64-line cap */
    continuationsCapped: boolean;
}

export interface AssembleResult {
    entries: ParsedEntry[];
    totalLines: number;
    junkCount: number;
}

export type ParsedFrame = {
    kind: 'lua' | 'lua-vm' | 'engine' | 'jvm';
    text: string;
    /** basename */
    file?: string;
    line?: number;
    /** Lua(Vanilla) | Lua((MOD:<display name>)) display name | B41 `| MOD:` value */
    owner?: string;
};

export interface KahluaExceptionInfo {
    basename: string;
    line: number;
    message: string;
}

const CONTINUATION_CAP = 64;

const KAHLUA_EXCEPTION =
    /^\s*se\.krka\.kahlua\.vm\.KahluaException:\s*(?<basename>[^:]+\.lua):(?<line>\d+):\s*(?<msg>.+?)\s+at\s+Lua\./;

const B41_FRAME =
    /^\s*function:\s+\S+\s+--\s+file:\s+(?<file>[^|]+?)\s+line\s+#\s+(?<line>\d+)(?:\s*\|\s*(?:MOD:\s*(?<mod>.+)|Vanilla))?/;

const LUA_FRAME =
    /^\s*Lua(?:\((?<owner>\(MOD:[^)]*\)|[^)]*)\))?\.(?<func>[\w$.]+)\((?<basename>[^():]+\.lua):(?<line>\d+)\)\s*$/;

const JVM_FRAME = /^\s*(?:at\s+)?(?<frame>[A-Za-z_$][\w$./]*)\((?:[^)]*)\)\s*$/;

/**
 * Assembles peeled lines into entries. Envelope/severe/jul-header lines open
 * a new entry; `kind: 'other'` lines attach to the current entry as verbatim
 * continuations only when tab-prefixed (capped at 64, flagging
 * `continuationsCapped`); every other 'other' line counts as junk — nothing
 * is silently dropped.
 */
export function assembleEntries(lines: string[]): AssembleResult {
    const entries: ParsedEntry[] = [];
    let junkCount = 0;
    let current: ParsedEntry | undefined;

    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        const peeled = peelLine(raw);
        if (peeled.kind !== 'other') {
            current = {
                kind: peeled.kind,
                level: peeled.level,
                channel: peeled.channel,
                frame: peeled.frame,
                caller: peeled.caller,
                body:
                    peeled.kind === 'jul-header'
                        ? peeled.raw
                        : (peeled.body ?? ''),
                lineNo: i + 1,
                continuations: [],
                continuationsCapped: false,
            };
            entries.push(current);
            continue;
        }
        if (current && raw.startsWith('\t')) {
            if (current.continuations.length < CONTINUATION_CAP) {
                current.continuations.push(raw);
            } else {
                current.continuationsCapped = true;
                junkCount += 1;
            }
        } else {
            junkCount += 1;
        }
    }

    return { entries, totalLines: lines.length, junkCount };
}

/** Finds the Kahlua compile-error headline in an entry's continuations, if any. */
export function extractKahluaException(
    continuations: string[],
): KahluaExceptionInfo | null {
    for (const cont of continuations) {
        const found = KAHLUA_EXCEPTION.exec(cont);
        if (found) {
            return {
                basename: found.groups.basename,
                line: parseInt(found.groups.line, 10),
                message: found.groups.msg,
            };
        }
    }
    return null;
}

/**
 * Classifies continuation lines into stack frames. B42 synthetic Lua frames
 * and the B41-era Kahlua frames carry file/line (+owner); JVM-shaped frames
 * are classified by leading package: kahlua/luaj-fork → lua-vm,
 * `zombie.*` → engine, everything else → jvm. Captions (`Stack trace:`,
 * `Caused by: `, `Suppressed: `), separators and exception headlines never
 * become frames.
 */
export function extractFrames(continuations: string[]): ParsedFrame[] {
    const frames: ParsedFrame[] = [];
    for (const cont of continuations) {
        const trimmed = cont.trim();
        if (!trimmed) {
            continue;
        }
        if (
            trimmed === 'Stack trace:' ||
            trimmed.startsWith('Caused by: ') ||
            trimmed.startsWith('Suppressed: ')
        ) {
            continue;
        }

        const lua = LUA_FRAME.exec(cont);
        if (lua) {
            frames.push({
                kind: 'lua',
                text: trimmed,
                file: lua.groups.basename,
                line: parseInt(lua.groups.line, 10),
                owner: unwrapModOwner(lua.groups.owner),
            });
            continue;
        }

        const b41 = B41_FRAME.exec(cont);
        if (b41) {
            frames.push({
                kind: 'lua',
                text: trimmed,
                file: b41.groups.file,
                line: parseInt(b41.groups.line, 10),
                owner: b41.groups.mod,
            });
            continue;
        }

        const jvm = JVM_FRAME.exec(cont);
        if (jvm) {
            const cls = jvm.groups.frame;
            let kind: ParsedFrame['kind'] = 'jvm';
            if (
                cls.startsWith('se.krka.kahlua.') ||
                cls.startsWith('org.luaj.kahluafork.')
            ) {
                kind = 'lua-vm';
            } else if (cls.startsWith('zombie.')) {
                kind = 'engine';
            }
            frames.push({
                kind,
                text: trimmed.replace(/^at\s+/, ''),
                file: undefined,
                line: undefined,
                owner: undefined,
            });
        }
    }
    return frames;
}

function unwrapModOwner(owner: string | undefined): string | undefined {
    if (!owner) {
        return undefined;
    }
    const mod = /^\(MOD:(.+)\)$/.exec(owner);
    return mod ? mod[1] : owner;
}
