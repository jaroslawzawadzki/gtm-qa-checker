// Markers in GTM's own UI after a QA run:
//  - list rows (Tags / Triggers / Variables): filled dots = the element's own findings
//    (red critical, amber warnings, blue info, with counts);
//  - tag rows additionally: a hollow ring when the tag USES variables/triggers that have findings
//    (number = how many such elements) – shown separately so nothing is counted twice;
//  - left menu (Tags / Triggers / Variables): how many elements have problems, by their worst severity.
//
// Tag rows link to /tags/<id>, so tags are matched by id. Trigger/variable rows carry no id (GTM's
// AngularJS app runs without debug info) – they are matched by name, unique per type in a container.
import type { LintResult } from '../qa/linter';
import { Resolver } from '../qa/resolver';
import type { Severity } from '../qa/rules';
import { paramLeaves } from '../qa/semantics';
import { NAMING_RULES, OVERVIEW_RULES } from '../shared/previewQa';
import { loadSettings } from '../shared/storage';
import type { EntityKind, GtmTag, Snapshot } from '../shared/types';

export interface MarkerTexts {
  /** Row tooltip header, e.g. "2 critical · 1 warning · 0 info – click for details". */
  summary(critical: number, warning: number, info: number): string;
  /** Menu tooltip, e.g. "Elements with findings: 2 critical · 5 warnings · 10 info". */
  navSummary(critical: number, warning: number, info: number): string;
  /** Ring tooltip: "Uses elements with findings: A, B". */
  uses(names: string): string;
  /** "Rename to: X" line under a naming finding. */
  rename(name: string): string;
}

type Counts = Record<Severity, number> & { titles: string[] };
interface Uses {
  worst: Severity;
  names: string[];
  /** "kind:name" of the used elements, for the QA filter. */
  keys: string[];
}

const ROUTE_KIND: Record<string, EntityKind> = { tags: 'tag', triggers: 'trigger', variables: 'variable' };
const BADGE_ATTR = 'data-gtmqa-badge';
const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
const COLORS: Record<Severity, string> = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
const ICONS: Record<Severity, string> = { critical: '🔴', warning: '🟡', info: '🔵' };
const ROW_SELECTOR = 'tr[gtm-table-row], tr.wd-tag-row';
const LINK_SELECTOR = 'a.fill-cell, a.open-tag-button, a[class*="wd-open-"]';

/** Entity name from the link's own text, ignoring our marker inside it. */
function nameOf(link: HTMLElement): string {
  return [...link.childNodes]
    .filter((n) => !(n instanceof HTMLElement && n.hasAttribute(BADGE_ATTR)))
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();
}

const worstOf = (c: Record<Severity, number>) => SEVERITIES.find((s) => c[s] > 0);

export class GtmOverlay {
  private lint: LintResult | null = null;
  private snapshot: Snapshot | null = null;
  /** Own findings, keyed "kind:name" and "kind#id". */
  private marks = new Map<string, Counts>();
  /** Tag id -> variables/triggers it uses that have findings. */
  private uses = new Map<string, Uses>();
  /** Per entity type: number of elements whose worst finding is critical / warning / info. */
  private perKind = new Map<EntityKind, Record<Severity, number>>();
  private scheduled = false;
  private readonly observer = new MutationObserver(() => this.schedule());

  constructor(
    private readonly texts: MarkerTexts,
    private readonly onOpen: (kind: EntityKind, name: string, related: string[]) => void,
  ) {
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', () => this.schedule());
  }

  /** New QA result for the open container (null = clear all markers) and the snapshot it was run on. */
  update(lint: LintResult | null, snapshot: Snapshot | null): void {
    this.lint = lint;
    this.snapshot = snapshot;
    void loadSettings().then((s) => this.build(!s.markersHideNaming));
  }

  /** Re-applies settings (e.g. naming findings on/off) to the current result. */
  refresh(): void {
    this.update(this.lint, this.snapshot);
  }

  private build(includeNaming: boolean): void {
    this.marks = new Map();
    this.uses = new Map();
    this.perKind = new Map();
    const byName = new Map<string, Counts>();
    for (const f of this.lint?.findings ?? []) {
      // Naming findings usually cover most of the container: always shown as blue (info) so they stay
      // visible without drowning real warnings; can be hidden completely in Settings.
      const naming = NAMING_RULES.has(f.rule);
      if (naming && !includeNaming) continue;
      const severity: Severity = naming ? 'info' : f.severity;
      if (OVERVIEW_RULES.has(f.rule)) continue;
      for (const e of f.entities) {
        const c = byName.get(`${e.kind}:${e.name}`) ?? { critical: 0, warning: 0, info: 0, titles: [] };
        c[severity]++;
        c.titles.push(`${ICONS[severity]} ${f.title}`);
        const fix = f.fixes?.find((x) => x.entity.kind === e.kind && x.entity.id === e.id);
        if (fix) c.titles.push(`    ${this.texts.rename(fix.suggestion)}`);
        byName.set(`${e.kind}:${e.name}`, c);
        this.marks.set(`${e.kind}:${e.name}`, c);
        this.marks.set(`${e.kind}#${e.id}`, c);
      }
    }
    for (const [key, c] of byName) {
      const kind = key.slice(0, key.indexOf(':')) as EntityKind;
      const k = this.perKind.get(kind) ?? { critical: 0, warning: 0, info: 0 };
      k[worstOf(c)!]++;
      this.perKind.set(kind, k);
    }
    if (this.snapshot) for (const tag of Object.values(this.snapshot.tags)) this.collectUses(tag, this.snapshot);
    this.schedule();
  }

