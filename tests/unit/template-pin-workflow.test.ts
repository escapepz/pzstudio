import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const yaml = readFileSync('.github/workflows/template-pin.yml', 'utf8');

describe('template-pin workflow invariants', () => {
    it('declares manual + scheduled triggers, write permissions, and the script gate', () => {
        expect(yaml).toContain('workflow_dispatch');
        expect(yaml).toMatch(/schedule:/); // periodic runs
        expect(yaml).toContain('contents: write');
        expect(yaml).toContain('pull-requests: write');
        expect(yaml).toContain('--check');
        expect(yaml).toContain('template-pin'); // label AND branch name
        expect(yaml).toContain('concurrency'); // no overlapping runs
    });

    it('runs single-flight against a fixed PR branch, label, and base default', () => {
        expect(yaml).toContain('group: template-pin');
        expect(yaml).toContain('cancel-in-progress: false');
        expect(yaml).toContain('--label template-pin');
        expect(yaml).toContain('chore/template-pin'); // PR branch
        // PR base defaults to the dev line when the dispatch input is unset
        // (scheduled runs have no inputs at all).
        expect(yaml).toContain("inputs.base || '42.22.0-dev'");
    });

    it('gates on the script exit code and loud-fails on internal errors', () => {
        expect(yaml).toContain("steps.check.outputs.code == '1'");
        expect(yaml).toContain("steps.check.outputs.code == '2'");
        expect(yaml).not.toContain("steps.check.outcome == 'failure'");
    });

    it('never touches protected refs, never sweeps the worktree, never merges', () => {
        const pushes = yaml.match(/git push\b[^\n]*/g) ?? [];
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toContain('chore/template-pin');
        expect(yaml).not.toMatch(/git commit\s+-\S*a/i);
        expect(yaml).not.toContain('gh pr merge');
        expect(yaml).not.toContain('auto-merge');
        expect(yaml).toContain('fetch-depth: 1');
        expect(yaml).not.toContain('submodules:');
    });
});
