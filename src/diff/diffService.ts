// Loads whatever a diff needs (both sides with full parameters, change lists of timeline versions)
// and runs the pure diff engine. computeDiff() re-runs it from memory (e.g. after a language switch).
import type { GtmLoader, Progress } from '../content/loader';
import type { GtmStore } from '../content/store';
import { defineMessages } from '../i18n';
import { buildDiff, emptySnapshot, planDiff, type DiffRequest, type DiffResult, type DiffSide, type TimelineEntry } from './diffEngine';

const t = defineMessages({
  en: { versionList: 'Version list', baseSide: 'Base side', targetSide: 'Target side', history: 'Publishing history' },
  de: { versionList: 'Versionsliste', baseSide: 'Ausgangsseite', targetSide: 'Zielseite', history: 'Veröffentlichungsverlauf' },
  pl: { versionList: 'Lista wersji', baseSide: 'Strona bazowa', targetSide: 'Strona docelowa', history: 'Historia publikacji' },
});

export async function runDiff(
  req: DiffRequest,
  store: GtmStore,
  loader: GtmLoader,
  onProgress: (p: Progress) => void,
): Promise<DiffResult> {
  if (store.versionHeaders.size === 0) {
    onProgress({ label: t('versionList'), done: 0, total: 0 });
    await loader.loadVersionList();
  }
  const workspaceId = workspaceOf(req);
  if (workspaceId && !store.workspaces.get(workspaceId)?.baseVersionId) {
    await loader.loadWorkspaceInfo(workspaceId);
  }

  const plan = planDiff(req, [...store.versionHeaders.values()], workspaceId ? store.workspaces.get(workspaceId) : undefined);
  await ensureSide(plan.base, t('baseSide'));
  await ensureSide(plan.target, t('targetSide'));

  // Timeline: change lists are part of the full version payload (no entity details needed).
  for (const [i, versionId] of plan.timelineVersionIds.entries()) {
    if (!store.versionHeaders.get(versionId)?.changes) {
      onProgress({ label: t('history'), done: i, total: plan.timelineVersionIds.length });
      await loader.loadVersionSummary(versionId);
    }
  }
  return computeDiff(req, store);

  async function ensureSide(side: DiffSide, label: string): Promise<void> {
    if (!side.scope) return;
    const [kind, id] = side.scope.split(':', 2) as [string, string];
    if (kind === 'workspace') {
      // Workspaces change while the user works: always refresh (unchanged details come from cache).
      await loader.loadWorkspace(id, prefixed(label, onProgress));
      return;
    }
    // Published versions are immutable: load only once.
    const snap = store.snapshots.get(side.scope);
    if (snap?.complete && store.incompleteEntities(side.scope).length === 0) return;
    if (kind === 'version') await loader.loadVersion(id, prefixed(label, onProgress));
  }
}

/** Builds the diff from data already in the store (no network). */
export function computeDiff(req: DiffRequest, store: GtmStore): DiffResult {
  const workspaceId = workspaceOf(req);
  const plan = planDiff(req, [...store.versionHeaders.values()], workspaceId ? store.workspaces.get(workspaceId) : undefined);
  const timeline: TimelineEntry[] = plan.timelineVersionIds.map((versionId) => {
    const h = store.versionHeaders.get(versionId);
    return { versionId, name: h?.name, author: h?.author, createdAt: h?.createdAt, changes: h?.changes ?? [] };
  });
  const snapshot = (side: DiffSide) => (side.scope ? store.snapshots.get(side.scope) : undefined) ?? emptySnapshot();
  return buildDiff(plan, snapshot(plan.base), snapshot(plan.target), timeline);
}

function workspaceOf(req: DiffRequest): string | undefined {
  return req.mode === 'workspace' || req.mode === 'hours' ? req.workspaceId : undefined;
}

function prefixed(prefix: string, onProgress: (p: Progress) => void) {
  return (p: Progress) => onProgress({ ...p, label: `${prefix}: ${p.label}` });
}
