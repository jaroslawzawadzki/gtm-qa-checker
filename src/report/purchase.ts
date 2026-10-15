// Report section: every purchase tag in the container side by side – which variable each one uses for
// value / currency / transaction id / items / event_id and where that variable really reads from –
// plus a per-field verdict (one source everywhere vs. several sources).
import type { DiffResult } from '../diff/diffEngine';
import { defineMessages, getLang, LOCALE } from '../i18n';
import { Resolver, sourceKey, sourceText, type Source } from '../qa/resolver';
import { PURCHASE_EVENT } from '../qa/rules';
import { fieldUses, paramLeaves, tagEvents, type SemanticField } from '../qa/semantics';
import type { GtmTag, Snapshot } from '../shared/types';

const t = defineMessages({
  en: {
    heading: 'Purchase – comparison of transmitted values',
    intro: 'All purchase tags in {scope}. Each cell: variable → where it actually reads from. 🆕 added / ✏️ changed in the compared range, ⏸ paused.',
    tag: 'Tag',
    type: 'Type',
    event: 'Event',
    auto: 'auto',
    inCode: 'values in the code (Custom HTML)',
    verdict: 'Consistency',
    same: '✅ **{field}**: one source in all {count} tags – {source}',
    different: '⚠️ **{field}**: {count} different sources',
    usedBy: '{source} – {tags}',
    missing: '⚠️ **{field}** missing in: {tags}',
    none: 'No purchase tags found.',
  },
  de: {
    heading: 'Kauf – Vergleich der übermittelten Werte',
    intro: 'Alle Kauf-Tags in {scope}. Jede Zelle: Variable → woraus sie tatsächlich liest. 🆕 hinzugefügt / ✏️ geändert im verglichenen Bereich, ⏸ pausiert.',
    tag: 'Tag',
    type: 'Typ',
    event: 'Ereignis',
    auto: 'automatisch',
    inCode: 'Werte im Code (Custom HTML)',
    verdict: 'Konsistenz',
    same: '✅ **{field}**: eine Quelle in allen {count} Tags – {source}',
    different: '⚠️ **{field}**: {count} unterschiedliche Quellen',
    usedBy: '{source} – {tags}',
    missing: '⚠️ **{field}** fehlt in: {tags}',
    none: 'Keine Kauf-Tags gefunden.',
  },
  pl: {
    heading: 'Zakup – porównanie przesyłanych wartości',
    intro: 'Wszystkie tagi zakupu w zakresie {scope}. Komórka: zmienna → skąd faktycznie czyta. 🆕 dodany / ✏️ zmieniony w porównywanym zakresie, ⏸ wstrzymany.',
    tag: 'Tag',
    type: 'Typ',
    event: 'Zdarzenie',
    auto: 'automatycznie',
    inCode: 'wartości w kodzie (Custom HTML)',
    verdict: 'Spójność',
    same: '✅ **{field}**: jedno źródło we wszystkich {count} tagach – {source}',
    different: '⚠️ **{field}**: {count} różne źródła',
    usedBy: '{source} – {tags}',
    missing: '⚠️ **{field}** brak w: {tags}',
    none: 'Nie znaleziono tagów zakupu.',
  },
});

const FIELDS: SemanticField[] = ['value', 'currency', 'transaction_id', 'items', 'event_id'];
/** Fields whose absence is worth flagging (items / event_id are optional for many vendors). */
const REQUIRED: SemanticField[] = ['value', 'currency', 'transaction_id'];
/** GA4 "send ecommerce data" reads these from the dataLayer ecommerce object. */
const GA4_AUTO: Partial<Record<SemanticField, string>> = {
  value: 'ecommerce.value',
  currency: 'ecommerce.currency',
  transaction_id: 'ecommerce.transaction_id',
  items: 'ecommerce.items',
};

interface Cell {
  /** As configured in the tag, e.g. {{DLV - value}} or "EUR". */
  raw: string;
  source: Source;
  auto?: boolean;
}

