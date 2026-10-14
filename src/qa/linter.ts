// Runs all QA rules on a snapshot. Optionally keeps only findings that involve given entities
// (e.g. what changed in the last diff).
import type { Settings } from '../shared/storage';
import type { EntityKind, ScopeKey, Snapshot } from '../shared/types';
import { getLang, LOCALE } from '../i18n';
import { t } from './i18n';
import { Resolver } from './resolver';
import { ALL_RULES, buildReferenceIndex, type Finding, type LintContext, type Severity } from './rules';
import { fieldUses, tagEvents } from './semantics';
import { analyzeSst, type SstInventory } from './sst';
import type { HiddenFinding } from './suppress';

export interface LintOptions {
  /** "kind:id" keys; when set, only findings touching one of these entities are kept. */
  onlyEntities?: Set<string>;
  /** cvt_… type -> custom template name. */
  templates?: Map<string, string>;
}

export interface LintResult {
  scope: ScopeKey;
  scopeLabel: string;
  createdAt: number;
  /** Visible findings (after agency exceptions). */
  findings: Finding[];
  /** Every finding before exceptions – lets exceptions be re-applied without re-running QA. */
  allFindings: Finding[];
  /** Findings hidden by agency exceptions. */
  hidden: HiddenFinding[];
  counts: Record<Severity, number>;
  checked: Record<EntityKind, number>;
  /** Server-side routing (null when nothing is sent to a server container). */
  sst: SstInventory | null;
  /** Set when results were limited to changed entities. */
  limitedTo?: number;
  warnings: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Rules that list many independent entities in one finding (one detail line per entity). */
export const AGGREGATE_RULES = new Set([
  'tag-paused', 'tag-no-trigger', 'tag-missing-trigger', 'unused-triggers', 'unused-variables',
  'naming-convention', 'naming-taxonomy',
  // Not 'consent-inconsistent': its value is the comparison with the other variants.
]);

/** Keeps only the in-scope entities of an aggregate finding (and their detail lines). */
export function narrow(f: Finding, only: Set<string>): Finding {
  const entities = f.entities.filter((e) => only.has(`${e.kind}:${e.id}`));
  const names = entities.map((e) => e.name);
  const details = f.details.filter((d) => names.some((n) => d === n || d.startsWith(`${n} `) || d.startsWith(`${n}:`)));
  return { ...f, entities, details, title: f.title.replace(/\((\d+)(\/\d+)?\)/, `(${entities.length})`) };
}

export function countSeverities(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function runLint(snap: Snapshot, settings: Settings, opts: LintOptions = {}): LintResult {
  const tags = Object.values(snap.tags);
  const triggers = Object.values(snap.triggers);
  const variables = Object.values(snap.variables);
  const resolver = new Resolver(snap);
  const ctx: LintContext = {
    snap,
    settings,
    resolver,
    tags,
    active: tags.filter((t) => !t.paused),
    triggers,
    variables,
    uses: tags.flatMap((t) => fieldUses(t, resolver)),
    events: new Map(tags.map((t) => [t.id, tagEvents(t, snap)])),
    references: buildReferenceIndex(tags, triggers, variables),
    templates: opts.templates ?? new Map(),
    sstRouted: new Set(),
  };

  const sst = analyzeSst(ctx);
  for (const r of sst.inventory?.routes ?? []) ctx.sstRouted.add(r.tag.id);
  let findings = [...ALL_RULES.flatMap((rule) => rule(ctx)), ...sst.findings];
  if (opts.onlyEntities) {
    const only = opts.onlyEntities;
    findings = findings
      .filter((f) => f.entities.some((e) => only.has(`${e.kind}:${e.id}`)))
      .map((f) => (AGGREGATE_RULES.has(f.rule) ? narrow(f, only) : f));
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title, LOCALE[getLang()]));

  const warnings: string[] = [];
  if (!snap.complete) warnings.push(t('warnIncomplete'));
  const missing = [...tags, ...variables].filter((e) => !e.paramsComplete).length;
  if (missing) warnings.push(t('warnNoParams', { count: missing }));

  return {
    scope: snap.key,
    scopeLabel: snap.label,
    createdAt: Date.now(),
    findings,
    allFindings: findings,
    hidden: [],
    counts: countSeverities(findings),
    checked: { tag: tags.length, trigger: triggers.length, variable: variables.length },
    sst: sst.inventory,
    limitedTo: opts.onlyEntities?.size,
    warnings,
  };
}
