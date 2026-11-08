/**
 * First-run one-shot surfaces, pinned by marker files under the config dir
 * (~/.pzstudio). The first-success URL print congratulates the first
 * successful `pzstudio build` of a standalone bin run with the landing
 * page URL: print-then-mark ordering means a failed marker write can never
 * lose the print (it may repeat next session — accepted, mirroring
 * usage.ts ensureNotice()), and the marker pins the print to exactly once
 * per machine. Nothing is transmitted — the URL is only printed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './templateManager';

export const LANDING_URL_CLI =
    'https://escapepz.github.io/pzstudio/?utm_source=cli-print';

const FIRST_BUILD_MARKER = '.first-build-url-shown';

/**
 * Prints the first-success URL exactly once per machine: returns false
 * without printing when the marker file already exists in `dir` (the
 * override wins over the config dir — test seam), otherwise prints the
 * URL line and pins the marker best-effort (a failed write swallows and
 * still returns true, so the print already emitted is never a lie).
 */
export function maybePrintFirstBuildUrl(
    print: (line: string) => void,
    dirOverride?: string,
): boolean {
    const dir = dirOverride ?? getConfigDir();
    const marker = join(dir, FIRST_BUILD_MARKER);
    if (existsSync(marker)) return false;
    print(
        `First successful build with PZ Studio! Tips & updates: ${LANDING_URL_CLI}`,
    );
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(marker, '', 'utf-8');
    } catch {
        // Best-effort marker (mirrors usage.ts ensureNotice): a failed
        // write means the URL may repeat next session — accepted; it must
        // never break the build that earned it.
    }
    return true;
}
