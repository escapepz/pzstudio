#!/usr/bin/env node
import { runCLI } from './lib/cli';
import { CliUsageError } from './lib/parser';

runCLI().catch((e) => {
    // Error already logged by runCLI; only the CLI bin sets the exit code.
    // 0 success / 1 runtime failure / 2 usage error (130 = SIGINT).
    process.exit(e instanceof CliUsageError ? 2 : 1);
});
