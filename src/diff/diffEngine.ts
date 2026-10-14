// Pure diff logic: choosing what to compare (planDiff) and comparing two snapshots (diffSnapshots).
// No I/O here, so it can be unit-tested with plain objects.
import type {
  EntityChange,
  EntityKind,
  GtmEntity,
  GtmParameter,
  ScopeKey,
  Snapshot,
  VersionHeader,
  WorkspaceInfo,
} from '../shared/types';
import { defineMessages } from '../i18n';

const t = defineMessages({
  en: {
    noBaseVersion: 'The workspace base version is unknown – load the workspace or choose a version.',
    workspaceLabel: 'Workspace {id}',
    workspaceNamedLabel: 'Workspace {id} ({name})',
    workspaceDescription: 'Unsaved changes in workspace {id} compared to version {versionId}',
    sameVersions: 'Choose two different versions.',
    rangeDescription: 'Changes published after version {from} up to and including version {to}',
    emptyContainer: 'Empty container',
    lastHours: 'the last {hours} h',
    hoursWithWorkspace: 'Publications from {window} plus unsaved changes in workspace {id}',
    noPublications: 'No publications within {window}.',
    hoursDescription: 'Publications from {window} ({count})',
    version: 'Version {id}',
    versionNamed: 'Version {id} – {name}',
    incompleteList: '{label}: incomplete entity list – the result may miss changes.',
    missingParams: '{label}: {count} entities without parameters – parameter changes may be missed.',
    fieldName: 'Name',
    fieldType: 'Type',
    fieldNotes: 'Notes',
    fieldPaused: 'Paused',
    fieldFiring: 'Firing triggers',
    fieldBlocking: 'Blocking triggers',
    fieldConsent: 'Consent',
    yes: 'yes',
    no: 'no',
    condFilter: 'Conditions',
    condCustomEvent: 'Event conditions',
    condAutoEvent: 'Auto-event conditions',
  },
  de: {
    noBaseVersion: 'Die Basisversion des Workspace ist unbekannt – laden Sie den Workspace oder wählen Sie eine Version.',
    workspaceLabel: 'Workspace {id}',
    workspaceNamedLabel: 'Workspace {id} ({name})',
    workspaceDescription: 'Nicht gespeicherte Änderungen im Workspace {id} im Vergleich zu Version {versionId}',
    sameVersions: 'Wählen Sie zwei unterschiedliche Versionen.',
    rangeDescription: 'Änderungen, veröffentlicht nach Version {from} bis einschließlich Version {to}',
    emptyContainer: 'Leerer Container',
    lastHours: 'den letzten {hours} h',
    hoursWithWorkspace: 'Veröffentlichungen aus {window} sowie nicht gespeicherte Änderungen im Workspace {id}',
    noPublications: 'Keine Veröffentlichungen in {window}.',
    hoursDescription: 'Veröffentlichungen aus {window} ({count})',
    version: 'Version {id}',
    versionNamed: 'Version {id} – {name}',
    incompleteList: '{label}: unvollständige Liste der Elemente – im Ergebnis können Änderungen fehlen.',
    missingParams: '{label}: {count} Elemente ohne Parameter – Parameteränderungen können fehlen.',
    fieldName: 'Name',
    fieldType: 'Typ',
    fieldNotes: 'Notizen',
    fieldPaused: 'Pausiert',
    fieldFiring: 'Auslösende Trigger',
    fieldBlocking: 'Blockierende Trigger',
    fieldConsent: 'Consent',
    yes: 'ja',
    no: 'nein',
    condFilter: 'Bedingungen',
    condCustomEvent: 'Ereignisbedingungen',
    condAutoEvent: 'Auto-Ereignis-Bedingungen',
  },
  pl: {
    noBaseVersion: 'Nie znam wersji bazowej workspace’u – wczytaj workspace lub wybierz wersję.',
    workspaceLabel: 'Workspace {id}',
    workspaceNamedLabel: 'Workspace {id} ({name})',
    workspaceDescription: 'Niezapisane zmiany workspace’u {id} względem wersji {versionId}',
    sameVersions: 'Wybierz dwie różne wersje.',
    rangeDescription: 'Zmiany opublikowane po wersji {from} do wersji {to} włącznie',
    emptyContainer: 'Pusty kontener',
    lastHours: 'ostatnich {hours} h',
    hoursWithWorkspace: 'Publikacje z {window} oraz niezapisane zmiany workspace’u {id}',
    noPublications: 'Brak publikacji w ciągu {window}.',
    hoursDescription: 'Publikacje z {window} ({count})',
    version: 'Wersja {id}',
    versionNamed: 'Wersja {id} – {name}',
    incompleteList: '{label}: niepełna lista encji – wynik może pomijać zmiany.',
    missingParams: '{label}: {count} encji bez parametrów – zmiany parametrów mogą być pominięte.',
    fieldName: 'Nazwa',
    fieldType: 'Typ',
    fieldNotes: 'Notatki',
    fieldPaused: 'Wstrzymany',
    fieldFiring: 'Reguły uruchamiające',
    fieldBlocking: 'Reguły blokujące',
    fieldConsent: 'Zgody',
    yes: 'tak',
    no: 'nie',
    condFilter: 'Warunki',
    condCustomEvent: 'Warunki zdarzenia',
    condAutoEvent: 'Warunki auto-zdarzenia',
  },
});

