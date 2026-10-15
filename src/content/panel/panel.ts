// Sidebar panel injected into the GTM page inside a Shadow DOM.
// All user/container-provided strings are rendered as text nodes (never innerHTML).
import { getLang, isLang, LANGS, type Lang } from '../../i18n';
import { savePreviewQa, toPreviewQa } from '../../shared/previewQa';
import { DEFAULT_MODELS, loadSettings, saveSettings, type LlmProvider } from '../../shared/storage';
import type { DetectedCounts, EntityChange, EntityKind, GtmEntity, GtmParameter, ScopeKey, Snapshot } from '../../shared/types';
import { hasEntities } from '../captureLog';
import type { Controller } from '../content';
import type { Progress } from '../loader';
import { GtmOverlay } from '../overlay';
import { SettingsGuide } from '../settingsGuide';
import { DiffTab } from './diffTab';
import { exceptionsSection } from './exceptionsView';
import { QaTab } from './qaTab';
import { ReportTab } from './reportTab';
import { fmtBytes, fmtTime, h, type Child } from './dom';
import { t } from './i18n';
import { BRAND_MARK_SVG, installFonts, styles } from './styles';

type TabId = 'data' | 'diff' | 'qa' | 'report' | 'settings' | 'debug';

// Labels are message keys, resolved at render time (the language can change at runtime).
const TABS: { id: TabId; label: Parameters<typeof t>[0] }[] = [
  { id: 'data', label: 'tabData' },
  { id: 'diff', label: 'tabDiff' },
  { id: 'qa', label: 'tabQa' },
  { id: 'report', label: 'tabReport' },
  { id: 'settings', label: 'tabSettings' },
  { id: 'debug', label: 'tabDebug' },
];

/** Tabs re-rendered when the store / the capture log changes. */
const LIVE_TABS: Record<'store' | 'log', TabId[]> = { store: ['data', 'debug'], log: ['debug'] };

const MAX_PARAM_VALUE = 300;

/** Human-readable parameter dump; long values (e.g. Custom HTML) are truncated. */
function paramLines(params: GtmParameter[], indent = ''): string[] {
  const lines: string[] = [];
  for (const p of params) {
    const label = `${indent}${p.key ?? '-'}`;
    if (p.list || p.map) {
      lines.push(`${label}: [${p.type}]`);
      lines.push(...paramLines(p.list ?? p.map ?? [], `${indent}  `));
    } else {
      const value = p.value ?? '';
      lines.push(`${label} = ${value.length > MAX_PARAM_VALUE ? `${value.slice(0, MAX_PARAM_VALUE)}… ${t('chars', { n: value.length })}` : value}`);
    }
  }
  return lines;
}


