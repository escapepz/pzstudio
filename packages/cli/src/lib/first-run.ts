import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './templateManager';

export const LANDING_URL_CLI =
    'https://escapepz.github.io/pzstudio/landing/?utm_source=cli-print';

const FIRST_BUILD_MARKER = '.first-build-url-shown';

export function maybePrintFirstBuildUrl(
    print: (line: string) => void,
    dirOverride?: string,
): boolean {
    const dir = dirOverride ?? getConfigDir();
    const marker = join(dir, FIRST_BUILD_MARKER);
    if (existsSync(marker)) return false;
    print(`See tips & updates -> ${LANDING_URL_CLI}`);
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(marker, '', 'utf-8');
    } catch {}
    return true;
}
