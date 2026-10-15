// Agency best practices on GTM's container Settings page (Google tag settings / destinations):
//  - every known setting row gets a small badge with the recommendation;
//  - when a setting is opened (route /activities/<n>), a card next to GTM's sheet explains what to set,
//    why and how to verify it;
//  - a "Best practices" pill on the Settings page opens an overview incl. "Combine Google tags?".
// Read-only: nothing in GTM is changed.
import { defineMessages, getLang } from '../i18n';
import { COMBINE_GUIDE, GUIDE_BY_ID, ACTIVITY_ROUTE_IDS, SETTINGS_GUIDE, type Recommendation, type SettingGuide } from '../guide/googleTagGuide';
import { h } from './panel/dom';
import { BRAND_MARK_SVG } from './panel/styles';

const t = defineMessages({
  en: {
    brand: 'smarketer best practice',
    pill: 'Best practices',
    pillTitle: 'Recommended Google tag settings (smarketer)',
    why: 'Why',
    verify: 'How to verify',
    all: 'All recommendations',
    combine: 'Combine Google tags?',
    back: '← Back',
    close: 'Close',
    overviewTitle: 'Google tag settings – recommendations',
    overviewIntro: 'For setups where analytics and e-commerce run through GTM and the data layer. Click a setting for details.',
    recEnable: 'Enable',
    recDisable: 'Disable',
    recConfigure: 'Configure',
    recDefault: 'Default',
  },
  de: {
    brand: 'smarketer Best Practice',
    pill: 'Best Practices',
    pillTitle: 'Empfohlene Google-Tag-Einstellungen (smarketer)',
    why: 'Warum',
    verify: 'So prüfen',
    all: 'Alle Empfehlungen',
    combine: 'Google-Tags kombinieren?',
    back: '← Zurück',
    close: 'Schließen',
    overviewTitle: 'Google-Tag-Einstellungen – Empfehlungen',
    overviewIntro: 'Für Setups, in denen Analytics und E-Commerce über GTM und die Datenschicht laufen. Für Details auf eine Einstellung klicken.',
    recEnable: 'Aktivieren',
    recDisable: 'Deaktivieren',
    recConfigure: 'Konfigurieren',
    recDefault: 'Standard',
  },
  pl: {
    brand: 'smarketer best practice',
    pill: 'Best practices',
    pillTitle: 'Rekomendowane ustawienia Google tag (smarketer)',
    why: 'Dlaczego',
    verify: 'Jak weryfikować',
    all: 'Wszystkie rekomendacje',
    combine: 'Czy łączyć Google tagi?',
    back: '← Wróć',
    close: 'Zamknij',
    overviewTitle: 'Ustawienia Google tag – rekomendacje',
    overviewIntro: 'Dla wdrożeń, w których analityka i e-commerce idą przez GTM i Data Layer. Kliknij ustawienie, aby zobaczyć szczegóły.',
    recEnable: 'Włącz',
    recDisable: 'Wyłącz',
    recConfigure: 'Konfiguruj',
    recDefault: 'Domyślnie',
  },
});

const BADGE_ATTR = 'data-gtmqa-guide';
const SLAT_PREFIX = 'activity-slat--';
const REC_LABEL: Record<Recommendation, Parameters<typeof t>[0]> = {
  enable: 'recEnable',
  disable: 'recDisable',
  configure: 'recConfigure',
  default: 'recDefault',
};
const REC_COLOR: Record<Recommendation, { bg: string; fg: string }> = {
  enable: { bg: '#dcfce7', fg: '#15803d' },
  disable: { bg: '#fee2e2', fg: '#b91c1c' },
  configure: { bg: '#e0f2fe', fg: '#0369a1' },
  default: { bg: '#f3f4f6', fg: '#374151' },
};

type View = { kind: 'hidden' } | { kind: 'pill' } | { kind: 'setting'; id: string } | { kind: 'overview'; open?: string; combine?: boolean };

/** publicId of a settings row, from GTM's class "activity-slat--<id>". */
function slatId(el: Element): string | undefined {
  return [...el.classList].find((c) => c.startsWith(SLAT_PREFIX))?.slice(SLAT_PREFIX.length);
}

export class SettingsGuide {
  private readonly host = document.createElement('div');
  private readonly root: ShadowRoot;
  private enabled = true;
  /** Setting the user clicked last – for activities without a fixed route id (e.g. internal traffic). */
  private lastClicked: string | null = null;
  /** User navigation inside the card (overview / back); reset when the GTM route changes. */
  private manual: View | null = null;
  /** Route whose card the user closed. */
  private closedRoute: string | null = null;
  private route = '';
  private signature = '';
  private scheduled = false;