// --- planning --------------------------------------------------------------------

export type DiffRequest =
  /** Unpublished workspace changes against a version (default: the workspace's base version). */
  | { mode: 'workspace'; workspaceId: string; versionId?: string }
  /** Net effect of publishing versions after `fromVersionId` up to and including `toVersionId`. */
  | { mode: 'range'; fromVersionId: string; toVersionId: string }
  /** Everything published in the last N hours, optionally plus the current workspace. */
  | { mode: 'hours'; hours: number; now: number; workspaceId?: string };

/** A side of the comparison. `empty` stands for "before the first version". */
export type DiffSide = { scope: ScopeKey; label: string } | { scope: null; label: string };

export interface DiffPlan {
  base: DiffSide;
  target: DiffSide;
  /** Versions published between base and target (ascending); their change lists form the timeline. */
  timelineVersionIds: string[];
  description: string;
}

export function planDiff(req: DiffRequest, headers: VersionHeader[], workspace?: WorkspaceInfo): DiffPlan {
  const versions = headers.filter((h) => !h.deleted).sort((a, b) => Number(a.versionId) - Number(b.versionId));
  const versionSide = (id: string): DiffSide => ({ scope: `version:${id}`, label: versionLabel(versions.find((v) => v.versionId === id) ?? { versionId: id }) });
  const between = (fromExclusive: number, toInclusive: number) =>
    versions.filter((v) => Number(v.versionId) > fromExclusive && Number(v.versionId) <= toInclusive).map((v) => v.versionId);

  if (req.mode === 'workspace') {
    const versionId = req.versionId ?? workspace?.baseVersionId;
    if (!versionId) throw new Error(t('noBaseVersion'));
    return {
      base: versionSide(versionId),
      target: { scope: `workspace:${req.workspaceId}`, label: workspace?.name ? t('workspaceNamedLabel', { id: req.workspaceId, name: workspace.name }) : t('workspaceLabel', { id: req.workspaceId }) },
      timelineVersionIds: [],
      description: t('workspaceDescription', { id: req.workspaceId, versionId }),
    };
  }

  if (req.mode === 'range') {
    let from = Number(req.fromVersionId);
    let to = Number(req.toVersionId);
    if (from === to) throw new Error(t('sameVersions'));
    if (from > to) [from, to] = [to, from];
    return {
      base: versionSide(String(from)),
      target: versionSide(String(to)),
      timelineVersionIds: between(from, to),
      description: t('rangeDescription', { from, to }),
    };
  }

  const since = req.now - req.hours * 3_600_000;
  const inWindow = versions.filter((v) => (v.createdAt ?? 0) >= since);
  const firstInWindow = inWindow[0];
  const lastBefore = [...versions].reverse().find((v) => (v.createdAt ?? 0) < since);
  const base: DiffSide = lastBefore ? versionSide(lastBefore.versionId) : { scope: null, label: t('emptyContainer') };
  const window = t('lastHours', { hours: req.hours });

  if (req.workspaceId) {
    return {
      base,
      target: { scope: `workspace:${req.workspaceId}`, label: t('workspaceLabel', { id: req.workspaceId }) },
      timelineVersionIds: inWindow.map((v) => v.versionId),
      description: t('hoursWithWorkspace', { window, id: req.workspaceId }),
    };
  }
  if (!firstInWindow) throw new Error(t('noPublications', { window }));
  return {
    base,
    target: versionSide(inWindow[inWindow.length - 1].versionId),
    timelineVersionIds: inWindow.map((v) => v.versionId),
    description: t('hoursDescription', { window, count: inWindow.length }),
  };
}

