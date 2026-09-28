import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            // The extension imports the CLI by package name; pin it to the
            // built CLI output so vi.mock() and the real import resolve to
            // the same module id from anywhere in the test graph.
            'pzstudio-cli': fileURLToPath(
                new URL('./packages/cli/dist', import.meta.url),
            ),
            // Workspace packages resolve to their sources in tests so the
            // suite never depends on a prior build of them.
            '@pzstudio/platform': fileURLToPath(
                new URL('./packages/platform/src/index.ts', import.meta.url),
            ),
            '@pzstudio/core': fileURLToPath(
                new URL('./packages/core/src/index.ts', import.meta.url),
            ),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        setupFiles: ['./tests/setup/vitest.setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: [
                'packages/cli/src/**/*.ts',
                'packages/vscode-extension/src/**/*.ts',
            ],
        },
        sequence: {
            concurrent: false,
        },
        testTimeout: 15000,
    },
});
