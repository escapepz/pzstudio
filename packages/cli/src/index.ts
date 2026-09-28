#!/usr/bin/env node
import { runCLI } from './lib/cli';

runCLI().catch(() => {
    // Error already logged by runCLI; only the CLI bin sets the exit code.
    process.exit(1);
});