export function versionLabel(v: Pick<VersionHeader, 'versionId' | 'name'>): string {
  return v.name ? t('versionNamed', { id: v.versionId, name: v.name }) : t('version', { id: v.versionId });
}

// --- comparison ------------------------------------------------------------------

export type DiffStatus = 'added' | 'removed' | 'modified';

export interface FieldChange {
  field: string;
  before?: string;
  after?: string;
}

export interface EntityDiff {
  kind: EntityKind;
  id: string;
  name: string;
  type: string;
  status: DiffStatus;
  fields: FieldChange[];
  before?: GtmEntity;
  after?: GtmEntity;
  /** Timeline versions in which this entity was changed. */
  touchedIn: string[];
}

export interface TimelineEntry {
  versionId: string;
  name?: string;
  author?: string;
  createdAt?: number;
  changes: EntityChange[];
}

export interface DiffResult {
  plan: DiffPlan;
  createdAt: number;
  entities: EntityDiff[];
  timeline: TimelineEntry[];
  /** Entities changed in the timeline whose net state is unchanged (e.g. changed and reverted). */
  touchedButUnchanged: EntityChange[];
  warnings: string[];
}

export function emptySnapshot(): Snapshot {
  return { key: 'import:empty', label: t('emptyContainer'), tags: {}, triggers: {}, variables: {}, complete: true, updatedAt: 0 };
}

export function buildDiff(plan: DiffPlan, base: Snapshot, target: Snapshot, timeline: TimelineEntry[]): DiffResult {
  const warnings: string[] = [];
  for (const snap of [base, target]) {
    if (!snap.complete) warnings.push(t('incompleteList', { label: snap.label }));
    const missing = [...Object.values(snap.tags), ...Object.values(snap.variables)].filter((e) => !e.paramsComplete).length;
    if (missing) warnings.push(t('missingParams', { label: snap.label, count: missing }));
  }

  const entities = diffSnapshots(base, target);
  const touched = new Map<string, string[]>();
  for (const entry of timeline) {
    for (const c of entry.changes) {
      const key = `${c.entityType}:${c.id}`;
      touched.set(key, [...(touched.get(key) ?? []), entry.versionId]);
    }
  }
  for (const e of entities) e.touchedIn = touched.get(`${e.kind}:${e.id}`) ?? [];

  const inDiff = new Set(entities.map((e) => `${e.kind}:${e.id}`));
  const seen = new Set<string>();
  const touchedButUnchanged: EntityChange[] = [];
  for (const entry of timeline) {
    for (const c of entry.changes) {
      const key = `${c.entityType}:${c.id}`;
      if (['tag', 'trigger', 'variable'].includes(c.entityType) && !inDiff.has(key) && !seen.has(key)) {
        seen.add(key);
        touchedButUnchanged.push(c);
      }
    }
  }

  return { plan, createdAt: Date.now(), entities, timeline, touchedButUnchanged, warnings };
}

const KIND_ORDER: Record<EntityKind, number> = { tag: 0, trigger: 1, variable: 2 };
const STATUS_ORDER: Record<DiffStatus, number> = { added: 0, modified: 1, removed: 2 };

