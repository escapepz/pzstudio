import { describe, it, expect } from 'vitest';
import {
    validateConfig,
    ValidationContext,
    type GlobalConfig,
} from '@pzstudio/core';

const validate = (config: any) => {
    const ctx = new ValidationContext('config.json');
    validateConfig(config, ctx);
    return ctx;
};

describe('GlobalConfig usageLog validation', () => {
    it('accepts absent usageLog', () => {
        expect(validate({ templates: {} }).hasErrors()).toBe(false);
    });
    it('accepts usageLog.enabled boolean', () => {
        expect(
            validate({
                templates: {},
                usageLog: { enabled: false },
            }).hasErrors(),
        ).toBe(false);
    });
    it('rejects usageLog.enabled non-boolean', () => {
        const ctx = validate({ templates: {}, usageLog: { enabled: 'yes' } });
        expect(ctx.hasErrors()).toBe(true);
    });
    it('rejects non-object usageLog', () => {
        expect(validate({ templates: {}, usageLog: true }).hasErrors()).toBe(
            true,
        );
    });
    it('GlobalConfig type carries usageLog (compile-time)', () => {
        const c: GlobalConfig = { templates: {}, usageLog: { enabled: false } };
        expect(c.usageLog?.enabled).toBe(false);
    });
});
