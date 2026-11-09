#!/usr/bin/env node
import { runCLI } from './lib/cli';
import { CliUsageError } from './lib/parser';
import { markStandaloneBin } from './lib/runtime-context';

// First statement of the bin: only a real terminal run of the published
// CLI gates the one-shot standalone surfaces (first-build URL print) —
// in-process API/extension-host runs of the same command code stay unmarked.
markStandaloneBin();

runCLI().catch((e) => {
    // Error already logged by runCLI; only the CLI bin sets the exit code.
    // 0 success / 1 runtime failure / 2 usage error (130 = SIGINT).
    process.exit(e instanceof CliUsageError ? 2 : 1);
});
