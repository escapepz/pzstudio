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

// Padded console envelope. Level prefixes are the fixed LogSeverity literals
// (`TRACE: `, `DEBUG: `, `LOG  : `, `WARN : `, `ERROR: `). The caller capture
// terminates at the first `>`, so embedded `ERROR:`/`>` text in the body can
// never re-open the envelope; `Lua(<owner>).<func>` callers pass through
// `[^>\r\n]+?`. `t:`/`st:` metadata is config-gated and optional.
const PADDED_ENVELOPE =
    /^(?<level>LOG|WARN|ERROR|DEBUG|TRACE)\s{0,2}:\s+(?<channel>[A-Za-z]+)\s+f:(?<frame>\d+)(?:[,\s]+(?:t|st):[\d,]+)*(?:\s+at\s+(?<caller>[^>\r\n]+?)\s*)?>\s?(?<body>.*)$/;

// Body-embedded caller promotion: `LuaManager.RunLuaInternal> Exception thrown`.
const BODY_EMBEDDED_CALLER = /^([A-Za-z0-9_$.()]+)> (.*)$/;

// SEVERE family (no channel/frame; WARNING/INFO included defensively for
// other JUL records).
const SEVERE_FAMILY = /^(?<level>SEVERE|WARNING|INFO)\s*:\s*(?<body>.*)$/;

// JUL header caption printed above a multi-line JUL record. Date part is
// `Mon dd, yyyy hh:mm:ss AM|PM` (java.util.logging SimpleFormatter). NOTE:
// the spec §Parser design carries a duplicated `[A-Z][a-z]{2}` token before
// the day; verbatim it can never match the pinned evidence line
// (`Nov 15, 2026 1:30:13 PM zombie.Lua.LuaManager RunLuaInternal]`), so the
// duplicate is dropped — the only deviation from the spec's regex.
const JUL_HEADER =
    /^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} (?:AM|PM) (?<julClass>[\w.]+) (?<julMethod>\w+)\]$/;

export function peelLine(raw: string): PeeledLine {
    const padded = PADDED_ENVELOPE.exec(raw);
    if (padded) {
        const groups = padded.groups;
        let caller = groups.caller;
        let body = groups.body;
        if (!caller) {
            // Promote a body-embedded caller (`<caller>> message`).
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