export function diffSnapshots(base: Snapshot, target: Snapshot): EntityDiff[] {
  const out: EntityDiff[] = [];
  for (const kind of ['tag', 'trigger', 'variable'] as const) {
    const before = bucket(base, kind);
    const after = bucket(target, kind);
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[id];
      const a = after[id];
      if (b && a) {
        if (b.fingerprint && b.fingerprint === a.fingerprint) continue;
        const fields = compareFields(describe(b, base), describe(a, target));
        if (fields.length) out.push({ kind, id, name: a.name, type: a.type, status: 'modified', fields, before: b, after: a, touchedIn: [] });
      } else if (a) {
        out.push({ kind, id, name: a.name, type: a.type, status: 'added', fields: compareFields(new Map(), describe(a, target)), after: a, touchedIn: [] });
      } else if (b) {
        out.push({ kind, id, name: b.name, type: b.type, status: 'removed', fields: [], before: b, touchedIn: [] });
      }
    }
  }
  return out.sort(
    (x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || x.name.localeCompare(y.name, 'pl'),
  );
}

function bucket(snap: Snapshot, kind: EntityKind): Record<string, GtmEntity> {
  return (kind === 'tag' ? snap.tags : kind === 'trigger' ? snap.triggers : snap.variables) as Record<string, GtmEntity>;
}

function compareFields(before: Map<string, string>, after: Map<string, string>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(field);
    const a = after.get(field);
    if (b !== a) out.push({ field, before: b, after: a });
  }
  return out;
}

/** Label of a trigger condition group in the active language. */
function conditionGroup(group: string): string {
  if (group === 'filter') return t('condFilter');
  if (group === 'customEventFilter') return t('condCustomEvent');
  if (group === 'autoEventFilter') return t('condAutoEvent');
  return group;
}

/** Flat, human-readable field map of an entity; trigger ids are resolved to names. */
export function describe(e: GtmEntity, snap: Snapshot): Map<string, string> {
  const m = new Map<string, string>();
  const triggerNames = (ids: string[]) =>
    ids
      .map((id) => snap.triggers[id]?.name ?? `#${id}`)
      .sort((a, b) => a.localeCompare(b, 'pl'))
      .join(', ');

  m.set(t('fieldName'), e.name);
  m.set(t('fieldType'), e.type);
  if (e.notes) m.set(t('fieldNotes'), e.notes);
  if (e.kind === 'tag') {
    m.set(t('fieldPaused'), e.paused ? t('yes') : t('no'));
    if (e.firingTriggerIds.length) m.set(t('fieldFiring'), triggerNames(e.firingTriggerIds));
    if (e.blockingTriggerIds.length) m.set(t('fieldBlocking'), triggerNames(e.blockingTriggerIds));
    if (e.consent) m.set(t('fieldConsent'), [e.consent.status, ...[...e.consent.types].sort()].join(' '));
  }
  if (e.kind === 'trigger') {
    for (const [group, conditions] of Object.entries(e.filters)) {
      if (!conditions.length) continue;
      const lines = conditions.map((c) => `${c.left} ${c.negate ? 'NOT ' : ''}${c.op} ${c.right}`).sort();
      m.set(conditionGroup(group), lines.join('\n'));
    }
  }
  flattenParams(e.parameters, '', m);
  return m;
}

/** Row label for list-of-map tables (e.g. GA4 event parameters), so reordering rows isn't a change. */
const ROW_KEYS = ['name', 'parameter', 'key', 'fieldName', 'tagName'];

function flattenParams(params: GtmParameter[], prefix: string, out: Map<string, string>): void {
  params.forEach((p, index) => {
    const label = p.key ?? rowLabel(p) ?? `[${index}]`;
    const path = prefix ? (p.key ? `${prefix}.${label}` : `${prefix}${label}`) : label;
    if (p.list) flattenParams(p.list, path, out);
    else if (p.map) flattenParams(p.map, path, out);
    else out.set(path, p.value ?? '');
  });
}

function rowLabel(p: GtmParameter): string | undefined {
  if (!p.map) return undefined;
  for (const key of ROW_KEYS) {
    const value = p.map.find((x) => x.key === key)?.value;
    if (value) return `[${value}]`;
  }
  return undefined;
}
