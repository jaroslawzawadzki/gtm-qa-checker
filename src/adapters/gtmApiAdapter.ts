// The ONLY module that knows how GTM payloads look and where they come from.
// If Google changes the GTM UI's internal API, fix it here; the rest of the extension
// works on the normalized model from shared/types.ts.
//
// Supported inputs:
//  1. GTM UI internal API (tagmanager.google.com/api/…): XSSI-prefixed JSON wrapped in {"default": …}.
//     Entities look like {key:{tagId|triggerId|macroId, containerDraftId|containerVersionId}, data:{…}}.
//     Values are typed by numeric enums (see INTERNAL_VALUE / CONDITION_OPS / TRIGGER_TYPES below).
//     List endpoints of versions and variables omit parameters; per-entity detail endpoints return them.
//  2. Public GTM API v2 shapes and container export files (Admin > Export Container).
import type {
  ChangeStatus,
  DetectedCounts,
  EntityChange,
  EntityKind,
  GtmCondition,
  GtmConsentSettings,
  GtmContext,
  GtmParameter,
  GtmTemplate,
  GtmTag,
  GtmTrigger,
  GtmVariable,
  ScopeKey,
  VersionHeader,
  WorkspaceInfo,
} from '../shared/types';
import { defineMessages } from '../i18n';

// Named `msg` because `t` is used as a local variable in this module.
const msg = defineMessages({
  en: { noContainerContext: 'No container context (open a container in GTM).' },
  de: { noContainerContext: 'Kein Container-Kontext (öffnen Sie einen Container in GTM).' },
  pl: { noContainerContext: 'Brak kontekstu kontenera (otwórz kontener w GTM).' },
});

export interface ExtractedVersion {
  header: VersionHeader;
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
}

export interface Extracted {
  /** Entities not wrapped in a full version (workspace lists, detail views). */
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  /** Responses listing ALL entities of a kind in a scope; entities missing from them were deleted. */
  fullLists: { scope: ScopeKey | null; kind: EntityKind; ids: string[] }[];
  /** Version list entries without content. */
  versionHeaders: VersionHeader[];
  /** Full versions (version view, export file). */
  versions: ExtractedVersion[];
  workspaces: WorkspaceInfo[];
  /** workspaceId -> pending changes in that workspace. */
  workspaceChanges: Record<string, EntityChange[]>;
  /** Custom templates (names of cvt_… tag/variable types). */
  templates: GtmTemplate[];
  /** containerId -> publicId (GTM-XXXX) pairs seen anywhere in the payload. */
  containerPublicIds: Record<string, string>;
  /** publicId of the imported container, for export files. */
  publicId?: string;
  isExportFile: boolean;
}

type Obj = Record<string, unknown>;

const XSSI_PREFIX = /^\s*\)\]\}'[^\n]*\n?/;
const MAX_DEPTH = 16;

// --- endpoints ---------------------------------------------------------------

const KIND_PATH: Record<EntityKind, string> = { tag: 'tags', trigger: 'triggers', variable: 'variables' };

export type ScopeRef = { workspaceId: string } | { versionId: string };

/** Internal GTM UI endpoints (same-origin, read-only GETs). */
export const endpoints = {
  versionList: (c: GtmContext) => `${containerBase(c)}/versions`,
  version: (c: GtmContext, versionId: string) => `${containerBase(c)}/versions/${versionId}`,
  workspace: (c: GtmContext, workspaceId: string) => `${containerBase(c)}/workspaces/${workspaceId}`,
  workspaceChanges: (c: GtmContext, workspaceId: string) => `${containerBase(c)}/workspaces/${workspaceId}/changes`,
  workspaceTemplates: (c: GtmContext, workspaceId: string) => `${containerBase(c)}/workspaces/${workspaceId}/customtemplates`,
  list: (c: GtmContext, scope: ScopeRef, kind: EntityKind) => `${scopeBase(c, scope)}/${KIND_PATH[kind]}`,
  detail: (c: GtmContext, scope: ScopeRef, kind: EntityKind, entityId: string) =>
    `${scopeBase(c, scope)}/${KIND_PATH[kind]}/${entityId}`,
};

function containerBase(c: GtmContext): string {
  if (!c.accountId || !c.containerId) throw new Error(msg('noContainerContext'));
  return `/api/accounts/${c.accountId}/containers/${c.containerId}`;
}

