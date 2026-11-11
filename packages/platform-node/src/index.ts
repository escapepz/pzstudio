/**
 * @pzstudio/platform-node — Node.js adapter for @pzstudio/platform.
 */
export { NodeFileSystem } from './node-file-system';
export { NODE_CAPABILITIES } from './node-capabilities';
export {
    normalizeLinkTarget,
    inspectWorkshopLink,
    attachWorkshopLink,
    detachWorkshopLink,
    ERR_WORKSHOP_PATH_NOT_DIRECTORY,
    ERR_FOREIGN_WORKSHOP_LINK,
    ERR_LINK_IDENTITY_MISMATCH,
    ERR_UNOWNED_DIST_TARGET,
    ERR_WORKSHOP_DIR_EXISTS_REAL,
} from './link/linkManager';
export type {
    LinkPlatform,
    StatsLike,
    LinkFs,
    LinkState,
    WorkshopLinkInspection,
    InspectWorkshopLinkOptions,
    RealFs,
    AttachWorkshopLinkOptions,
    DetachWorkshopLinkOptions,
    AttachResult,
    DetachResult,
} from './link/linkManager';
export {
    inspectMaterializeSlot,
    reconcileCopySlot,
    materializeCopySlot,
    ERR_COPY_SLOT_HAND_MADE,
    ERR_COPY_SLOT_NOT_DIRECTORY,
    ERR_COPY_SLOT_LINK_INSIDE,
} from './link/copyMaterializer';
export type {
    CopyFs,
    CopyStats,
    CopyDirEntry,
    CopySlotState,
    CopySlotIdentity,
    MaterializeSlotInspection,
    InspectMaterializeSlotOptions,
    ReconcileCopySlotOptions,
    ReconcileResult,
    MaterializeCopySlotOptions,
} from './link/copyMaterializer';
