import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

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