function scopeBase(c: GtmContext, scope: ScopeRef): string {
  return 'workspaceId' in scope
    ? `${containerBase(c)}/workspaces/${scope.workspaceId}`
    : `${containerBase(c)}/versions/${scope.versionId}`;
}

// --- parsing -----------------------------------------------------------------

export function parseResponseText(text: string): unknown | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(XSSI_PREFIX, '').trim();
  if (!cleaned || (cleaned[0] !== '{' && cleaned[0] !== '[')) return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

/** Reads account/container/workspace/version ids from a GTM UI URL (hash route) or API URL. */
export function parseContext(href: string): GtmContext {
  const ctx: GtmContext = {};
  const container = href.match(/accounts\/(\d+)\/containers\/(\d+)/);
  if (container) {
    ctx.accountId = container[1];
    ctx.containerId = container[2];
  }
  const workspace = href.match(/workspaces\/(\d+)/);
  if (workspace) ctx.workspaceId = workspace[1];
  const version = href.match(/versions\/(\d+)/);
  if (version) ctx.versionId = version[1];
  return ctx;
}

/** Scope an API response belongs to, judged by its request URL. */
export function scopeFromUrl(url: string): ScopeKey | null {
  const { versionId, workspaceId } = parseContext(url);
  if (versionId) return `version:${versionId}`;
  if (workspaceId) return `workspace:${workspaceId}`;
  return null;
}

export function extractEntities(body: unknown): Extracted {
  const out: Extracted = {
    tags: [],
    triggers: [],
    variables: [],
    fullLists: [],
    versionHeaders: [],
    versions: [],
    workspaces: [],
    workspaceChanges: {},
    containerPublicIds: {},
    templates: [],
    isExportFile: false,
  };
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const o = node as Obj;
    rememberPublicId(o, out);

    // Export file (public format).
    if ('exportFormatVersion' in o && isObj(o.containerVersion)) {
      out.isExportFile = true;
      const container = o.containerVersion.container;
      if (isObj(container) && typeof container.publicId === 'string') out.publicId = container.publicId;
      out.versions.push(publicVersion(o.containerVersion));
      return;
    }

    // --- internal format ---
    if (isObj(o.key)) {
      const key = o.key;
      if (key.customTemplateId !== undefined) {
        const template = internalTemplate(o);
        if (template) out.templates.push(template);
        return;
      }
      if (key.folderId !== undefined || key.zoneId !== undefined) return;
      const entity = internalEntity(o);
      if (entity) {
        if (!(entity.kind === 'variable' && o.isBuiltIn === true)) pushEntity(out, entity);
        return;
      }
      if (key.containerVersionId !== undefined && isObj(o.data) && Array.isArray(o.data.tag)) {
        out.versions.push(internalVersion(o));
        out.templates.push(...arr(o.data.template).filter(isObj).map(internalTemplate).filter(notNull));
        return;
      }
      if (key.containerVersionId !== undefined && !isObj(o.data)) {
        out.versionHeaders.push(internalHeader(o));
        return;
      }
      if (key.containerDraftId !== undefined && isObj(o.data) && 'baseContainerVersionId' in o) {
        out.workspaces.push(internalWorkspace(o));
        return;
      }
      if (key.containerDraftId !== undefined && Array.isArray(o.entity)) {
        out.workspaceChanges[String(key.containerDraftId)] = o.entity.filter(isObj).map(internalChange).filter(notNull);
        return;
      }
    }

    // Arrays holding every entity of one kind ({tag:[…]}, {variable:[…]} …).
    for (const kind of ['tag', 'trigger', 'variable'] as const) {
      const list = o[kind];
      if (Array.isArray(list) && !isObj(o.key) && list.every((x) => isObj(x) && isObj(x.key))) {
        const before = entityCount(out, kind);
        walk(list, depth + 1);
        const added = (kind === 'tag' ? out.tags : kind === 'trigger' ? out.triggers : out.variables).slice(before);
        out.fullLists.push({ scope: added[0] ? entityScope(added[0]) : null, kind, ids: added.map((e) => e.id) });
      }
    }

    // --- public API v2 format ---
    if (isPublicFullVersion(o)) {
      out.versions.push(publicVersion(o));
      return;
    }
    if (isPublicVersionHeader(o)) {
      out.versionHeaders.push(publicHeader(o));
      return;
    }
    const pub = publicTag(o) ?? publicTrigger(o) ?? publicVariable(o);
    if (pub) return void pushEntity(out, pub);

    for (const value of Object.values(o)) walk(value, depth + 1);
  };

  walk(body, 0);
  return out;
}

