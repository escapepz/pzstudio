import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

/**
 * The project.json schema ships in two copies (repo root for the CLI/docs,
 * packages/vscode-extension/schemas for editor IntelliSense). They must
 * stay in sync — this suite pins the dist-always amendment's
 * `build.materialize` field in both: enum `['symlink', 'copy']` only.
 * There is deliberately no 'none' value — omitting `outdir` is the only
 * "no deployment" expression (owner decision, 2026-11-12).
 */
const schemaCopies = [
    'pzstudio.schema.json',
    path.join(
        'packages',
        'vscode-extension',
        'schemas',
        'pzstudio.schema.json',
    ),
];

describe('project.json schema — build.materialize', () => {
    for (const rel of schemaCopies) {
        it(`${rel} declares build.materialize as ['symlink' | 'copy']`, () => {
            const schemaPath = path.join(process.cwd(), rel);
            const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
            expect(
                schema.properties?.build?.properties?.materialize,
            ).toMatchObject({
                type: 'string',
                enum: ['symlink', 'copy'],
            });
        });
    }
});
