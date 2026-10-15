// QA results shared between the GTM tab and the Tag Assistant (Preview) tab.
// After every QA run in GTM a compact per-element summary is stored under the container's public id
// (GTM-XXXX); the Preview script reads it to colour tag tiles. Only names, counts and finding titles –
// no parameter values.
import type { LintResult } from '../qa/linter';
import type { Severity } from '../qa/rules';

export interface MarkCounts extends Record<Severity, number> {
  titles: string[];
}

export interface PreviewQa {
  publicId: string;
  createdAt: number;
  scopeLabel: string;
  /** QA ran only on changed elements – other tags simply have no entry. */
  limited: boolean;
  counts: Record<Severity, number>;
  tags: Record<string, MarkCounts>;
}

export const NAMING_RULES = new Set(['naming-taxonomy', 'naming-convention']);
/** Overviews that list (almost) every tag by design – not a problem to point at. */
export const OVERVIEW_RULES = new Set(['consent-overview']);
/** Not useful while previewing: paused tags are intentional and never fire. */
const PREVIEW_SKIP = new Set(['tag-paused']);
const ICONS: Record<Severity, string> = { critical: '🔴', warning: '🟡', info: '🔵' };
const KEY_PREFIX = 'previewQa:';
const MAX_CONTAINERS = 30;

/** Same filtering as the markers in GTM: naming findings count as info (or are hidden), overviews are skipped. */
export function toPreviewQa(publicId: string, lint: LintResult, hideNaming: boolean): PreviewQa {
  const tags: Record<string, MarkCounts> = {};
  for (const f of lint.findings) {
    const naming = NAMING_RULES.has(f.rule);
    if ((naming && hideNaming) || OVERVIEW_RULES.has(f.rule) || PREVIEW_SKIP.has(f.rule)) continue;
    const severity: Severity = naming ? 'info' : f.severity;
    for (const e of f.entities) {
      if (e.kind !== 'tag') continue;
      const c = (tags[e.name] ??= { critical: 0, warning: 0, info: 0, titles: [] });
      c[severity]++;
      const fix = f.fixes?.find((x) => x.entity.kind === 'tag' && x.entity.id === e.id);
      c.titles.push(`${ICONS[severity]} ${f.title}${fix ? ` → ${fix.suggestion}` : ''}`);
    }
  }
  return { publicId, createdAt: lint.createdAt, scopeLabel: lint.scopeLabel, limited: lint.limitedTo !== undefined, counts: lint.counts, tags };
}

export async function savePreviewQa(qa: PreviewQa): Promise<void> {
  await chrome.storage.local.set({ [KEY_PREFIX + qa.publicId]: qa });
  // Keep only the most recent containers.
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(KEY_PREFIX))
    .sort(([, a], [, b]) => (b as PreviewQa).createdAt - (a as PreviewQa).createdAt);
  const stale = entries.slice(MAX_CONTAINERS).map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}

export async function loadPreviewQa(publicId: string): Promise<PreviewQa | null> {
  const key = KEY_PREFIX + publicId;
  return ((await chrome.storage.local.get(key))[key] as PreviewQa | undefined) ?? null;
}

export function previewQaKey(publicId: string): string {
  return KEY_PREFIX + publicId;
}
