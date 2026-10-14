// Normalized GTM model used by every module (diff, linter, LLM, report).
// Only gtmApiAdapter.ts knows how raw GTM payloads map onto these types.

export interface GtmParameter {
  type?: string; // template | boolean | integer | list | map (internal types we can't map: "internal:<n>")
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
}

export interface GtmConsentSettings {
  status: string; // needed | notNeeded | notSet
  types: string[]; // e.g. ad_storage, ad_user_data
}

/** One trigger condition, e.g. {{_event}} equals purchase. */
export interface GtmCondition {
  op: string; // equals | contains | matchRegex | … (unknown internal codes: "op:<n>")
  negate: boolean;
  left: string;
  right: string;
}

export type ChangeStatus = 'none' | 'added' | 'deleted' | 'modified' | 'unknown';

interface EntityBase {
  id: string;
  name: string;
  type: string;
  parameters: GtmParameter[];
  /** False when the source (e.g. a list view) omits parameters; a detail fetch fills them in. */
  paramsComplete: boolean;
  /** Changes whenever the entity is edited; equal fingerprints mean identical content. */
  fingerprint?: string;
  modifiedAt?: number;
  workspaceId?: string;
  versionId?: string;
  /** Workspace change status relative to the base version (workspace scope only). */
  changeStatus?: ChangeStatus;
  notes?: string;
  raw: unknown;
}

export interface GtmTag extends EntityBase {
  kind: 'tag';
  firingTriggerIds: string[];
  blockingTriggerIds: string[];
  paused: boolean;
  consent?: GtmConsentSettings;
}

export interface GtmTrigger extends EntityBase {
  kind: 'trigger';
  filters: {
    filter: GtmCondition[];
    customEventFilter: GtmCondition[];
    autoEventFilter: GtmCondition[];
  };
}

export interface GtmVariable extends EntityBase {
  kind: 'variable';
}

export type GtmEntity = GtmTag | GtmTrigger | GtmVariable;
export type EntityKind = GtmEntity['kind'];

/** Entry of a version's / workspace's change list. */
export interface EntityChange {
  entityType: EntityKind | 'template' | 'folder' | 'other';
  id: string;
  name: string;
  status: ChangeStatus;
  /** Tag/variable template id, e.g. gaawe, awct, html. */
  templateType?: string;
}

export interface VersionHeader {
  versionId: string;
  name?: string;
  description?: string;
  author?: string;
  createdAt?: number;
  publishedAt?: number;
  publicId?: string;
  numTags?: number;
  numTriggers?: number;
  numVariables?: number;
  deleted?: boolean;
  /** What changed in this version compared to the previous one. */
  changes?: EntityChange[];
}

export interface WorkspaceInfo {
  workspaceId: string;
  name?: string;
  baseVersionId?: string;
  changeCount?: number;
  modifiedAt?: number;
  changes?: EntityChange[];
}

/** Custom template (community gallery or container-local); tags/variables reference it by `id`. */
export interface GtmTemplate {
  /** Type id used by tags/variables: cvt_<galleryId> or cvt_<containerId>_<templateId>. */
  id: string;
  name: string;
}

export type ScopeKey = `workspace:${string}` | `version:${string}` | `import:${string}`;

export interface Snapshot {
  key: ScopeKey;
  label: string;
  tags: Record<string, GtmTag>;
  triggers: Record<string, GtmTrigger>;
  variables: Record<string, GtmVariable>;
  /** true when the entity set is complete (full version / full workspace lists / export). */
  complete: boolean;
  updatedAt: number;
}

export interface GtmContext {
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  versionId?: string;
  publicId?: string;
}

export interface DetectedCounts {
  tags: number;
  triggers: number;
  variables: number;
  versions: number;
  headers: number;
}
