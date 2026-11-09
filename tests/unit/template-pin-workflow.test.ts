import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Invariant test for the template-pin CI workflow: reads the workflow file
// as plain text relative to the vitest CWD (repo root) and pins the shape
// that must never regress. String assertions on purpose — no YAML parser in
// dev deps, and the load-bearing parts of the file are its exact literals.
const yaml = readFileSync('.github/workflows/template-pin.yml', 'utf8');

describe('template-pin workflow invariants', () => {
    it('declares manual + scheduled triggers, write permissions, and the script gate', () => {
        expect(yaml).toContain('workflow_dispatch'); // manual runs
        expect(yaml).toMatch(/schedule:/); // periodic runs
        expect(yaml).toContain('contents: write');
        expect(yaml).toContain('pull-requests: write');
        expect(yaml).toContain('--check'); // gate on the script
        expect(yaml).toContain('template-pin'); // label AND branch name
        expect(yaml).toContain('concurrency'); // no overlapping runs
    });

    it('runs single-flight against a fixed PR branch, label, and base default', () => {
        expect(yaml).toContain('group: template-pin');
        expect(yaml).toContain('cancel-in-progress: false');
        expect(yaml).toContain('--label template-pin'); // PR carries the label
        expect(yaml).toContain('chore/template-pin'); // PR branch
        // PR base defaults to the dev line when the dispatch input is unset
        // (scheduled runs have no inputs at all).
        expect(yaml).toContain("inputs.base || '42.22.0-dev'");
    });

    it('never touches protected refs, never sweeps the worktree, never merges', () => {
        // Single sanctioned ref write: the force-push of the PR branch,
        // which is reset onto base at the start of each run. *-dev, main
        // and release/* refs are never pushed by any step.
        const pushes = yaml.match(/git push\b[^\n]*/g) ?? [];
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toContain('chore/template-pin');
        // The pin commit is a plain commit of the index that update-index
        // staged; no step may fold worktree changes into it.
        expect(yaml).not.toMatch(/git commit\s+-\S*a/i);
        // Merging stays a human decision.
        expect(yaml).not.toContain('gh pr merge');
        expect(yaml).not.toContain('auto-merge');
        // Checkout stays shallow and submodule-free: the pin script works
        // from ls-remote plus the index, never from submodule content.
        expect(yaml).toContain('fetch-depth: 1');
        expect(yaml).not.toContain('submodules:');
    });
});
