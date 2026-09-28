import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Config for the real-environment suite (tests/real-env): every test spawns
 * the built CLI binary as a child process, so the main `pnpm test` run
 * excludes this directory and CI exercises it in a dedicated job after the
 * CLI build. No fake-home mocks here — isolation happens through real
 * HOME/USERPROFILE env overrides in the spawned process.
 */
export default defineConfig({
    ...baseConfig,
    test: {
        ...baseConfig.test,
        include: ['tests/real-env/**/*.test.ts'],
        setupFiles: [],
        testTimeout: 60000,
    },
});