function countsText(d: DetectedCounts): string {
  const parts = [
    d.tags && t('countTags', { n: d.tags }),
    d.triggers && t('countTriggers', { n: d.triggers }),
    d.variables && t('countVariables', { n: d.variables }),
    d.versions && t('countVersions', { n: d.versions }),
    d.headers && t('countHeaders', { n: d.headers }),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : t('noEntities');
}

/** Brand mark for the header – static SVG markup from styles.ts (no user data, so innerHTML is safe here). */
function brandMark(): HTMLElement {
  const el = h('span', { class: 'brand-mark' });
  el.innerHTML = BRAND_MARK_SVG;
  return el;
}

const HINT_DELAY_MS = 2000;
const HINT_STORAGE_KEY = 'gtmqa-hint-dismissed';

/** Containers whose reminder was dismissed in this browser session (sessionStorage may be unavailable). */
function hintDismissed(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(HINT_STORAGE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function dismissHint(containerId: string): void {
  try {
    sessionStorage.setItem(HINT_STORAGE_KEY, JSON.stringify([...new Set([...hintDismissed(), containerId])]));
  } catch {
    // Storage blocked: the bubble simply comes back after a reload.
  }
}

export class Panel {
  private readonly launcherDot: HTMLElement;
  private readonly hint: HTMLElement;
  /** Containers that got a QA run in this tab (no reminder needed). */
  private readonly checkedContainers = new Set<string>();
  /** When each container was first seen, to delay the reminder. */
  private readonly hintSince = new Map<string, number>();
  private lintSeen: Controller['lastLint'] = null;
  /** Markers in GTM's own lists, and the result they currently show. */
  private readonly overlay: GtmOverlay;
  private overlayLint: Controller['lastLint'] = null;
  /** Google tag best practices on GTM's Settings page. */
  private readonly guide = new SettingsGuide();
  /** Set when the user clicks Submit/Publish in GTM; cleared when dismissed or the report is started. */
  private reportReminder = false;
  /** Container the tabs currently show data for. */
  private shownContainer: string | undefined;
  private lintContainer: string | undefined;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly ctxLine: HTMLElement;
  private readonly langSwitch: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly nav: HTMLElement;
  private readonly main: HTMLElement;
  private tab: TabId = 'data';
  private selectedScope: ScopeKey | null = null;
  private renderQueued = false;
  private renderSources = new Set<'store' | 'log'>();
  private progress: Progress | null = null;
  private readonly diffTab: DiffTab;
  private readonly qaTab: QaTab;
  private readonly reportTab: ReportTab;
  private readonly notices = new Map<TabId, { text: string; ok: boolean }>();

  constructor(private readonly ctl: Controller) {
    installFonts();
    this.overlay = new GtmOverlay(
      {
        summary: (critical, warning, info) => t('markerSummary', { critical, warning, info }),
        navSummary: (critical, warning, info) => t('navSummary', { critical, warning, info }),
        uses: (names) => t('markerUses', { names }),
        rename: (name) => t('markerRename', { name }),
      },
      (kind, name, related) => this.openEntity(kind, name, related),
    );
    void loadSettings().then((s) => this.guide.setEnabled(s.settingsGuide));
    const host = document.createElement('div');
    host.id = 'gtm-qa-checker-host';
    this.root = host.attachShadow({ mode: 'open' });

    this.diffTab = new DiffTab(ctl);
    this.qaTab = new QaTab(ctl);
    this.reportTab = new ReportTab(ctl);
    this.ctxLine = h('div', { class: 'ctx' });
    this.langSwitch = h('div', { class: 'lang-switch', role: 'group' });
    this.closeBtn = h('button', { class: 'icon-btn', onClick: () => this.toggle(false) }, '×');
    this.nav = h('nav', { role: 'tablist' });
    this.main = h('main');
    this.panel = h(
      'aside',
      { class: 'panel', hidden: true },
      h(
        'header',
        {},
        brandMark(),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, 'GTM QA Checker'), this.ctxLine),
        this.langSwitch,
        this.closeBtn,
      ),
      this.nav,
      this.main,
    );

    // Floating pill: brand mark + QA, with a red dot while the last QA run has critical findings.
    this.launcherDot = h('span', { class: 'launcher-dot', hidden: true });
    const launcher = h('button', { class: 'launcher', title: 'GTM QA Checker', onClick: () => this.toggle() }, brandMark(), h('span', {}, 'QA'), this.launcherDot);
    this.hint = h('div', { class: 'launcher-hint', role: 'status', hidden: true });
    const style = h('style', {}, styles);
    this.root.append(style, h('div', { class: 'root' }, this.hint, launcher, this.panel));
    document.documentElement.append(host);

    ctl.store.subscribe(() => this.queueRender('store'));
    ctl.log.subscribe(() => this.queueRender('log'));
    this.renderNav();
    this.renderHeader();
    this.renderLangSwitch();
    this.watchPublish();
  }

  toggle(force?: boolean): void {
    const open = force ?? this.panel.hidden;
    this.panel.hidden = !open;
    // A QA run over unchanged data emits no store change – refresh the launcher's alert dot here.
    this.renderHeader();
    if (!open) return;
    this.renderTab();
    const { store } = this.ctl;
    if (store.versionHeaders.size === 0 && store.context.containerId) {
      void this.runLoad(t('versionList'), () => this.ctl.loadVersionList());
    }
  }

  private queueRender(source: 'store' | 'log'): void {
    this.renderSources.add(source);
    if (this.renderQueued) return;
    this.renderQueued = true;
    // setTimeout, not requestAnimationFrame: rAF is paused while the GTM window is occluded,
    // which would freeze the panel during long background loads.
    setTimeout(() => {
      const sources = this.renderSources;
      this.renderSources = new Set();
      this.renderQueued = false;
      this.renderHeader();
      if (!this.panel.hidden && [...sources].some((s) => LIVE_TABS[s].includes(this.tab))) this.renderTab();
    }, 50);
  }

  private renderHeader(): void {
    const containerId = this.ctl.store.context.containerId;
    if (containerId && this.shownContainer && containerId !== this.shownContainer) {
      this.diffTab.resetForContainer();
      this.qaTab.resetForContainer();
      this.reportTab.resetForContainer();
      if (!this.panel.hidden) this.renderTab();
    }
    this.shownContainer = containerId;
    // QA always runs on the open container: remember which container the latest result belongs to.
    if (this.ctl.lastLint && this.ctl.lastLint !== this.lintSeen) {
      this.lintSeen = this.ctl.lastLint;
      this.lintContainer = containerId;
      if (containerId) this.checkedContainers.add(containerId);
    }
    // Markers only for the open container's result (also after exceptions changed the result).
    const currentLint = this.lintContainer === containerId ? this.ctl.lastLint : null;
    if (currentLint !== this.overlayLint) {
      this.overlayLint = currentLint;
      this.overlay.update(currentLint, currentLint ? this.ctl.store.snapshots.get(currentLint.scope) ?? null : null);
      // Same result for the Tag Assistant (Preview) tab of this container.
      const publicId = this.ctl.store.context.publicId;
      if (currentLint && publicId) {
        void loadSettings().then((s) => savePreviewQa(toPreviewQa(publicId, currentLint, s.markersHideNaming)));
      }
    }
    const critical = this.lintContainer === containerId ? this.ctl.lastLint?.counts.critical ?? 0 : 0;
    this.launcherDot.hidden = critical === 0;
    this.launcherDot.title = String(critical);
    this.renderHint();
    const { publicId, workspaceId, versionId } = this.ctl.store.context;
    const parts = [
      publicId ?? (containerId ? t('ctxContainer', { id: containerId }) : null),
      workspaceId && t('ctxWorkspace', { id: workspaceId }),
      versionId && t('ctxVersion', { id: versionId }),
    ].filter(Boolean);
    this.ctxLine.textContent = parts.length ? parts.join(' · ') : t('ctxNone');
    this.closeBtn.title = t('close');
  }

  /**
   * Reminder bubble above the launcher: shown ~2 s after a container opens if it has not been
   * checked in this tab yet. "Run QA" opens the QA tab and starts the scan; × hides it for this
   * container for the rest of the browser session.
   */
  private renderHint(): void {
    const containerId = this.ctl.store.context.containerId;
    // Publish reminder wins over the QA reminder.
    if (this.reportReminder && containerId && this.panel.hidden && !this.reportTab.reportedContainers.has(containerId)) {
      this.hint.hidden = false;
      this.hint.replaceChildren(
        h('span', { class: 'hint-text' }, t('reportHintText')),
        h('button', { class: 'btn primary small', onClick: () => this.runReportFromHint() }, t('reportHintRun')),
        h('button', { class: 'hint-close', title: t('hintDismiss'), onClick: () => ((this.reportReminder = false), this.renderHint()) }, '×'),
      );
      return;
    }
    const show =
      !!containerId &&
      this.panel.hidden &&
      !this.checkedContainers.has(containerId) &&
      !hintDismissed().includes(containerId) &&
      this.hintDue(containerId);
    this.hint.hidden = !show;
    if (!show) return;
    this.hint.replaceChildren(
      h('span', { class: 'hint-text' }, t('hintText')),
      h('button', { class: 'btn primary small', onClick: () => this.runFromHint() }, t('hintRun')),
      h('button', { class: 'hint-close', title: t('hintDismiss'), onClick: () => (dismissHint(containerId), this.renderHint()) }, '×'),
    );
  }

  /** True once the container has been open for HINT_DELAY_MS; schedules a re-check until then. */
  private hintDue(containerId: string): boolean {
    let since = this.hintSince.get(containerId);
    if (since === undefined) {
      since = Date.now();
      this.hintSince.set(containerId, since);
    }
    const remaining = since + HINT_DELAY_MS - Date.now();
    if (remaining > 0) setTimeout(() => this.renderHint(), remaining + 20);
    return remaining <= 0;
  }

  private runReportFromHint(): void {
    this.reportReminder = false;
    this.tab = 'report';
    this.renderNav();
    this.toggle(true);
    void this.reportTab.quickReport();
  }

  /**
   * "Finished the work" moment: the user clicks Submit / Publish in GTM. We never block GTM – we only
   * show the report reminder (unless a report was already generated for this container in this tab).
   */
  private watchPublish(): void {
    const PUBLISH = /^(submit|publish|senden|einreichen|veröffentlichen|prześlij|wyślij|opublikuj)$/i;
    document.addEventListener(
      'click',
      (event) => {
        const target = event.composedPath()[0];
        if (!(target instanceof Element) || target.closest('#gtm-qa-checker-host')) return;
        const button = target.closest('button, [role="button"], a');
        const label = button?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        if (!PUBLISH.test(label)) return;
        this.reportReminder = true;
        this.renderHint();
      },
      true,
    );
  }

  /** Marker clicked in GTM's list: open the QA tab filtered to that entity. */
  private openEntity(kind: EntityKind, name: string, related: string[]): void {
    this.qaTab.focusEntity(kind, name, related);
    this.tab = 'qa';
    this.renderNav();
    this.toggle(true);
  }

  private runFromHint(): void {
    this.tab = 'qa';
    this.renderNav();
    this.toggle(true);
    this.qaTab.start();
  }

  /** EN / DE / PL toggle in the header; the active language is highlighted. */
  private renderLangSwitch(): void {
    const current = getLang();
    this.langSwitch.title = t('language');
    this.langSwitch.setAttribute('aria-label', t('language'));
    this.langSwitch.replaceChildren(
      ...LANGS.map((l) =>
        h(
          'button',
          { class: l.id === current ? 'active' : '', title: l.name, 'aria-pressed': String(l.id === current), onClick: () => void this.changeLanguage(l.id) },
          l.label,
        ),
      ),
    );
  }

  /** Saves the language, re-computes diff/QA in it and re-renders the whole panel. */
  private async changeLanguage(lang: Lang): Promise<void> {
    if (lang === getLang()) return;
    await this.ctl.setLanguage(lang);
    // Stored notices are in the previous language.
    this.notices.clear();
    this.diffTab.refresh();
    this.qaTab.refresh();
    this.reportTab.refresh();
    this.guide.refresh();
    this.renderHeader();
    this.renderLangSwitch();
    this.renderNav();
    if (!this.panel.hidden) this.renderTab();
  }

  private renderNav(): void {
    this.nav.replaceChildren(
      ...TABS.map((tab) =>
        h(
          'button',
          {
            role: 'tab',
            'aria-selected': String(tab.id === this.tab),
            onClick: () => {
              this.tab = tab.id;
              this.renderNav();
              this.renderTab();
            },
          },
          t(tab.label),
        ),
      ),
    );
  }

  private renderTab(): void {
    const scrollTop = this.main.scrollTop;
    switch (this.tab) {
      case 'data':
        this.main.replaceChildren(...this.renderData());
        break;
      case 'debug':
        this.main.replaceChildren(...this.renderDebug());
        break;
      case 'settings':
        this.main.replaceChildren(h('p', { class: 'muted' }, t('loading')));
        void this.renderSettings().then((nodes) => this.tab === 'settings' && this.main.replaceChildren(...nodes));
        break;
      case 'diff':
        this.diffTab.show();
        this.main.replaceChildren(this.diffTab.element);
        break;
      case 'qa':
        this.qaTab.show();
        this.main.replaceChildren(this.qaTab.element);
        break;
      case 'report':
        this.reportTab.show();
        this.main.replaceChildren(this.reportTab.element);
        break;
    }
    this.main.scrollTop = scrollTop;
  }


  // --- Data ------------------------------------------------------------------

  /** Runs a loader action with progress shown in the Data tab; one action at a time. */
  private async runLoad(label: string, action: (onProgress: (p: Progress) => void) => Promise<void>): Promise<void> {
    if (this.progress) return;
    this.progress = { label, done: 0, total: 0 };
    this.queueRender('store');
    try {
      await action((p) => {
        this.progress = p;
        this.queueRender('store');
      });
      this.notices.set('data', { text: t('loadDone', { label }), ok: true });
    } catch (err) {
      this.notices.set('data', { text: `${label}: ${(err as Error).message}`, ok: false });
    } finally {
      this.progress = null;
      this.queueRender('store');
    }
  }

  private renderData(): Node[] {
    const { store } = this.ctl;
    const ctx = store.context;
    const busy = this.progress !== null;
    const status = this.progress
      ? h('div', { class: 'status' }, `${this.progress.label}${this.progress.total ? ` – ${this.progress.done}/${this.progress.total}` : '…'}`)
      : this.statusFor('data');

    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const counts = await this.ctl.importExportFile(file);
        this.selectedScope = `import:${file.name}`;
        this.flash(status, t('imported', { counts: countsText(counts) }), true);
      } catch (err) {
        this.flash(status, (err as Error).message, false);
      }
    });

    const button = (label: string, onClick: () => void, primary = false) =>
      h('button', { class: `btn${primary ? ' primary' : ''}`, disabled: busy, onClick }, label);

    const workspaceId = ctx.workspaceId;
    const ws = workspaceId ? store.workspaces.get(workspaceId) : undefined;
    const headers = [...store.versionHeaders.values()].sort((a, b) => Number(b.versionId) - Number(a.versionId));

    const nodes: Node[] = [
      h(
        'section',
        {},
        h('h3', {}, t('context')),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, t('container')), h('dd', {}, [ctx.publicId, ctx.containerId].filter(Boolean).join(' · ') || '—'),
          h('dt', {}, t('workspace')), h('dd', {}, [workspaceId, ws?.name].filter(Boolean).join(' · ') || '—'),
          h('dt', {}, t('baseVersion')), h('dd', {}, ws?.baseVersionId ?? '—'),
          h('dt', {}, t('viewedVersion')), h('dd', {}, ctx.versionId ?? '—'),
        ),
      ),
      h(
        'section',
        {},
        h(
          'div',
          { class: 'row' },
          workspaceId
            ? button(t('loadWorkspaceBtn', { id: workspaceId }), () => {
                this.selectedScope = `workspace:${workspaceId}`;
                void this.runLoad(t('workspaceLabel', { id: workspaceId }), (p) => this.ctl.loadWorkspace(workspaceId, p));
              }, true)
            : null,
          ctx.versionId
            ? button(t('loadVersionBtn', { id: ctx.versionId }), () => this.loadVersion(ctx.versionId!), !workspaceId)
            : null,
          button(t('importExport'), () => fileInput.click()),
          fileInput,
        ),
        status,
      ),
    ];

    if (ws?.changes?.length) nodes.push(this.renderChanges(t('workspaceChanges', { n: ws.changes.length }), ws.changes));

    const snapshots = [...store.snapshots.values()].sort((a, b) => a.key.localeCompare(b.key, getLang(), { numeric: true }));
    if (snapshots.length) {
      nodes.push(this.renderSnapshotTable(snapshots));
      const selected = this.selectedScope ? store.snapshots.get(this.selectedScope) : undefined;
      if (selected) nodes.push(this.renderSnapshotDetail(selected));
    } else {
      nodes.push(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, t('noData')),
          h('p', { class: 'small' }, t('noDataHint')),
        ),
      );
    }

    nodes.push(
      h(
        'section',
        {},
        h('div', { class: 'row spread' }, h('h3', {}, t('versions', { n: headers.length })), button(t('refreshList'), () => void this.runLoad(t('versionList'), () => this.ctl.loadVersionList()))),
        headers.length
          ? h(
              'ul',
              { class: 'list' },
              ...headers.map((v) =>
                h(
                  'li',
                  {},
                  h(
                    'span',
                    { class: 'name' },
                    h('strong', {}, `v${v.versionId}`),
                    v.name ? ` ${v.name}` : '',
                    v.versionId === ws?.baseVersionId ? h('span', { class: 'badge ok', title: t('baseBadgeTitle') }, t('baseBadge')) : null,
                    h('div', { class: 'small muted' }, [fmtTime(v.createdAt), v.author].filter((x) => x && x !== '—').join(' · ')),
                  ),
                  h('span', {}, h('button', { class: 'btn small', disabled: busy, onClick: () => this.loadVersion(v.versionId) }, t('load'))),
                ),
              ),
            )
          : h('p', { class: 'small muted' }, t('versionListNotLoaded')),
      ),
    );
    return nodes;
  }

  private loadVersion(versionId: string): void {
    this.selectedScope = `version:${versionId}`;
    void this.runLoad(t('versionLabel', { id: versionId }), (p) => this.ctl.loadVersion(versionId, p));
  }

  private renderChanges(title: string, changes: EntityChange[]): Node {
    const label: Record<string, string> = { added: t('statusAdded'), modified: t('statusModified'), deleted: t('statusDeleted'), none: '—', unknown: '?' };
    const cls: Record<string, string> = { added: 'ok', modified: 'warn', deleted: 'crit' };
    const kind: Record<string, string> = {
      tag: t('kindTag'),
      trigger: t('kindTrigger'),
      variable: t('kindVariable'),
      template: t('kindTemplate'),
      folder: t('kindFolder'),
      other: t('kindOther'),
    };
    return h(
      'section',
      {},
      h(
        'details',
        { open: changes.length <= 15 },
        h('summary', {}, title),
        h(
          'ul',
          { class: 'list' },
          ...changes.map((c) =>
            h(
              'li',
              {},
              h('span', { class: 'name' }, h('span', { class: `badge ${cls[c.status] ?? ''}` }, label[c.status] ?? c.status), ' ', c.name),
              h('span', { class: 'type' }, [kind[c.entityType], c.templateType].filter(Boolean).join(' · ')),
            ),
          ),
        ),
      ),
    );
  }

  private renderSnapshotTable(snapshots: Snapshot[]): Node {
    return h(
      'section',
      {},
      h('h3', {}, t('loadedScopes')),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, t('scope')), h('th', { class: 'num' }, t('tags')), h('th', { class: 'num' }, t('triggers')), h('th', { class: 'num' }, t('variables')))),
        h(
          'tbody',
          {},
          ...snapshots.map((s) => {
            const missing = this.ctl.store.incompleteEntities(s.key).length;
            return h(
              'tr',
              {
                class: `clickable${s.key === this.selectedScope ? ' selected' : ''}`,
                onClick: () => {
                  this.selectedScope = s.key === this.selectedScope ? null : s.key;
                  this.renderTab();
                },
              },
              h(
                'td',
                {},
                s.label,
                ' ',
                h('span', { class: `badge ${s.complete ? 'ok' : 'warn'}`, title: s.complete ? t('completeTitle') : t('partialTitle') }, s.complete ? t('complete') : t('partial')),
                missing ? h('span', { class: 'badge warn', title: t('missingParamsTitle') }, t('missingParams', { n: missing })) : null,
              ),
              h('td', { class: 'num' }, Object.keys(s.tags).length),
              h('td', { class: 'num' }, Object.keys(s.triggers).length),
              h('td', { class: 'num' }, Object.keys(s.variables).length),
            );
          }),
        ),
      ),
    );
  }

  private renderSnapshotDetail(s: Snapshot): Node {
    const byName = <T extends { name: string }>(items: T[]) => items.sort((a, b) => a.name.localeCompare(b.name, getLang()));
    const changeBadge = (e: GtmEntity) =>
      e.changeStatus && e.changeStatus !== 'none'
        ? h('span', { class: `badge ${e.changeStatus === 'added' ? 'ok' : e.changeStatus === 'deleted' ? 'crit' : 'warn'}` }, e.changeStatus)
        : null;

    const entityItem = (e: GtmEntity, extra: Child[] = []) =>
      h(
        'li',
        { class: 'entity' },
        h(
          'details',
          { class: 'plain' },
          h('summary', {}, h('span', { class: 'name' }, e.name), ' ', ...extra, ' ', changeBadge(e), h('span', { class: 'type' }, this.ctl.store.templates.get(e.type) ?? e.type)),
          this.renderEntityBody(e),
        ),
      );

    const tags = byName(Object.values(s.tags));
    const triggers = byName(Object.values(s.triggers));
    const variables = byName(Object.values(s.variables));
    const changes = this.ctl.store.changesFor(s.key);

    return h(
      'section',
      {},
      h('h3', {}, s.label),
      changes?.length && s.key.startsWith('version:') ? this.renderChanges(t('versionChanges', { n: changes.length }), changes) : null,
      h(
        'details',
        { open: true },
        h('summary', {}, t('tagsCount', { n: tags.length })),
        h(
          'ul',
          { class: 'list' },
          ...tags.map((tag) =>
            entityItem(tag, [
              tag.paused ? h('span', { class: 'badge warn' }, t('paused')) : null,
              tag.consent?.status === 'needed' ? h('span', { class: 'badge ok', title: tag.consent.types.join(', ') }, 'consent') : null,
            ]),
          ),
        ),
      ),
      h('details', {}, h('summary', {}, t('triggersCount', { n: triggers.length })), h('ul', { class: 'list' }, ...triggers.map((tr) => entityItem(tr)))),
      h('details', {}, h('summary', {}, t('variablesCount', { n: variables.length })), h('ul', { class: 'list' }, ...variables.map((v) => entityItem(v)))),
    );
  }

  private renderEntityBody(e: GtmEntity): Node {
    const lines: string[] = [];
    if (e.kind === 'tag') {
      lines.push(`firing: ${e.firingTriggerIds.map((id) => this.triggerName(id)).join(', ') || '—'}`);
      if (e.blockingTriggerIds.length) lines.push(`blocking: ${e.blockingTriggerIds.map((id) => this.triggerName(id)).join(', ')}`);
      if (e.consent) lines.push(`consent: ${e.consent.status}${e.consent.types.length ? ` (${e.consent.types.join(', ')})` : ''}`);
    }
    if (e.kind === 'trigger') {
      for (const [group, conds] of Object.entries(e.filters)) {
        for (const c of conds) lines.push(`${group}: ${c.left} ${c.negate ? 'NOT ' : ''}${c.op} ${c.right}`);
      }
    }
    if (!e.paramsComplete) lines.push(t('paramsNotLoaded'));
    lines.push(...paramLines(e.parameters));
    return h('pre', { class: 'params' }, lines.join('\n'));
  }

  private triggerName(triggerId: string): string {
    const snap = this.selectedScope ? this.ctl.store.snapshots.get(this.selectedScope) : undefined;
    return snap?.triggers[triggerId]?.name ?? `#${triggerId}`;
  }

  // --- Debug -----------------------------------------------------------------

  private renderDebug(): Node[] {
    const { log } = this.ctl;
    const status = this.statusFor(this.tab);
    const urlInput = h('input', { type: 'url', placeholder: 'https://tagmanager.google.com/api/…' }) as HTMLInputElement;

    const download = () => {
      const blob = new Blob([log.toJson()], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `gtm-qa-captures-${Date.now()}.json` });
      this.root.append(a);
      a.click();
      a.remove();
      // Large dumps (several MB) need time to be written; revoking early yields a 0-byte file.
      setTimeout(() => URL.revokeObjectURL(a.href), 120_000);
    };

    const fetchManual = async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      const res = await this.ctl.fetchUrl(url);
      this.flash(status, res.error ? t('fetchError', { error: res.error }) : `HTTP ${res.status}: ${countsText(res.detected!)}`, res.ok);
    };

    const useful = log.entries.filter((e) => hasEntities(e.detected)).length;
    const entries = [...log.entries].reverse();

    return [
      h(
        'section',
        {},
        h('h3', {}, t('capturedResponses')),
        h('p', { class: 'small muted' }, t('capturedSummary', { total: log.entries.length, useful })),
        h('div', { class: 'row' }, h('button', { class: 'btn', onClick: download }, t('downloadRaw')), h('button', { class: 'btn', onClick: () => log.clear() }, t('clear'))),
      ),
      h(
        'section',
        {},
        h('h3', {}, t('manualGet')),
        h('div', { class: 'row' }, urlInput, h('button', { class: 'btn', onClick: fetchManual }, t('fetch'))),
        status,
      ),
      h(
        'section',
        {},
        ...(entries.length
          ? entries.map((e) =>
              h(
                'div',
                { class: 'capture' },
                h('div', { class: 'url' }, `${e.method} ${e.url}`),
                h(
                  'div',
                  { class: 'meta' },
                  h('span', { class: `badge ${e.status >= 400 ? 'crit' : ''}` }, String(e.status)),
                  h('span', {}, e.via),
                  h('span', {}, fmtBytes(e.size)),
                  h('span', { class: `badge ${hasEntities(e.detected) ? 'ok' : ''}` }, e.parsed ? countsText(e.detected) : t('notJson')),
                ),
              ),
            )
          : [h('div', { class: 'empty' }, t('noCaptures'))]),
      ),
    ];
  }

  // --- Settings --------------------------------------------------------------

  private async renderSettings(): Promise<Node[]> {
    const s = await loadSettings();
    const status = this.statusFor(this.tab);

    const provider = h(
      'select',
      {},
      ...(['anthropic', 'openai', 'gemini'] as LlmProvider[]).map((p) =>
        h('option', { value: p, selected: p === s.llmProvider }, { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini' }[p]),
      ),
    ) as HTMLSelectElement;
    const model = h('input', { type: 'text', value: s.llmModel }) as HTMLInputElement;
    const apiKey = h('input', { type: 'password', value: s.apiKey, autocomplete: 'off', placeholder: 'sk-…' }) as HTMLInputElement;
    const naming = h('input', { type: 'text', value: s.namingPattern }) as HTMLInputElement;
    const sgtmUrl = h('input', { type: 'url', value: s.expectedServerContainerUrl, placeholder: 'https://sgtm.example.com' }) as HTMLInputElement;
    const taxonomy = h('input', { type: 'checkbox', checked: s.namingTaxonomy }) as HTMLInputElement;
    const markersNaming = h('input', { type: 'checkbox', checked: !s.markersHideNaming }) as HTMLInputElement;
    const guide = h('input', { type: 'checkbox', checked: s.settingsGuide }) as HTMLInputElement;
    const previewAi = h('input', { type: 'checkbox', checked: s.previewAutoAi }) as HTMLInputElement;
    const exempt = h('input', { type: 'text', value: s.consentExempt.join(', ') }) as HTMLInputElement;

    const language = h(
      'select',
      {},
      ...LANGS.map((l) => h('option', { value: l.id, selected: l.id === getLang() }, l.name)),
    ) as HTMLSelectElement;
    // Same path as the header switcher: saved immediately, the whole panel re-renders.
    language.addEventListener('change', () => {
      if (isLang(language.value)) void this.changeLanguage(language.value);
    });

    provider.addEventListener('change', () => {
      model.value = DEFAULT_MODELS[provider.value as LlmProvider];
    });

    const save = async () => {
      try {
        new RegExp(naming.value);
      } catch {
        this.flash(status, t('invalidRegex'), false);
        return;
      }
      await saveSettings({
        llmProvider: provider.value as LlmProvider,
        llmModel: model.value.trim(),
        apiKey: apiKey.value.trim(),
        namingPattern: naming.value,
        expectedServerContainerUrl: sgtmUrl.value.trim(),
        namingTaxonomy: taxonomy.checked,
        markersHideNaming: !markersNaming.checked,
        settingsGuide: guide.checked,
        previewAutoAi: previewAi.checked,
        consentExempt: exempt.value.split(',').map((x) => x.trim()).filter(Boolean),
      });
      this.flash(status, t('saved'), true);
      this.overlay.refresh(); // markers depend on markersHideNaming
      this.guide.setEnabled(guide.checked);
    };

    return [
      h(
        'section',
        {},
        h('h3', {}, t('language')),
        language,
        h('p', { class: 'small muted', style: 'margin-top:4px' }, t('languageNote')),
      ),
      h(
        'section',
        {},
        h('h3', {}, t('llmModel')),
        h('label', {}, t('provider')), provider,
        h('label', {}, t('model')), model,
        h('label', {}, t('apiKey')), apiKey,
        h(
          'div',
          { class: 'note' },
          t('apiKeyNote'),
          h('br'),
          h('span', { class: 'muted' }, t('apiKeyWarning')),
        ),
      ),
      h(
        'section',
        {},
        h('h3', {}, t('agencyStandards')),
        h('label', { class: 'inline' }, taxonomy, ` ${t('taxonomy')}`),
        h('label', { class: 'inline' }, markersNaming, ` ${t('markersNaming')}`),
        h('label', { class: 'inline' }, guide, ` ${t('settingsGuide')}`),
        h('label', { class: 'inline' }, previewAi, ` ${t('previewAutoAi')}`),
        h('label', {}, t('namingPattern')), naming,
        h('label', {}, t('expectedSgtm')), sgtmUrl,
        h('label', {}, t('consentExempt')), exempt,
      ),
      h('section', {}, h('button', { class: 'btn primary', onClick: save }, t('save')), status),
      exceptionsSection(this.ctl),
    ];
  }

  /** Status line whose message survives re-renders of live tabs. */
  private statusFor(tab: TabId): HTMLElement {
    const notice = this.notices.get(tab);
    return h('div', { class: `status ${notice ? (notice.ok ? 'ok' : 'err') : ''}` }, notice?.text);
  }

  private flash(el: HTMLElement, text: string, ok: boolean): void {
    this.notices.set(this.tab, { text, ok });
    el.textContent = text;
    el.className = `status ${ok ? 'ok' : 'err'}`;
  }
}
