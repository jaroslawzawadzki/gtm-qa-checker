// Server-side tagging: finds every tag that sends data to a server container (by server_container_url /
// transport_url / Stape gtm_server_domain), classifies the bridge (GA4 / Data Tag / other) and checks it.
//
// Verified shapes (real containers):
//   GA4 bridge – googtag: configSettingsTable[server_container_url | transport_url]; GA4 event tags (gaawe)
//                inherit the route from the googtag with the same measurement id.
//   Data Tag   – Stape "Data Tag" template: gtm_server_domain + request_path (/data), event_type +
//                event_name_standard | event_name_custom, custom_data[{name,value}], user_data[{name,value}],
//                data_tag_load_script_url (…/dtag/v9.js), protocol_version.
import type { GtmEntity, GtmTag } from '../shared/types';
import { t } from './i18n';
import { describeSource, param, Resolver, sourceKey } from './resolver';
import { typeName, type EntityRef, type Finding, type LintContext } from './rules';
import { normalizeName, paramLeaves, type ParamLeaf } from './semantics';

export type Bridge = 'GA4' | 'Data Tag' | 'Inny';

export interface SstRoute {
  tag: EntityRef;
  bridge: Bridge;
  template: string;
  /** Server endpoint, resolved (host + path when known). */
  url: string;
  events: string[];
  /** Payload field names sent with the event. */
  fields: string[];
  userData: string[];
  /** For GA4 event tags: the Google tag the route is inherited from. */
  via?: string;
}

export interface SstInventory {
  routes: SstRoute[];
  hosts: string[];
}

const SERVER_URL_NAMES = new Set(['servercontainerurl', 'transporturl', 'serverurl', 'gtmserverdomain']);
const CONVERSION_EVENTS = /purchase|generate_lead|sign_up|lead|kauf|bestell/i;

const ref = (e: GtmEntity): EntityRef => ({ kind: e.kind, id: e.id, name: e.name });
/** Bridge label for display ('Inny' is the internal id of "other"). */
const bridgeLabel = (b: Bridge) => (b === 'Inny' ? t('bridgeOther') : b);

