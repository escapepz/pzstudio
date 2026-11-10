/**
 * @pzstudio/platform-node — Node.js adapter for @pzstudio/platform.
 */
export { NodeFileSystem } from './node-file-system';
export { NODE_CAPABILITIES } from './node-capabilities';
export {
    normalizeLinkTarget,
    inspectWorkshopLink,
    ERR_WORKSHOP_PATH_NOT_DIRECTORY,
    ERR_FOREIGN_WORKSHOP_LINK,
    ERR_LINK_IDENTITY_MISMATCH,
    ERR_UNOWNED_DIST_TARGET,
} from './link/linkManager';
export type {
    LinkPlatform,
    StatsLike,
    LinkFs,
    LinkState,
    WorkshopLinkInspection,
    InspectWorkshopLinkOptions,
} from './link/linkManager';
