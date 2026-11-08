/**
 * Process-wide runtime context flags. The standalone-bin gate distinguishes
 * a real terminal run of the published `pzstudio` bin (the extension-hosted
 * API path imports the same command code in-process) so one-shot surfaces
 * — like the first-build URL print — fire only where a human can actually
 * read them. `index.ts` (the bin entry) marks the process before anything
 * else runs; every other entry path (api.ts, extension host) leaves the
 * flag false. Not persisted: the gate lives exactly as long as the process.
 */
let standalone = false;

/** Marks the current process as a standalone CLI bin run (bin entry only). */
export function markStandaloneBin(): void {
    standalone = true;
}

/** Whether the current process is a standalone CLI bin run. */
export function isStandaloneBin(): boolean {
    return standalone;
}