/** compact: verdicts only (no per-tag table) and shortened tag lists – for the default, short report. */
export function purchaseSection(snap: Snapshot | null, diff: DiffResult | null, templates: Map<string, string>, compact = false): string[] {
  if (!snap) return [];
  const resolver = new Resolver(snap);
  const tags = Object.values(snap.tags)
    .filter((tag) => isPurchaseTag(tag, snap))
    .sort((a, b) => Number(a.paused) - Number(b.paused) || a.name.localeCompare(b.name, LOCALE[getLang()]));
  const out = [`## ${t('heading')}`, ''];
  if (!tags.length) return [...out, t('none'), ''];

  const status = new Map((diff?.entities ?? []).filter((e) => e.kind === 'tag').map((e) => [e.id, e.status]));
  const cells = new Map(tags.map((tag) => [tag.id, cellsOf(tag, resolver)]));

  if (!compact) out.push(
    t('intro', { scope: snap.label }),
    '',
    `| ${t('tag')} | ${t('type')} | ${t('event')} | ${FIELDS.join(' | ')} |`,
    `|${'---|'.repeat(FIELDS.length + 3)}`,
  );
  for (const tag of compact ? [] : tags) {
    const marker = tag.paused ? '⏸ ' : status.get(tag.id) === 'added' ? '🆕 ' : status.get(tag.id) === 'modified' ? '✏️ ' : '';
    const row = cells.get(tag.id)!;
    const values = tag.type === 'html' && !row.size ? [`_${t('inCode')}_`, '', '', '', ''] : FIELDS.map((f) => (row.get(f) ? md(cellText(row.get(f)!)) : '—'));
    out.push(`| ${marker}${md(tag.name)} | ${md(templates.get(tag.type) ?? tag.type)} | ${md(eventOf(tag, snap))} | ${values.join(' | ')} |`);
  }
  if (!compact) out.push('', `**${t('verdict')}**`, '');

  const names = (list: string[]) => (compact && list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3}` : list.join(', '));
  // Verdict over active tags only – paused ones don't send anything.
  const active = tags.filter((tag) => !tag.paused);
  for (const field of FIELDS) {
    const groups = new Map<string, { source: Source; tags: string[] }>();
    for (const tag of active) {
      const c = cells.get(tag.id)!.get(field);
      if (!c) continue;
      const key = sourceKey(c.source);
      const g = groups.get(key) ?? { source: c.source, tags: [] };
      g.tags.push(tag.name);
      groups.set(key, g);
    }
    if (groups.size === 1) {
      const [g] = [...groups.values()];
      out.push(`- ${t('same', { field, count: g.tags.length, source: `\`${short(g.source)}\`` })}`);
    } else if (groups.size > 1) {
      out.push(`- ${t('different', { field, count: groups.size })}`);
      for (const g of groups.values()) out.push(`  - ${t('usedBy', { source: `\`${short(g.source)}\``, tags: names(g.tags) })}`);
    }
    // Only tags that send part of the purchase data: remarketing / user-data / config tags send none by design.
    const sendsValues = (tag: GtmTag) => REQUIRED.some((f) => cells.get(tag.id)!.has(f));
    const missing = REQUIRED.includes(field)
      ? active.filter((tag) => sendsValues(tag) && !cells.get(tag.id)!.get(field) && !(field === 'transaction_id' && tag.type === 'baut'))
      : [];
    if (missing.length && groups.size) out.push(`  - ${t('missing', { field, tags: names(missing.map((x) => x.name)) })}`);
  }
  out.push('');
  return out;
}

function isPurchaseTag(tag: GtmTag, snap: Snapshot): boolean {
  // A literal event name in the tag (GA4, Data Tag) is authoritative.
  const eventName = literalEventName(tag);
  if (eventName) return PURCHASE_EVENT.test(eventName);
  // Otherwise: the trigger's event, its positive conditions or its name. Negated conditions
  // ("pagetype NOT contains purchase") mean the opposite, so they are ignored.
  return tag.firingTriggerIds.some((id) => {
    const trigger = snap.triggers[id];
    if (!trigger) return false;
    const positive = [...trigger.filters.customEventFilter, ...trigger.filters.filter].filter((c) => !c.negate).map((c) => c.right);
    // The trigger name only counts when there is no event condition ("All events w/o purchase" is not a purchase).
    const named = trigger.filters.customEventFilter.length === 0 ? [trigger.name] : [];
    return [...positive, ...named].some((text) => PURCHASE_EVENT.test(text));
  });
}

function literalEventName(tag: GtmTag): string | undefined {
  const name = paramLeaves(tag.parameters).find((l) => ['eventName', 'event_name_standard', 'event_name_custom'].includes(l.name))?.value;
  return name && !name.includes('{{') ? name : undefined;
}

function cellsOf(tag: GtmTag, resolver: Resolver): Map<SemanticField, Cell> {
  const cells = new Map<SemanticField, Cell>();
  for (const use of fieldUses(tag, resolver)) {
    if (FIELDS.includes(use.field) && !cells.has(use.field)) cells.set(use.field, { raw: use.raw, source: use.resolved.source });
  }
  const ecommerceObject = tag.type === 'gaawe' && paramLeaves(tag.parameters).some((l) => l.name === 'sendEcommerceData' && l.value === 'true');
  if (ecommerceObject) {
    for (const [field, path] of Object.entries(GA4_AUTO) as [SemanticField, string][]) {
      if (!cells.has(field)) cells.set(field, { raw: '', source: { kind: 'dataLayer', path }, auto: true });
    }
  }
  return cells;
}

const MAX_EVENT = 70;

function eventOf(tag: GtmTag, snap: Snapshot): string {
  const event = literalEventName(tag) ?? tagEvents(tag, snap).find((e) => PURCHASE_EVENT.test(e)) ?? tagEvents(tag, snap)[0] ?? '—';
  return event.length > MAX_EVENT ? `${event.slice(0, MAX_EVENT)}…` : event;
}

function short(s: Source): string {
  if (s.kind === 'dataLayer') return `dL: ${s.path}`;
  if (s.kind === 'constant' || s.kind === 'text') return `"${s.value}"`;
  return sourceText(s);
}

function cellText(c: Cell): string {
  if (c.auto) return `${short(c.source)} (${t('auto')})`;
  // Literal values need no arrow; variables show name → source.
  return c.raw.startsWith('{{') && c.raw.endsWith('}}') ? `${c.raw} → ${short(c.source)}` : short(c.source);
}

function md(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
