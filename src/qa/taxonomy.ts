// Agency naming taxonomy (Task 12 – GTM Naming Convention & Data Bridge Architecture):
//   Tags:      [SST] Platform/Tool - Event Name      e.g. [SST] GA4 - purchase, [SST] Data Tag - Config
//   Triggers:  ce - <event> | pv - <name> | window_loaded - <name>
//   Variables: DLV - <dataLayer path> | CJS - … | COOKIE - … | CONST - … | URL - …
// Every violation comes with a suggested name derived from the entity's configuration.
import type { EntityKind, GtmEntity, GtmTag, GtmTrigger, GtmVariable } from '../shared/types';
import { t } from './i18n';
import { param, Resolver } from './resolver';
import { kindLabel, typeName, type Finding, type LintContext, type Rule } from './rules';
import { triggerEvents } from './semantics';

const TAG_FORMAT = /^\[SST\] (.+?) - (.+)$/;
const BUILT_IN_TRIGGER_MIN_ID = 2147479553;
/** Event labels produced by semantics.triggerEvents for unconditional page-load triggers. */
const PAGE_EVENTS = new Set(['All Pages', 'pageview', 'domReady', 'windowLoaded', 'init']);

const TRIGGER_PREFIX: Record<string, string> = { customEvent: 'ce', pageview: 'pv', windowLoaded: 'window_loaded' };
const VARIABLE_PREFIX: Record<string, string> = { v: 'DLV', jsm: 'CJS', k: 'COOKIE', c: 'CONST', u: 'URL' };

interface Violation {
  entity: GtmEntity;
  suggestion?: string;
  reason: string;
}

export const namingTaxonomy: Rule = (ctx) => {
  if (!ctx.settings.namingTaxonomy) return [];
  // Strict for SST projects; elsewhere only informative.
  const sstProject = ctx.sstRouted.size > 0 || ctx.tags.some((x) => x.name.startsWith('[SST]'));
  const severity = sstProject ? 'warning' : 'info';

  const tagViolations = ctx.tags.map((x) => checkTag(x, ctx)).filter((v): v is Violation => v !== null);
  const triggers = ctx.triggers.filter((x) => Number(x.id) < BUILT_IN_TRIGGER_MIN_ID);
  const triggerViolations = triggers.map(checkTrigger).filter((v): v is Violation => v !== null);
  const variableViolations = ctx.variables.map(checkVariable).filter((v): v is Violation => v !== null);

  const finding = (kind: EntityKind, format: string, list: Violation[], total: number): Finding | null =>
    list.length
      ? {
          rule: 'naming-taxonomy',
          key: `naming-taxonomy|${kind}`,
          severity,
          title: t('taxTitle', { kind: kindLabel(kind), count: list.length, total }),
          message: `${t('taxMessage', { format })}${sstProject ? '' : t('taxNotSst')}`,
          entities: list.map((v) => ({ kind: v.entity.kind, id: v.entity.id, name: v.entity.name })),
          details: list.map((v) => `${v.entity.name}  →  ${v.suggestion ?? '?'}  (${v.reason})`),
        }
      : null;

  return [
    finding('tag', t('taxFormatTags'), tagViolations, ctx.tags.length),
    finding('trigger', t('taxFormatTriggers'), triggerViolations, triggers.length),
    finding('variable', t('taxFormatVariables'), variableViolations, ctx.variables.length),
  ].filter((f): f is Finding => f !== null);
};

// --- tags ------------------------------------------------------------------------------

function checkTag(tag: GtmTag, ctx: LintContext): Violation | null {
  const platform = tagPlatform(tag, ctx);
  const event = tagEventPart(tag, ctx);
  const routed = ctx.sstRouted.has(tag.id);
  const sstName = tag.name.match(TAG_FORMAT);
  // [SST] is reserved for tags that really send to the server container (GA4 bridge / Data Tag).
  if (!routed) {
    if (!sstName) return null; // web-only tags are outside the SST taxonomy
    if (tag.paused) return null;
    return { entity: tag, suggestion: `${sstName[1]} - ${sstName[2]}`, reason: t('taxSstNotRouted') };
  }
  const m = sstName;
  const suggestion = `[SST] ${platform ?? m?.[1] ?? t('taxPlatform')} - ${event ?? m?.[2] ?? stripPrefix(tag.name)}`;
  if (!m) return { entity: tag, suggestion, reason: t('taxSstRequired') };
  if (platform && m[1] !== platform && !m[1].startsWith(`${platform} `)) {
    return { entity: tag, suggestion, reason: t('taxPlatformMismatch', { name: m[1], platform }) };
  }
  if (tag.type === 'gaawe' && event && m[2] !== event) {
    return { entity: tag, suggestion, reason: t('taxEventMismatch', { event }) };
  }
  return null;
}

