// Makes sure the scope is fully loaded, then runs the linter. computeLint() re-runs it from memory
// (e.g. after a language switch or a change of exceptions).
import type { GtmLoader, Progress } from '../content/loader';
import type { GtmStore } from '../content/store';
import type { DiffResult } from '../diff/diffEngine';
import { defineMessages } from '../i18n';
import { loadExceptions } from '../shared/exceptions';
import { loadSettings } from '../shared/storage';
import type { ScopeKey } from '../shared/types';
import { runLint, type LintResult } from './linter';
import { applySuppressions } from './suppress';

const t = defineMessages({
  en: { noData: 'No data for the selected scope.' },
  de: { noData: 'Keine Daten für den gewählten Bereich.' },
  pl: { noData: 'Brak danych dla wybranego zakresu.' },
});

export interface LintRequest {
  scope: ScopeKey;
  /** Keep only findings touching entities added/modified in this diff. */
  onlyChangedIn?: DiffResult;
}

export async function runQa(req: LintRequest, store: GtmStore, loader: GtmLoader, onProgress: (p: Progress) => void): Promise<LintResult> {
  const [kind, id] = req.scope.split(':', 2) as [string, string];
  if (kind === 'workspace') await loader.loadWorkspace(id, onProgress);
  else if (kind === 'version') {
    const snap = store.snapshots.get(req.scope);
    if (!snap?.complete || store.incompleteEntities(req.scope).length) await loader.loadVersion(id, onProgress);
  }
  return computeLint(req, store);
}

/** Lints data already in the store (no network) and applies agency exceptions. */
export async function computeLint(req: LintRequest, store: GtmStore): Promise<LintResult> {
  const snap = store.snapshots.get(req.scope);
  if (!snap) throw new Error(t('noData'));
  const [settings, exceptions] = await Promise.all([loadSettings(), loadExceptions()]);
  const onlyEntities = req.onlyChangedIn
    ? new Set(req.onlyChangedIn.entities.filter((e) => e.status !== 'removed').map((e) => `${e.kind}:${e.id}`))
    : undefined;
  const result = runLint(snap, settings, { onlyEntities, templates: store.templates });
  return applySuppressions(result, exceptions.suppressions, store.context.containerId);
}
