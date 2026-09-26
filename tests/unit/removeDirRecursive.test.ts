'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { removeDirRecursive } from '../../src/lib/helper';

vi.mock('fs');
vi.mock('../../src/lib/logger');

const RMDIR_OPTIONS = {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
};

describe('removeDirRecursive', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('deletes with recursive, force and retries', () => {
        removeDirRecursive('/out/x');

        expect(fs.rmSync).toHaveBeenCalledWith('/out/x', RMDIR_OPTIONS);
    });

    it('wraps ENOTEMPTY into a friendly in-use error', () => {
        vi.mocked(fs.rmSync).mockImplementation(() => {
            const e = new Error('not empty') as NodeJS.ErrnoException;
            e.code = 'ENOTEMPTY';
            throw e;
        });

        expect(() => removeDirRecursive('/out/x')).toThrow(
            "Cannot delete '/out/x' — the folder is in use by another program (the game, Steam, or Explorer). Close it and try again.",
        );
    });

    it('wraps EBUSY into a friendly in-use error', () => {
        vi.mocked(fs.rmSync).mockImplementation(() => {
            const e = new Error('busy') as NodeJS.ErrnoException;
            e.code = 'EBUSY';
            throw e;
        });

        expect(() => removeDirRecursive('/out/x')).toThrow(
            'the folder is in use by another program',
        );
    });

    it('rethrows unrelated errors as-is', () => {
        vi.mocked(fs.rmSync).mockImplementation(() => {
            const e = new Error('input/output error') as NodeJS.ErrnoException;
            e.code = 'EIO';
            throw e;
        });

        expect(() => removeDirRecursive('/out/x')).toThrow(
            'input/output error',
        );
    });
});
