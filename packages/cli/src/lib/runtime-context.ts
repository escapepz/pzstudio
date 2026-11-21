let standalone = false;

export function markStandaloneBin(): void {
    standalone = true;
}

export function isStandaloneBin(): boolean {
    return standalone;
}
