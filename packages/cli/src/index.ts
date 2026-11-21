#!/usr/bin/env node
import { runCLI } from './lib/cli';
import { CliUsageError } from './lib/parser';
import { markStandaloneBin } from './lib/runtime-context';

markStandaloneBin();

runCLI().catch((e) => {
    process.exit(e instanceof CliUsageError ? 2 : 1);
});