  /** Variables (followed through nested references) and triggers a tag depends on that have findings. */
  private collectUses(tag: GtmTag, snap: Snapshot): void {
    const resolverVars = new Map(Object.values(snap.variables).map((v) => [v.name, v]));
    const seen = new Set<string>();
    const queue = paramLeaves(tag.parameters).flatMap((l) => Resolver.references(l.value));
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const v = resolverVars.get(name);
      if (v) queue.push(...paramLeaves(v.parameters).flatMap((l) => Resolver.references(l.value)));
    }
    const used = [
      ...[...seen].map((name) => ({ key: `variable:${name}`, name, counts: this.marks.get(`variable:${name}`) })),
      ...[...tag.firingTriggerIds, ...tag.blockingTriggerIds].map((id) => {
        const name = snap.triggers[id]?.name ?? `#${id}`;
        return { key: `trigger:${name}`, name, counts: this.marks.get(`trigger#${id}`) };
      }),
    ].filter((u): u is { key: string; name: string; counts: Counts } => !!u.counts);
    if (!used.length) return;
    const worst = SEVERITIES.find((s) => used.some((u) => u.counts[s] > 0))!;
    this.uses.set(tag.id, { worst, names: [...new Set(used.map((u) => u.name))], keys: [...new Set(used.map((u) => u.key))] });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // GTM re-renders rows while scrolling/paging; batch the work.
    setTimeout(() => {
      this.scheduled = false;
      this.scanRows();
      this.scanMenu();
    }, 150);
  }

  private scanRows(): void {
    const route = location.hash.match(/\/workspaces\/\d+\/(tags|triggers|variables)\b/);
    const kind = route ? ROUTE_KIND[route[1]] : undefined;
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      // The name link fills the whole cell (display:block), so the marker goes inside it, after the name.
      const link = row.querySelector<HTMLElement>(LINK_SELECTOR);
      if (!link) continue;
      const name = nameOf(link);
      const id = link.getAttribute('href')?.match(/\/(?:tags|triggers|variables)\/(\d+)/)?.[1];
      const own = kind ? (id && this.marks.get(`${kind}#${id}`)) || this.marks.get(`${kind}:${name}`) : undefined;
      const uses = kind === 'tag' && id ? this.uses.get(id) : undefined;
      const marker = kind ? this.rowMarker(own, uses) : null;
      this.place(link, marker, (box) => this.clickable(box, kind!, name, uses?.keys ?? []));
    }
  }

  private scanMenu(): void {
    for (const link of document.querySelectorAll<HTMLElement>('a.gtm-container-menu-list-item[href]')) {
      const route = link.getAttribute('href')?.match(/\/workspaces\/\d+\/(tags|triggers|variables)\/?$/);
      if (!route) continue;
      const k = this.perKind.get(ROUTE_KIND[route[1]]);
      const marker = k && worstOf(k) ? this.box(`${k.critical}/${k.warning}/${k.info}`, this.texts.navSummary(k.critical, k.warning, k.info)) : null;
      if (marker && k) for (const sev of SEVERITIES) if (k[sev]) marker.append(this.dot(sev, k[sev], true));
      this.place(link, marker);
    }
  }

  private rowMarker(own: Counts | undefined, uses: Uses | undefined): HTMLElement | null {
    if (!own && !uses) return null;
    const signature = `${own ? `${own.critical}/${own.warning}/${own.info}` : '-'}|${uses ? `${uses.worst}:${uses.names.length}` : '-'}`;
    const lines = [
      own ? this.texts.summary(own.critical, own.warning, own.info) : '',
      ...(own?.titles ?? []),
      uses ? this.texts.uses(uses.names.join(', ')) : '',
    ].filter(Boolean);
    const box = this.box(signature, lines.join('\n'));
    for (const sev of SEVERITIES) if (own?.[sev]) box.append(this.dot(sev, own[sev], true));
    if (uses) box.append(this.dot(uses.worst, uses.names.length, false));
    return box;
  }

  private box(signature: string, title: string): HTMLElement {
    const box = document.createElement('span');
    box.setAttribute(BADGE_ATTR, signature);
    box.title = title;
    box.style.cssText = 'display:inline-flex;gap:4px;margin-left:8px;vertical-align:middle;';
    return box;
  }

  /** Filled = own findings; hollow ring = findings in elements the tag uses. */
  private dot(sev: Severity, n: number, filled: boolean): HTMLElement {
    const dot = document.createElement('span');
    dot.textContent = String(n);
    dot.style.cssText =
      `display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;` +
      `border-radius:9px;font:600 11px/1 Roboto,Arial,sans-serif;` +
      (filled
        ? `background:${COLORS[sev]};color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);`
        : `background:#fff;color:${COLORS[sev]};border:2px solid ${COLORS[sev]};`);
    return dot;
  }

  /** Replaces the marker inside `host` only when its content changed (avoids observer loops). */
  private place(host: HTMLElement, marker: HTMLElement | null, decorate?: (box: HTMLElement) => void): void {
    const existing = host.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
    if (!marker) return void existing?.remove();
    if (existing?.getAttribute(BADGE_ATTR) === marker.getAttribute(BADGE_ATTR)) return;
    existing?.remove();
    decorate?.(marker);
    host.append(marker);
  }

  /** Row markers open our findings instead of GTM's edit sheet. */
  private clickable(box: HTMLElement, kind: EntityKind, name: string, related: string[]): void {
    box.style.cursor = 'pointer';
    box.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onOpen(kind, name, related);
    });
  }
}
