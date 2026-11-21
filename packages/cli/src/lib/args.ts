import { getActiveInvocationContext } from './invocation';

type InvocationOptions = Record<string, string | boolean | undefined>;

let currentInvocationOptions: InvocationOptions = {};

export function setInvocationOptions(
    options: InvocationOptions | undefined,
): void {
    currentInvocationOptions = options ?? {};
}

export function extractFlag(name: string): string | undefined {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        const value = ctx.invocationOptions[name];
        return typeof value === 'string' ? value : undefined;
    }
    const value = currentInvocationOptions[name];
    return typeof value === 'string' ? value : undefined;
}

export function hasFlag(name: string): boolean {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        const value = ctx.invocationOptions[name];
        return value === true || typeof value === 'string';
    }
    const value = currentInvocationOptions[name];
    return value === true || typeof value === 'string';
}