export function analyzeSst(ctx: LintContext): { inventory: SstInventory | null; findings: Finding[] } {
  const resolve = (raw: string) => {
    const s = ctx.resolver.resolveValue(raw).source;
    return s.kind === 'constant' || s.kind === 'text' ? s.value : describeSource(s);
  };

  /** Tag parameters plus parameters of Google tag config/event settings variables it references. */
  const leavesOf = (t: GtmTag): ParamLeaf[] => {
    const own = paramLeaves(t.parameters);
    const inherited = own.flatMap((l) => {
      const refs = Resolver.references(l.value);
      return refs.length === 1 && l.value === `{{${refs[0]}}}` ? settingsLeaves(ctx, refs[0]) : [];
    });
    return [...own, ...inherited];
  };
  const serverUrl = (leaves: ParamLeaf[]): string | null => {
    const domain = leaves.find((l) => SERVER_URL_NAMES.has(normalizeName(l.name)) && l.value);
    if (!domain) return null;
    const path = leaves.find((l) => l.name === 'request_path')?.value;
    return `${resolve(domain.value).replace(/\/+$/, '')}${path ? resolve(path) : ''}`;
  };

  const routes: SstRoute[] = [];
  const googleTagUrl = new Map<string, { url: string | null; tag: GtmTag }>();

  for (const tag of ctx.active.filter((x) => x.type === 'googtag')) {
    const tagId = resolve(param(tag.parameters, 'tagId') ?? '');
    const url = serverUrl(leavesOf(tag));
    googleTagUrl.set(tagId, { url, tag });
    if (url) routes.push({ tag: ref(tag), bridge: 'GA4', template: 'Google tag', url, events: ctx.events.get(tag.id) ?? [], fields: ['config'], userData: [] });
  }

  for (const t of ctx.active) {
    if (t.type === 'googtag') continue;
    const leaves = leavesOf(t);
    const template = typeName(ctx, t.type);
    if (t.type === 'gaawe') {
      const own = serverUrl(leaves);
      const measurementId = resolve(param(t.parameters, 'measurementIdOverride') ?? '');
      const parent = googleTagUrl.get(measurementId);
      const url = own ?? parent?.url;
      if (!url) continue;
      const fields = leaves.filter((l) => l.path.startsWith('eventSettingsTable')).map((l) => l.name);
      if (param(t.parameters, 'sendEcommerceData') === 'true') fields.push('ecommerce (dataLayer)');
      routes.push({
        tag: ref(t),
        bridge: 'GA4',
        template: 'GA4 Event',
        url,
        // Dynamic names ({{Event}}) are shown as the events the tag's triggers listen to.
        events: Resolver.references(param(t.parameters, 'eventName') ?? '').length
          ? ctx.events.get(t.id) ?? []
          : [param(t.parameters, 'eventName') ?? '?'],
        fields,
        userData: leaves.filter((l) => /user_data|email|phone/i.test(l.path)).map((l) => l.name),
        via: own ? undefined : parent?.tag.name,
      });
      continue;
    }
    const url = serverUrl(leaves);
    if (!url) continue;
    const isDataTag = template === 'Data Tag' || (leaves.some((l) => l.name === 'gtm_server_domain') && leaves.some((l) => l.name === 'request_path'));
    const eventName = param(t.parameters, 'event_type') === 'custom' ? param(t.parameters, 'event_name_custom') : param(t.parameters, 'event_name_standard');
    routes.push({
      tag: ref(t),
      bridge: isDataTag ? 'Data Tag' : 'Inny',
      template,
      url,
      events: eventName ? [resolve(eventName)] : ctx.events.get(t.id) ?? [],
      fields: leaves.filter((l) => l.path.startsWith('custom_data')).map((l) => l.name),
      userData: leaves.filter((l) => l.path.startsWith('user_data')).map((l) => l.name),
    });
  }

  if (!routes.length) return { inventory: null, findings: [] };
  const findings: Finding[] = [];
  const host = (url: string) => {
    try {
      return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).host;
    } catch {
      return url;
    }
  };
  const hosts = [...new Set(routes.map((r) => host(r.url)))];

  // 1. One server for everything.
  if (hosts.length > 1) {
    findings.push({
      rule: 'sst-url-mismatch',
      key: 'sst-url-mismatch',
      severity: 'critical',
      title: t('sstUrlMismatchTitle', { count: hosts.length }),
      message: t('sstUrlMismatchMessage'),
      entities: routes.map((r) => r.tag),
      details: hosts.flatMap((h) => [`▸ ${h}`, ...routes.filter((r) => host(r.url) === h).map((r) => `    ${r.tag.name} [${bridgeLabel(r.bridge)}]`)]),
    });
  }
  const expected = ctx.settings.expectedServerContainerUrl.trim();
  if (expected) {
    const wrong = routes.filter((r) => host(r.url) !== host(expected));
    if (wrong.length) {
      findings.push({
        rule: 'sst-url-expected',
        key: 'sst-url-expected',
        severity: 'critical',
        title: t('sstUrlExpectedTitle'),
        message: t('sstUrlExpectedMessage', { host: host(expected) }),
        entities: wrong.map((r) => r.tag),
        details: wrong.map((r) => `${r.tag.name}: ${r.url}`),
      });
    }
  }
  const insecure = routes.filter((r) => /^http:\/\//i.test(r.url));
  if (insecure.length) {
    findings.push({ rule: 'sst-http', key: 'sst-http', severity: 'warning', title: t('sstHttpTitle'), message: t('sstHttpMessage'), entities: insecure.map((r) => r.tag), details: insecure.map((r) => `${r.tag.name}: ${r.url}`) });
  }

  // 2. Google tags / GA4 events bypassing the server.
  // A measurement id split between server and direct sending is a real problem; a *different* GA4
  // property sent directly is usually intentional (e.g. a second property), so only informative.
  const routedIds = new Set(routes.map((r) => r.tag.id));
  const measurementIdRaw = (tag: GtmTag) => param(tag.parameters, tag.type === 'googtag' ? 'tagId' : 'measurementIdOverride') ?? '?';
  const measurementId = (tag: GtmTag) => resolve(measurementIdRaw(tag));
  const serverIds = new Set(
    ctx.active.filter((x) => routedIds.has(x.id) && (x.type === 'googtag' || x.type === 'gaawe')).map(measurementId),
  );
  const direct = ctx.active.filter(
    (x) => !routedIds.has(x.id) && (x.type === 'gaawe' || (x.type === 'googtag' && measurementId(x).startsWith('G-'))),
  );
  const byId = new Map<string, GtmTag[]>();
  for (const x of direct) byId.set(measurementId(x), [...(byId.get(measurementId(x)) ?? []), x]);
  for (const [id, tags] of byId) {
    const split = serverIds.has(id);
    findings.push({
      rule: 'sst-bypass',
      // The display id may be a (translated) source description, so the key uses the source key.
      key: sourceKey(ctx.resolver.resolveValue(measurementIdRaw(tags[0])).source),
      severity: split ? 'warning' : 'info',
      title: t(split ? 'sstBypassSplitTitle' : 'sstBypassDirectTitle', { id, count: tags.length }),
      message: split
        ? t('sstBypassSplitMessage')
        : t('sstBypassDirectMessage', { ids: [...serverIds].join(', ') || t('sstOtherProperty') }),
      entities: tags.map(ref),
      details: tags.map((t) => t.name),
    });
  }

  // 3. Data Tag setup.
  const dataTags = routes.filter((r) => r.bridge === 'Data Tag');
  const dataTagEntities = new Map(ctx.active.filter((t) => dataTags.some((r) => r.tag.id === t.id)).map((t) => [t.id, t]));
  const spread = (key: string, rule: string, title: string, message: string, severity: Finding['severity']) => {
    const values = new Map<string, string[]>();
    for (const r of dataTags) {
      const v = resolve(param(dataTagEntities.get(r.tag.id)!.parameters, key) ?? t('missingValue'));
      values.set(v, [...(values.get(v) ?? []), r.tag.name]);
    }
    if (values.size > 1) {
      findings.push({ rule, key: rule, severity, title, message, entities: dataTags.map((r) => r.tag), details: [...values].flatMap(([v, names]) => [`▸ ${v}`, ...names.map((n) => `    ${n}`)]) });
    }
  };
  spread('data_tag_load_script_url', 'data-tag-script', t('dataTagScriptTitle'), t('dataTagScriptMessage'), 'warning');
  spread('request_path', 'data-tag-path', t('dataTagPathTitle'), t('dataTagPathMessage'), 'warning');
  spread('protocol_version', 'data-tag-protocol', t('dataTagProtocolTitle'), t('dataTagProtocolMessage'), 'info');

  const noEventId = dataTags.filter((r) => ![...r.fields, ...r.userData].some((f) => normalizeName(f) === 'eventid'));
  if (noEventId.length) {
    findings.push({
      rule: 'data-tag-event-id',
      key: 'data-tag-event-id',
      severity: 'warning',
      title: t('dataTagEventIdTitle', { count: noEventId.length }),
      message: t('dataTagEventIdMessage'),
      entities: noEventId.map((r) => r.tag),
      details: noEventId.map((r) => `${r.tag.name} – ${r.events.join(', ')}`),
    });
  }
  for (const r of dataTags.filter((x) => x.events.some((e) => /purchase/i.test(e)))) {
    const names = new Set(r.fields.map(normalizeName));
    const missing = ['value', 'currency', 'transaction_id'].filter((f) => !names.has(normalizeName(f)));
    if (missing.length) {
      findings.push({
        rule: 'data-tag-purchase',
        key: r.tag.id,
        severity: 'warning',
        title: t('dataTagPurchaseTitle', { fields: missing.join(', ') }),
        message: t('dataTagPurchaseMessage'),
        entities: [r.tag],
        details: [t('dataTagPurchaseDetail', { name: r.tag.name, fields: r.fields.join(', ') || t('nothing') })],
      });
    }
  }
  const noUserData = dataTags.filter((r) => r.events.some((e) => CONVERSION_EVENTS.test(e)) && !r.userData.some((f) => /email|phone/i.test(f)));
  if (noUserData.length) {
    findings.push({
      rule: 'data-tag-user-data',
      key: 'data-tag-user-data',
      severity: 'info',
      title: t('dataTagUserDataTitle', { count: noUserData.length }),
      message: t('dataTagUserDataMessage'),
      entities: noUserData.map((r) => r.tag),
      details: noUserData.map((r) => `${r.tag.name} – ${r.events.join(', ')}`),
    });
  }

  // 4. event_id must come from one source everywhere (web + server deduplication).
  const eventIdSources = new Map<string, string[]>();
  for (const tag of ctx.active) {
    for (const l of paramLeaves(tag.parameters)) {
      if (normalizeName(l.name) !== 'eventid' || !l.value) continue;
      const src = ctx.resolver.resolveValue(l.value).source;
      const key = sourceKey(src);
      eventIdSources.set(key, [...(eventIdSources.get(key) ?? []), `${tag.name} (${describeSource(src)})`]);
    }
  }
  if (eventIdSources.size > 1) {
    findings.push({
      rule: 'event-id-sources',
      key: 'event-id-sources',
      severity: 'warning',
      title: t('eventIdSourcesTitle', { count: eventIdSources.size }),
      message: t('eventIdSourcesMessage'),
      entities: ctx.active.filter((x) => paramLeaves(x.parameters).some((l) => normalizeName(l.name) === 'eventid')).map(ref),
      details: [...eventIdSources.values()].flatMap((list, i) => [t('eventIdSource', { n: i + 1 }), ...list.map((x) => `    ${x}`)]),
    });
  }

  return { inventory: { routes, hosts }, findings };
}

/** Parameters of a Google tag configuration/event settings variable (types gtcs / gtes). */
function settingsLeaves(ctx: LintContext, variableName: string): ParamLeaf[] {
  const v = ctx.resolver.variable(variableName);
  return v && (v.type === 'gtcs' || v.type === 'gtes') ? paramLeaves(v.parameters) : [];
}