function tagPlatform(t: GtmTag, ctx: LintContext): string | null {
  if (typeName(ctx, t.type) === 'Data Tag' || /data tag/i.test(t.name)) return 'Data Tag';
  if (t.type === 'gaawe') return 'GA4';
  if (t.type === 'googtag') {
    const tagId = param(t.parameters, 'tagId') ?? '';
    return tagId.startsWith('AW-') ? 'Google Ads' : 'GA4';
  }
  if (['awct', 'sp', 'awud', 'gclidw'].includes(t.type)) return 'Google Ads';
  if (t.type === 'baut') return 'Microsoft Ads';
  return null;
}

function tagEventPart(t: GtmTag, ctx: LintContext): string | null {
  if (t.type === 'googtag' || /config/i.test(t.name)) return t.type === 'googtag' ? 'Config' : null;
  if (t.type === 'gaawe') {
    const eventName = param(t.parameters, 'eventName');
    if (eventName && !Resolver.references(eventName).length) return eventName;
  }
  if (t.type === 'gclidw') return 'Conversion Linker';
  if (t.type === 'sp') return 'Remarketing';
  // First plain dataLayer event the tag fires on; page-load triggers count as page_view.
  const events = ctx.events.get(t.id) ?? [];
  const event = events.find((e) => /^[\w.\-]+$/.test(e) && !PAGE_EVENTS.has(e)) ?? (events.some((e) => PAGE_EVENTS.has(e)) ? 'page_view' : undefined);
  if (event) return t.type === 'awct' ? `Conversion - ${event}` : event;
  return null;
}

function stripPrefix(name: string): string {
  return name.replace(/^(\[[^\]]*\]|#)\s*/, '').trim();
}

// --- triggers ----------------------------------------------------------------------------

function checkTrigger(tr: GtmTrigger): Violation | null {
  const prefix = TRIGGER_PREFIX[tr.type];
  if (!prefix) return null; // taxonomy defines only ce / pv / window_loaded
  const plainEvents = tr.type === 'customEvent' ? triggerEvents(tr).map((e) => e.replace(/ \[.*\]$/, '')).filter((e) => /^[\w.\-]+$/.test(e)) : [];
  const event = plainEvents.length === 1 ? plainEvents[0] : undefined;
  const rest = stripPrefix(tr.name).replace(/^(ce|pv|window_loaded)\s*-\s*/i, '');
  const suggestion =
    tr.type === 'customEvent' ? `ce - ${event ?? rest}` : tr.type === 'pageview' && tr.filters.filter.length === 0 ? 'pv - All Pages' : `${prefix} - ${rest}`;

  if (!tr.name.startsWith(`${prefix} - `)) return { entity: tr, suggestion, reason: t('taxNoPrefix', { prefix }) };
  if (event && !tr.name.startsWith(`ce - ${event}`)) return { entity: tr, suggestion, reason: t('taxTriggerEvent', { event }) };
  return null;
}

// --- variables ---------------------------------------------------------------------------

function checkVariable(v: GtmVariable): Violation | null {
  const prefix = VARIABLE_PREFIX[v.type];
  if (!prefix) return null; // lookup tables, auto-event variables etc. are not covered by the taxonomy
  const rest = stripPrefix(v.name).replace(/^(DLV|CJS|COOKIE|CONST|URL|dlv|cjs|js|c|const)\s*[-|:]\s*/i, '');
  let suggestion = `${prefix} - ${rest}`;
  if (v.type === 'v') {
    const path = param(v.parameters, 'name');
    if (path) suggestion = `DLV - ${path}`;
    if (path && v.name.startsWith('DLV - ') && v.name !== suggestion) {
      return { entity: v, suggestion, reason: t('taxVariablePath', { path }) };
    }
  }
  if (v.type === 'k') {
    const cookie = param(v.parameters, 'name');
    if (cookie) suggestion = `COOKIE - ${cookie}`;
  }
  if (v.type === 'u') {
    const component = param(v.parameters, 'component');
    const queryKey = param(v.parameters, 'queryKey');
    if (component === 'QUERY' && queryKey) suggestion = `URL - Query Parameter - ${queryKey}`;
  }
  if (!v.name.startsWith(`${prefix} - `)) return { entity: v, suggestion, reason: t('taxNoPrefix', { prefix }) };
  return null;
}