  constructor() {
    this.host.id = 'gtm-qa-guide-host';
    this.root = this.host.attachShadow({ mode: 'open' });
    new MutationObserver(() => this.schedule()).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', () => this.schedule());
    document.addEventListener(
      'click',
      (e) => {
        const slat = (e.target as Element | null)?.closest?.('.activity-slat');
        const id = slat && slatId(slat);
        if (id) this.lastClicked = id;
      },
      true,
    );
    this.schedule();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.refresh();
  }

  /** Re-renders (e.g. after a language switch). */
  refresh(): void {
    this.signature = '';
    for (const b of document.querySelectorAll(`[${BADGE_ATTR}]`)) b.remove();
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.scan();
    }, 150);
  }

  private scan(): void {
    const hash = location.hash;
    const onConfig = /\/workspaces\/\d+\/config\/?$/.test(hash);
    const activity = hash.match(/\/workspaces\/\d+\/activities\/(\d+)/)?.[1];
    if (hash !== this.route) {
      this.route = hash;
      this.manual = null;
    }
    if (this.enabled && onConfig) this.decorateSlats();

    let view: View = { kind: 'hidden' };
    if (this.enabled && (onConfig || activity)) {
      const id = activity ? (ACTIVITY_ROUTE_IDS[activity] ?? this.lastClicked ?? '') : '';
      if (this.manual) view = this.manual;
      else if (activity && GUIDE_BY_ID.has(id) && this.closedRoute !== hash) view = { kind: 'setting', id };
      else view = { kind: 'pill' };
    }
    this.render(view);
  }

  private decorateSlats(): void {
    for (const slat of document.querySelectorAll('.activity-slat')) {
      const guide = GUIDE_BY_ID.get(slatId(slat) ?? '');
      const title = slat.querySelector<HTMLElement>('.activity-details__description-title');
      if (!guide || !title || title.querySelector(`[${BADGE_ATTR}]`)) continue;
      const badge = this.recBadge(guide.rec, document);
      badge.setAttribute(BADGE_ATTR, guide.id);
      badge.title = `${t('brand')}: ${guide.recText[getLang()]}\n\n${guide.why[getLang()]}`;
      badge.style.marginLeft = '8px';
      title.append(badge);
    }
  }

  /** Badge with inline styles (used both in GTM's DOM and in our shadow root). */
  private recBadge(rec: Recommendation, doc: Document): HTMLElement {
    const el = doc.createElement('span');
    el.textContent = `★ ${t(REC_LABEL[rec])}`;
    const c = REC_COLOR[rec];
    el.style.cssText =
      `display:inline-block;padding:1px 8px;border-radius:999px;font:600 11px/18px 'GtmQaInter',Inter,Roboto,Arial,sans-serif;` +
      `background:${c.bg};color:${c.fg};vertical-align:middle;white-space:nowrap;`;
    return el;
  }

  private render(view: View): void {
    const signature = `${getLang()}|${JSON.stringify(view)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    if (view.kind === 'hidden') return void this.host.remove();
    if (!this.host.isConnected) document.body.append(this.host);
    const content =
      view.kind === 'pill' ? this.pill() : view.kind === 'setting' ? this.settingCard(GUIDE_BY_ID.get(view.id)!) : this.overview(view.open, view.combine);
    const style = h('style', {}, CSS);
    this.root.replaceChildren(style, content);
    if (view.kind === 'overview' && view.combine) this.root.querySelector('.combine')?.scrollIntoView({ block: 'start' });
  }

  private go(view: View): void {
    this.manual = view;
    this.render(view);
  }

  private pill(): Node {
    const pill = h('button', { class: 'pill', title: t('pillTitle'), onClick: () => this.go({ kind: 'overview' }) });
    const mark = h('span', { class: 'mark' });
    mark.innerHTML = BRAND_MARK_SVG; // static SVG constant
    pill.append(mark, t('pill'));
    return pill;
  }

  private header(onBack?: () => void): Node {
    const mark = h('span', { class: 'mark' });
    mark.innerHTML = BRAND_MARK_SVG; // static SVG constant
    return h(
      'div',
      { class: 'head' },
      onBack ? h('button', { class: 'link light', onClick: onBack }, t('back')) : h('span', { class: 'brand' }, mark, t('brand')),
      h(
        'button',
        {
          class: 'x',
          title: t('close'),
          onClick: () => {
            this.closedRoute = location.hash;
            this.go({ kind: 'pill' });
          },
        },
        '×',
      ),
    );
  }

  private settingCard(g: SettingGuide): Node {
    const lang = getLang();
    return h(
      'div',
      { class: 'card' },
      this.header(),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'title' }, g.title[lang]),
        h('div', { class: 'rec' }, this.recBadge(g.rec, document), g.recText[lang] !== t(REC_LABEL[g.rec]) ? h('strong', {}, g.recText[lang]) : null),
        h('div', { class: 'label' }, t('why')),
        h('p', {}, g.why[lang]),
        g.verify ? h('div', { class: 'label' }, t('verify')) : null,
        g.verify ? h('p', {}, g.verify[lang]) : null,
      ),
      h(
        'div',
        { class: 'foot' },
        h('button', { class: 'link', onClick: () => this.go({ kind: 'overview', open: g.id }) }, t('all')),
        h('button', { class: 'link', onClick: () => this.go({ kind: 'overview', combine: true }) }, t('combine')),
      ),
    );
  }

  private overview(open?: string, combine?: boolean): Node {
    const lang = getLang();
    const c = COMBINE_GUIDE[lang];
    const back = this.manual && this.route.includes('/activities/') ? () => ((this.manual = null), (this.signature = ''), this.scan()) : undefined;
    return h(
      'div',
      { class: 'card wide' },
      this.header(back),
      h(
        'div',
        { class: 'body scroll' },
        h('div', { class: 'title' }, t('overviewTitle')),
        h('p', { class: 'muted' }, t('overviewIntro')),
        ...SETTINGS_GUIDE.map((g) =>
          h(
            'details',
            { class: 'row', open: g.id === open },
            h('summary', {}, this.recBadge(g.rec, document), h('span', {}, g.title[lang])),
            h('p', {}, h('strong', {}, g.recText[lang]), ' – ', g.why[lang]),
            g.verify ? h('p', { class: 'muted' }, `${t('verify')}: ${g.verify[lang]}`) : null,
          ),
        ),
        h(
          'details',
          { class: 'row combine', open: !!combine },
          h('summary', {}, h('span', {}, '🔗 ', c.title)),
          h('p', {}, c.intro),
          h('div', { class: 'label' }, c.dont.title),
          h('ul', {}, ...c.dont.items.map((x) => h('li', {}, x))),
          h('div', { class: 'label' }, c.do.title),
          h('ul', {}, ...c.do.items.map((x) => h('li', {}, x))),
          h('p', { class: 'summary' }, c.summary),
        ),
      ),
    );
  }
}

const CSS = /* css */ `
:host { all: initial; }
* { box-sizing: border-box; }
.pill, .card { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; font: 13px/1.5 'GtmQaInter', Inter, system-ui, sans-serif; color: #111827; }
.pill {
  display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px 0 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.18); background: linear-gradient(135deg, #3c0a6d 0%, #6e6eaa 100%); color: #fff;
  font-weight: 600; box-shadow: 0 6px 18px rgba(52,2,84,.3);
}
.pill:hover { transform: translateY(-1px); }
.mark { display: inline-flex; width: 18px; height: 18px; }
.mark svg { width: 100%; height: 100%; }
.card {
  width: min(380px, calc(100vw - 32px)); max-height: calc(100vh - 120px); display: flex; flex-direction: column;
  background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 16px 40px rgba(17,24,39,.22); border: 1px solid #e5e7eb;
}
.card.wide { width: min(460px, calc(100vw - 32px)); }
.head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; background: linear-gradient(135deg, #3c0a6d 0%, #6e6eaa 100%); color: #fff; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12px; letter-spacing: .03em; }
.x { border: 0; background: transparent; color: #fff; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 4px; }
.body { padding: 12px 14px; }
.body.scroll { overflow: auto; }
.title { font-size: 15px; font-weight: 700; color: #340254; margin-bottom: 6px; }
.rec { display: flex; align-items: center; gap: 8px; margin: 4px 0 10px; }
.label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; margin-top: 10px; }
p { margin: 4px 0; color: #374151; }
.muted { color: #6b7280; font-size: 12px; }
ul { margin: 4px 0; padding-left: 18px; color: #374151; }
li { margin: 3px 0; }
.summary { margin-top: 10px; padding: 8px 10px; background: #f3eefa; border-radius: 8px; color: #340254; }
.foot { display: flex; gap: 14px; padding: 9px 14px; border-top: 1px solid #f3f4f6; background: #faf7fd; }
.link { border: 0; background: none; padding: 0; color: #6e3bb0; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.link:hover { text-decoration: underline; }
.link.light { color: #fff; }
details.row { border-top: 1px solid #f3f4f6; padding: 7px 0; }
details.row summary { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 500; list-style: none; }
details.row summary::-webkit-details-marker { display: none; }
details.row[open] summary { color: #340254; }
details.row > p, details.row > ul, details.row > .label { margin-left: 2px; }
`;
