import { IModConfig } from './project';

/**
 * Parses mod.info text into a partial IModConfig.
 * @param content The mod.info file content
 * @returns {Partial<IModConfig> & { id?: string }} The parsed mod config
 */
export function parseModInfoText(
    content: string,
): Partial<IModConfig> & { id?: string } {
    const lines = content.split('\n');
    const result: any = {
        description: [],
        poster: [],
        require: [],
        incompatible: [],
        loadModAfter: [],
        loadModBefore: [],
        pack: [],
        tiledef: [],
    };

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('//') || line.startsWith('#')) continue;

        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) continue;

        const key = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim();

        switch (key) {
            case 'id':
                result[key] = value;
                break;
            case 'name':
                result[key] = value;
                break;
            case 'author':
                result[key] = value;
                break;
            case 'modversion':
                result[key] = value;
                break;
            case 'icon':
                result[key] = value;
                break;
            case 'category':
                result[key] = value;
                break;
            case 'url':
                result[key] = value;
                break;
            case 'versionMin':
                result[key] = value;
                break;
            case 'versionMax':
                result[key] = value;
                break;
            case 'description':
                result.description.push(value);
                break;
            case 'pack': {
                result.pack.push(value);
                break;
            }
            case 'tiledef': {
                result.tiledef.push(value);
                break;
            }
            case 'poster':
                result.poster.push(value);
                break;
            case 'require':
                result.require.push(...value.split(',').map((s) => s.trim()));
                break;
            case 'incompatible':
                result.incompatible.push(
                    ...value.split(',').map((s) => s.trim()),
                );
                break;
            case 'loadModAfter':
                result.loadModAfter.push(
                    ...value.split(',').map((s) => s.trim()),
                );
                break;
            case 'loadModBefore':
                result.loadModBefore.push(
                    ...value.split(',').map((s) => s.trim()),
                );
                break;
            default:
                // Preserve unknown fields for forward compatibility
                result[key] = value;
                break;
        }
    }

    // Clean up empty arrays
    if (result.description.length === 0) delete result.description;
    else if (result.description.length === 1)
        result.description = result.description[0];

    if (result.poster.length === 0) delete result.poster;
    else if (result.poster.length === 1) result.poster = result.poster[0];

    if (result.require.length === 0) delete result.require;
    if (result.incompatible.length === 0) delete result.incompatible;
    if (result.loadModAfter.length === 0) delete result.loadModAfter;
    if (result.loadModBefore.length === 0) delete result.loadModBefore;

    if (result.pack.length === 0) delete result.pack;
    else if (result.pack.length === 1) result.pack = result.pack[0];

    if (result.tiledef.length === 0) delete result.tiledef;
    else if (result.tiledef.length === 1) result.tiledef = result.tiledef[0];

    return result;
}
