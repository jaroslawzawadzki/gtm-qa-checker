// In-memory registry of everything extracted from GTM in this tab, grouped by scope
// (workspace, version or imported file).
import { entityScope, type Extracted } from '../adapters/gtmApiAdapter';
import type {
  EntityChange,
  EntityKind,
  GtmContext,
  GtmEntity,
  ScopeKey,
  Snapshot,
  VersionHeader,
  WorkspaceInfo,
} from '../shared/types';
import { defineMessages } from '../i18n';

const t = defineMessages({
  en: {
    workspace: 'Workspace {id}',
    workspaceUnknown: 'Workspace (unknown)',
    version: 'Version {id}',
    versionNamed: 'Version {id} – {name}',
    import: 'Import: {name}',
  },
  de: {
    workspace: 'Workspace {id}',
    workspaceUnknown: 'Workspace (unbekannt)',
    version: 'Version {id}',
    versionNamed: 'Version {id} – {name}',
    import: 'Import: {name}',
  },
  pl: {
    workspace: 'Workspace {id}',
    workspaceUnknown: 'Workspace (nieznany)',
    version: 'Wersja {id}',
    versionNamed: 'Wersja {id} – {name}',
    import: 'Import: {name}',
  },
});

type Listener = () => void;

export class GtmStore {
  context: GtmContext = {};
  readonly snapshots = new Map<ScopeKey, Snapshot>();
  readonly versionHeaders = new Map<string, VersionHeader>();
  readonly workspaces = new Map<string, WorkspaceInfo>();
  /** cvt_… type id -> custom template name (e.g. cvt_MBTSV -> Data Tag). */
  readonly templates = new Map<string, string>();
  private readonly containerPublicIds = new Map<string, string>();
  /** Entities with full parameters, keyed by kind:id:fingerprint — identical across versions. */
  private readonly detailCache = new Map<string, GtmEntity>();
  private readonly listeners = new Set<Listener>();
  private batchDepth = 0;
  private dirty = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Groups many ingests (e.g. dozens of detail fetches) into a single change notification. */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.batchDepth++;
    try {
      return await fn();
    } finally {
      if (--this.batchDepth === 0 && this.dirty) this.emit();
    }
  }

  private emit(): void {
    if (this.batchDepth > 0) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    this.listeners.forEach((fn) => fn());
  }

  setContext(next: GtmContext): void {
    // Scopes are keyed by workspace/version number only, which repeat across containers: GTM is a
    // single-page app, so switching containers must drop everything loaded for the previous one.
    if (next.containerId && this.context.containerId && next.containerId !== this.context.containerId) this.reset();
    if (this.applyContext(next)) this.emit();
  }

  /** Forgets all container data (on container switch). Templates and publicIds are keyed globally and stay. */
  private reset(): void {
    this.snapshots.clear();
    this.versionHeaders.clear();
    this.workspaces.clear();
    this.detailCache.clear();
  }

  /** Updates the context (publicId resolved from containerId); returns true if it changed. */
  private applyContext(next: GtmContext): boolean {
    const publicId = next.containerId ? this.containerPublicIds.get(next.containerId) : undefined;
    const merged: GtmContext = { ...next, publicId };
    if (JSON.stringify(merged) === JSON.stringify(this.context)) return false;
    this.context = merged;
    return true;
  }

  /** Scope for entities whose payload and URL carry no workspace/version id. */
  fallbackScope(): ScopeKey {
    if (this.context.versionId) return `version:${this.context.versionId}`;
    return `workspace:${this.context.workspaceId ?? 'unknown'}`;
  }

  /** Entities in a scope that still lack parameters (need a detail fetch). */
  incompleteEntities(scope: ScopeKey): GtmEntity[] {
    const snap = this.snapshots.get(scope);
    if (!snap) return [];
    return [...Object.values(snap.tags), ...Object.values(snap.variables)].filter((e) => !e.paramsComplete);
  }

  ingest(ex: Extracted, urlScope: ScopeKey | null, importName?: string): void {
    for (const [containerId, publicId] of Object.entries(ex.containerPublicIds)) {
      this.containerPublicIds.set(containerId, publicId);
    }
    this.applyContext(this.context);

    for (const entity of [...ex.tags, ...ex.triggers, ...ex.variables]) {
      const scope = entityScope(entity) ?? urlScope ?? this.fallbackScope();
      this.upsert(this.snapshot(scope), entity);
    }

    // A response listing every entity of a kind: drop entities that no longer exist.
    for (const list of ex.fullLists) {
      const scope = list.scope ?? urlScope;
      if (!scope) continue;
      const snap = this.snapshot(scope);
      const keep = new Set(list.ids);
      const bucket = bucketOf(snap, list.kind);
      for (const entityId of Object.keys(bucket)) if (!keep.has(entityId)) delete bucket[entityId];
    }

    for (const t of ex.templates) this.templates.set(t.id, t.name);
    for (const header of ex.versionHeaders) this.upsertHeader(header);

    for (const version of ex.versions) {
      const scope: ScopeKey = importName ? `import:${importName}` : `version:${version.header.versionId}`;
      // A full version defines the entity set; keep richer copies of unchanged entities.
      const prev = this.snapshots.get(scope);
      this.snapshots.delete(scope);
      const snap = this.snapshot(scope, version.header.name);
      snap.complete = true;
      for (const entity of [...version.tags, ...version.triggers, ...version.variables]) {
        const old = prev ? bucketOf(prev, entity.kind)[entity.id] : undefined;
        this.upsert(snap, old && old.fingerprint === entity.fingerprint && old.paramsComplete ? old : entity);
      }
      if (!importName) this.upsertHeader(version.header);
    }

    for (const ws of ex.workspaces) {
      this.workspaces.set(ws.workspaceId, { ...this.workspaces.get(ws.workspaceId), ...definedOnly(ws), workspaceId: ws.workspaceId });
    }
    for (const [workspaceId, changes] of Object.entries(ex.workspaceChanges)) {
      this.workspaces.set(workspaceId, { ...(this.workspaces.get(workspaceId) ?? { workspaceId }), changes });
    }

    this.emit();
  }

  markComplete(scope: ScopeKey): void {
    const snap = this.snapshots.get(scope);
    if (snap && !snap.complete) {
      snap.complete = true;
      this.emit();
    }
  }

  markParamsComplete(scope: ScopeKey, kind: EntityKind, entityId: string): void {
    const snap = this.snapshots.get(scope);
    const entity = snap ? bucketOf(snap, kind)[entityId] : undefined;
    if (!entity || entity.paramsComplete) return;
    entity.paramsComplete = true;
    if (entity.fingerprint) this.detailCache.set(`${kind}:${entityId}:${entity.fingerprint}`, entity);
    this.emit();
  }

  /** Recomputes snapshot labels in the active language (after a language switch). */
  relabel(): void {
    for (const snap of this.snapshots.values()) {
      const [kind, scopeId] = snap.key.split(':', 2) as [string, string];
      const versionName = kind === 'version' ? this.versionHeaders.get(scopeId)?.name : undefined;
      snap.label = labelFor(snap.key, versionName);
    }
    this.emit();
  }

  changesFor(scope: ScopeKey): EntityChange[] | undefined {
    const [kind, scopeId] = scope.split(':', 2) as [string, string];
    if (kind === 'version') return this.versionHeaders.get(scopeId)?.changes;
    if (kind === 'workspace') return this.workspaces.get(scopeId)?.changes;
    return undefined;
  }

  private upsertHeader(header: VersionHeader): void {
    this.versionHeaders.set(header.versionId, { ...this.versionHeaders.get(header.versionId), ...definedOnly(header), versionId: header.versionId });
  }

  private snapshot(key: ScopeKey, versionName?: string): Snapshot {
    let snap = this.snapshots.get(key);
    if (!snap) {
      snap = { key, label: labelFor(key, versionName), tags: {}, triggers: {}, variables: {}, complete: false, updatedAt: Date.now() };
      this.snapshots.set(key, snap);
    }
    return snap;
  }

  private upsert(snap: Snapshot, incoming: GtmEntity): void {
    const cacheKey = incoming.fingerprint ? `${incoming.kind}:${incoming.id}:${incoming.fingerprint}` : null;
    let entity = incoming;
    if (cacheKey) {
      if (entity.paramsComplete) this.detailCache.set(cacheKey, entity);
      else {
        const cached = this.detailCache.get(cacheKey);
        // Reuse parameters fetched for another scope, keep scope-specific fields of the incoming entity.
        if (cached) entity = { ...cached, workspaceId: incoming.workspaceId, versionId: incoming.versionId, changeStatus: incoming.changeStatus } as GtmEntity;
      }
    }
    const bucket = bucketOf(snap, entity.kind);
    const prev = bucket[entity.id];
    // Never downgrade a detailed entity to a list-view copy of the same content.
    if (prev && prev.paramsComplete && !entity.paramsComplete && prev.fingerprint === entity.fingerprint) {
      if (entity.changeStatus !== undefined) prev.changeStatus = entity.changeStatus;
      return;
    }
    bucket[entity.id] = entity;
    snap.updatedAt = Date.now();
  }
}

function bucketOf(snap: Snapshot, kind: EntityKind): Record<string, GtmEntity> {
  return (kind === 'tag' ? snap.tags : kind === 'trigger' ? snap.triggers : snap.variables) as Record<string, GtmEntity>;
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function labelFor(key: ScopeKey, versionName?: string): string {
  const [kind, scopeId] = key.split(':', 2) as [string, string];
  if (kind === 'workspace') return scopeId === 'unknown' ? t('workspaceUnknown') : t('workspace', { id: scopeId });
  if (kind === 'version') return versionName ? t('versionNamed', { id: scopeId, name: versionName }) : t('version', { id: scopeId });
  return t('import', { name: scopeId });
}
