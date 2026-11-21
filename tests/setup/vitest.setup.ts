import { vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

(globalThis as any).__PZSTUDIO_FAKE_HOME = undefined;

process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_ALLOW_PROTOCOL = 'file';

vi.mock('os', async (importOriginal) => {
    const original = await importOriginal<typeof import('os')>();
    return {
        ...original,
        homedir: () =>
            (globalThis as any).__PZSTUDIO_FAKE_HOME || original.homedir(),
    };
});

vi.mock('node:os', async (importOriginal) => {
    const original = await importOriginal<typeof import('os')>();
    return {
        ...original,
        homedir: () =>
            (globalThis as any).__PZSTUDIO_FAKE_HOME || original.homedir(),
    };
});

const originalHomedir = os.homedir;
os.homedir = () =>
    (globalThis as any).__PZSTUDIO_FAKE_HOME || originalHomedir();

const getFakeHome = () => (globalThis as any).__PZSTUDIO_FAKE_HOME;
const setFakeHome = (p: string | undefined) => {
    (globalThis as any).__PZSTUDIO_FAKE_HOME = p;
};

beforeEach(() => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pzstudio-home-'));
    setFakeHome(tempHome);
});

afterEach(() => {
    const tempHome = getFakeHome();
    if (tempHome && tempHome.includes('pzstudio-home-')) {
        try {
            fs.rmSync(tempHome, { recursive: true, force: true });
        } catch (_e) {}
    }
    setFakeHome(undefined);
});

export { getFakeHome, setFakeHome };
