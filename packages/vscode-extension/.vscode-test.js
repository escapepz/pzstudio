const { defineConfig } = require('@vscode/test-cli');
const { createIntegrationFixture } = require('./scripts/integration-fixture');

/**
 * Desktop integration tests in a real VS Code instance (@vscode/test-electron
 * under the hood). The fixture project opens as the workspace; the fake home
 * keeps the CLI api inside the extension host away from the real ~/.pzstudio.
 * Run with: pnpm --filter pzstudio42 test:integration
 */
const fixture = createIntegrationFixture();

module.exports = defineConfig({
    files: ['out/test/integration.test.js'],
    // Pin to the engines.vscode minimum so the suite validates the oldest
    // supported host, independent of the current stable release.
    version: '1.102.0',
    extensionDevelopmentPath: __dirname,
    workspaceFolder: fixture.projectDir,
    // --disable-workspace-trust: the throwaway CI profile has nobody to
    // click the trust dialog, and an untrusted workspace gates extension
    // activation — the test run would hang forever. --disable-extensions
    // keeps the host hermetic (the dev extension still loads);
    // --disable-gpu avoids flaky GPU init in headless-ish environments.
    launchArgs: [
        '--disable-workspace-trust',
        '--disable-extensions',
        '--disable-gpu',
    ],
    env: {
        HOME: fixture.home,
        USERPROFILE: fixture.home,
        PZSTUDIO_TEST_PROJECT_DIR: fixture.projectDir,
        PZSTUDIO_TEST_FAKE_HOME: fixture.home,
    },
    mocha: {
        ui: 'bdd',
        timeout: 60000,
    },
});