export function countExtracted(ex: Extracted): DetectedCounts {
  const counts: DetectedCounts = {
    tags: ex.tags.length,
    triggers: ex.triggers.length,
    variables: ex.variables.length,
    versions: ex.versions.length,
    headers: ex.versionHeaders.length,
  };
  for (const v of ex.versions) {
    counts.tags += v.tags.length;
    counts.triggers += v.triggers.length;
    counts.variables += v.variables.length;
  }
  return counts;
}

export function entityScope(e: { workspaceId?: string; versionId?: string }): ScopeKey | null {
  if (e.versionId) return `version:${e.versionId}`;
  if (e.workspaceId) return `workspace:${e.workspaceId}`;
  return null;
}

// --- helpers -------------------------------------------------------------------

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

function id(v: unknown): string | undefined {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
}

function str(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return v === undefined || v === null || v === '' || Number.isNaN(n) ? undefined : n;
}

/** Epoch-ms timestamps arrive as strings ("1789108183379"). */
function ts(v: unknown): number | undefined {
  const n = Number(v);
  return n > 1e12 && n < 1e13 ? n : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function ids(v: unknown): string[] {
  return arr(v).map(id).filter((x): x is string => x !== undefined);
}

function entityCount(out: Extracted, kind: EntityKind): number {
  return kind === 'tag' ? out.tags.length : kind === 'trigger' ? out.triggers.length : out.variables.length;
}

function pushEntity(out: Extracted, e: GtmTag | GtmTrigger | GtmVariable): void {
  if (e.kind === 'tag') out.tags.push(e);
  else if (e.kind === 'trigger') out.triggers.push(e);
  else out.variables.push(e);
}

function rememberPublicId(o: Obj, out: Extracted): void {
  // Account tree: {key:{containerId}, properties:{publicId}}; versions: {key:{containerId}, publicId}.
  const publicId = typeof o.publicId === 'string' ? o.publicId : isObj(o.properties) ? o.properties.publicId : undefined;
  if (typeof publicId !== 'string' || !publicId.startsWith('GTM-')) return;
  // Account trees list many containers, so a publicId is only usable together with its containerId.
  const containerId = id(o.containerId) ?? (isObj(o.key) ? id(o.key.containerId) : undefined);
  if (containerId) out.containerPublicIds[containerId] = publicId;
}

// --- internal format: values ------------------------------------------------------

const INTERNAL_VALUE = { string: 1, list: 2, map: 3, macro: 4, integer: 6, boolean: 8 } as const;

/** Trigger condition operators (verified: 0, 1, 4). */
const CONDITION_OPS: Record<number, string> = { 0: 'matchRegex', 1: 'equals', 4: 'contains' };

/** Trigger types (verified against real containers). */
const TRIGGER_TYPES: Record<number, string> = {
  1: 'pageview',
  2: 'domReady',
  4: 'customEvent',
  6: 'formSubmission',
  7: 'click',
  36: 'init',
  38: 'consentInit',
};

const CONSENT_STATUS: Record<number, string> = { 0: 'notSet', 1: 'notNeeded', 2: 'needed' };

const CHANGE_STATUS: Record<number, ChangeStatus> = { 0: 'none', 1: 'added', 2: 'deleted', 3: 'modified' };

/** Text form of an internal value; macro references become {{Name}} like in the GTM UI. */
function internalScalar(v: unknown): string {
  if (!isObj(v)) return '';
  switch (v.type) {
    case INTERNAL_VALUE.string:
      return str(v.string) ?? '';
    case INTERNAL_VALUE.macro:
      return `{{${str(v.macroReference) ?? '?'}}}`;
    case INTERNAL_VALUE.integer:
      return str(v.integer) ?? '';
    case INTERNAL_VALUE.boolean:
      return String(v.boolean === true);
  }
  const tokens = arr(v.templateToken);
  if (tokens.length) return tokens.map(internalScalar).join('');
  return str(v.string) ?? (v.macroReference !== undefined ? `{{${str(v.macroReference)}}}` : '');
}

function internalParam(v: unknown, key?: string): GtmParameter {
  const p: GtmParameter = key === undefined ? {} : { key };
  if (!isObj(v)) return p;
  switch (v.type) {
    case INTERNAL_VALUE.string:
    case INTERNAL_VALUE.macro:
      p.type = 'template';
      p.value = internalScalar(v);
      break;
    case INTERNAL_VALUE.integer:
      p.type = 'integer';
      p.value = internalScalar(v);
      break;
    case INTERNAL_VALUE.boolean:
      p.type = 'boolean';
      p.value = internalScalar(v);
      break;
    case INTERNAL_VALUE.list:
      p.type = 'list';
      p.list = arr(v.listItem).map((item) => internalParam(item));
      break;
    case INTERNAL_VALUE.map: {
      const keys = arr(v.mapKey);
      p.type = 'map';
      p.map = arr(v.mapValue).map((val, i) => internalParam(val, internalScalar(keys[i])));
      break;
    }
    default:
      p.type = `internal:${String(v.type)}`;
      p.value = internalScalar(v);
  }
  return p;
}

function internalParams(vendorTemplate: unknown): GtmParameter[] {
  if (!isObj(vendorTemplate)) return [];
  return arr(vendorTemplate.param)
    .filter(isObj)
    .map((p) => internalParam(p.value, str(p.key)));
}

function templateId(vendorTemplate: unknown): string | undefined {
  return isObj(vendorTemplate) && isObj(vendorTemplate.key) ? str(vendorTemplate.key.publicId) : undefined;
}

function internalConsent(v: unknown): GtmConsentSettings | undefined {
  if (!isObj(v)) return undefined;
  const settings = isObj(v.manualConsentSettings) ? v.manualConsentSettings : undefined;
  return {
    status: CONSENT_STATUS[Number(v.manualConsentStatus)] ?? `internal:${String(v.manualConsentStatus)}`,
    types: arr(settings?.listItem).map(internalScalar).filter(Boolean),
  };
}

function internalConditions(v: unknown): GtmCondition[] {
  return arr(v)
    .filter(isObj)
    .map((c) => {
      const [left, right] = arr(c.arg);
      return {
        op: CONDITION_OPS[Number(c.type)] ?? `op:${String(c.type)}`,
        negate: c.negate === true,
        left: internalScalar(left),
        right: internalScalar(right),
      };
    });
}

// --- internal format: entities ----------------------------------------------------

function internalEntity(o: Obj): GtmTag | GtmTrigger | GtmVariable | null {
  const key = o.key as Obj;
  const data = o.data;
  if (!isObj(data) || typeof data.name !== 'string') return null;
  const stat = isObj(o.statMetadata) ? o.statMetadata : {};
  const draft = isObj(o.containerDraftMetadata) ? o.containerDraftMetadata : undefined;
  const params = internalParams(data.vendorTemplate);
  const common = {
    name: data.name,
    fingerprint: str(stat.entityVersion),
    modifiedAt: ts(stat.modifiedTime),
    workspaceId: id(key.containerDraftId),
    versionId: id(key.containerVersionId),
    changeStatus: draft ? (CHANGE_STATUS[Number(draft.changeStatus)] ?? 'unknown') : undefined,
    notes: str(data.notes),
    raw: o,
  };

  if (key.tagId !== undefined) {
    return {
      kind: 'tag',
      id: String(key.tagId),
      type: templateId(data.vendorTemplate) ?? `internal:${String(data.type)}`,
      parameters: params,
      paramsComplete: params.length > 0,
      firingTriggerIds: ids(data.positiveTriggerId),
      blockingTriggerIds: ids(data.negativeTriggerId),
      paused: data.paused === true,
      consent: internalConsent(data.consentSettings),
      ...common,
    };
  }
  if (key.triggerId !== undefined) {
    return {
      kind: 'trigger',
      id: String(key.triggerId),
      type: TRIGGER_TYPES[Number(data.type)] ?? `internal:${String(data.type)}`,
      // Trigger settings live outside vendorTemplate and are always present in lists.
      parameters: params,
      paramsComplete: true,
      filters: {
        filter: internalConditions(data.filter),
        customEventFilter: internalConditions(data.customEventFilter),
        autoEventFilter: internalConditions(data.autoEventFilter),
      },
      ...common,
    };
  }
  if (key.macroId !== undefined) {
    return {
      kind: 'variable',
      id: String(key.macroId),
      type: templateId(data.vendorTemplate) ?? `internal:${String(data.type)}`,
      parameters: params,
      paramsComplete: params.length > 0,
      ...common,
    };
  }
  return null;
}

function internalChange(o: Obj): EntityChange | null {
  const keyName = Object.keys(o).find((k) => k !== 'key' && k.endsWith('Key') && isObj(o[k]));
  if (!keyName) return null;
  const key = o[keyName] as Obj;
  const entityType: EntityChange['entityType'] =
    keyName === 'tagKey'
      ? 'tag'
      : keyName === 'triggerKey'
        ? 'trigger'
        : keyName === 'variableKey' || keyName === 'macroKey'
          ? 'variable'
          : keyName === 'customTemplateKey'
            ? 'template'
            : keyName === 'folderKey'
              ? 'folder'
              : 'other';
  const entityId = id(key.tagId ?? key.triggerId ?? key.macroId ?? key.variableId ?? key.customTemplateId ?? key.folderId);
  const draft = isObj(o.containerDraftMetadata) ? o.containerDraftMetadata : {};
  return {
    entityType,
    id: entityId ?? '?',
    name: str(o.name) ?? '',
    status: CHANGE_STATUS[Number(draft.changeStatus)] ?? 'unknown',
    templateType: str(o.publicId),
  };
}

function internalTemplate(o: Obj): GtmTemplate | null {
  const key = o.key as Obj;
  const data = isObj(o.data) ? o.data : {};
  const displayName = isObj(data.displayName) ? arr(data.displayName.text).filter(isObj)[0] : undefined;
  const name = str(displayName?.value);
  if (!name) return null;
  const gallery = isObj(o.galleryReference) ? str(o.galleryReference.galleryTemplateId) : undefined;
  // Tags reference gallery templates as cvt_<galleryId>, container-local ones as cvt_<containerId>_<templateId>.
  return { id: gallery ? `cvt_${gallery}` : `cvt_${str(key.containerId)}_${str(key.customTemplateId)}`, name };
}

function internalHeader(o: Obj): VersionHeader {
  const key = o.key as Obj;
  const stat = isObj(o.statMetadata) ? o.statMetadata : {};
  return {
    versionId: id(key.containerVersionId) ?? '?',
    name: str(o.name),
    description: str(o.description),
    author: str(stat.createdBy) ?? str(o.versionPublisher),
    createdAt: ts(stat.createdTime),
    publishedAt: ts(o.versionLastPublishedTime),
    publicId: str(o.publicId),
    numTags: num(o.numTags),
    numTriggers: num(o.numTriggers),
    numVariables: num(o.numVariables),
    deleted: o.archived === true,
  };
}

function internalVersion(o: Obj): ExtractedVersion {
  const data = o.data as Obj;
  const header = internalHeader(o);
  header.changes = arr(data.changedEntity).filter(isObj).map(internalChange).filter(notNull);
  const entities = [...arr(data.tag), ...arr(data.trigger), ...arr(data.variable)]
    // Built-in triggers (All Pages, …) are kept because tags reference them; built-in variables are noise.
    .filter((x): x is Obj => isObj(x) && isObj(x.key) && !(x.isBuiltIn === true && x.key.macroId !== undefined))
    .map(internalEntity)
    .filter(notNull);
  const tags = entities.filter((e): e is GtmTag => e.kind === 'tag');
  const triggers = entities.filter((e): e is GtmTrigger => e.kind === 'trigger');
  const variables = entities.filter((e): e is GtmVariable => e.kind === 'variable');
  header.numTags ??= tags.length;
  header.numTriggers ??= triggers.length;
  header.numVariables ??= variables.length;
  return { header, tags, triggers, variables };
}

function internalWorkspace(o: Obj): WorkspaceInfo {
  const key = o.key as Obj;
  const data = o.data as Obj;
  return {
    workspaceId: String(key.containerDraftId),
    name: str(data.name),
    baseVersionId: id(o.baseContainerVersionId),
    changeCount: num(o.changeCount),
    modifiedAt: ts(o.lastModifiedTime),
  };
}

// --- public API v2 / export format --------------------------------------------------

function isPublicFullVersion(o: Obj): boolean {
  return (
    id(o.containerVersionId) !== undefined &&
    (Array.isArray(o.tag) || Array.isArray(o.trigger) || Array.isArray(o.variable))
  );
}

function isPublicVersionHeader(o: Obj): boolean {
  return (
    id(o.containerVersionId) !== undefined &&
    o.tagId === undefined &&
    o.triggerId === undefined &&
    o.variableId === undefined
  );
}

function publicHeader(o: Obj): VersionHeader {
  return {
    versionId: id(o.containerVersionId) ?? '?',
    name: str(o.name),
    description: str(o.description),
    numTags: num(o.numTags),
    numTriggers: num(o.numTriggers),
    numVariables: num(o.numVariables),
    deleted: o.deleted === true,
    createdAt: ts(o.fingerprint),
  };
}

function publicVersion(o: Obj): ExtractedVersion {
  const header = publicHeader(o);
  header.numTags ??= arr(o.tag).length;
  header.numTriggers ??= arr(o.trigger).length;
  header.numVariables ??= arr(o.variable).length;
  return {
    header,
    tags: arr(o.tag).filter(isObj).map(publicTag).filter(notNull),
    triggers: arr(o.trigger).filter(isObj).map(publicTrigger).filter(notNull),
    variables: arr(o.variable).filter(isObj).map(publicVariable).filter(notNull),
  };
}

function publicParams(v: unknown): GtmParameter[] {
  return arr(v).filter(isObj).map(publicParam);
}

function publicParam(p: Obj): GtmParameter {
  const out: GtmParameter = { type: str(p.type), key: str(p.key), value: str(p.value) };
  if (Array.isArray(p.list)) out.list = publicParams(p.list);
  if (Array.isArray(p.map)) out.map = publicParams(p.map);
  return out;
}

function publicConsent(v: unknown): GtmConsentSettings | undefined {
  if (!isObj(v)) return undefined;
  const typeParam = isObj(v.consentType) ? v.consentType : undefined;
  const types = arr(typeParam?.list)
    .filter(isObj)
    .map((x) => str(x.value))
    .filter((x): x is string => !!x);
  return { status: str(v.consentStatus) ?? 'notSet', types };
}

function publicConditions(v: unknown): GtmCondition[] {
  return arr(v)
    .filter(isObj)
    .map((c) => {
      const params = arr(c.parameter).filter(isObj);
      const arg = (k: string) => str(params.find((p) => p.key === k)?.value) ?? '';
      const negate = params.some((p) => p.key === 'negate' && p.value === 'true');
      return { op: str(c.type) ?? '?', negate, left: arg('arg0'), right: arg('arg1') };
    });
}

function publicBase(o: Obj, entityId: string) {
  const parameters = publicParams(o.parameter);
  return {
    id: entityId,
    name: String(o.name),
    type: str(o.type) ?? 'unknown',
    parameters,
    paramsComplete: true,
    fingerprint: str(o.fingerprint),
    modifiedAt: ts(o.fingerprint),
    workspaceId: id(o.workspaceId),
    notes: str(o.notes),
    raw: o,
  };
}

function publicTag(o: Obj): GtmTag | null {
  const tagId = id(o.tagId);
  if (!tagId || typeof o.name !== 'string') return null;
  return {
    kind: 'tag',
    ...publicBase(o, tagId),
    firingTriggerIds: ids(o.firingTriggerId),
    blockingTriggerIds: ids(o.blockingTriggerId),
    paused: o.paused === true,
    consent: publicConsent(o.consentSettings),
  };
}

function publicTrigger(o: Obj): GtmTrigger | null {
  const triggerId = id(o.triggerId);
  if (!triggerId || typeof o.name !== 'string' || o.tagId !== undefined) return null;
  return {
    kind: 'trigger',
    ...publicBase(o, triggerId),
    filters: {
      filter: publicConditions(o.filter),
      customEventFilter: publicConditions(o.customEventFilter),
      autoEventFilter: publicConditions(o.autoEventFilter),
    },
  };
}

function publicVariable(o: Obj): GtmVariable | null {
  const variableId = id(o.variableId);
  if (!variableId || typeof o.name !== 'string') return null;
  return { kind: 'variable', ...publicBase(o, variableId) };
}
