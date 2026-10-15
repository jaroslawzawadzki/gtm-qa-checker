// "QA" tab: pick a scope, run the linter, browse findings by severity.
import { countSeverities, type LintResult } from '../../qa/linter';
import type { Finding, Fix, Severity } from '../../qa/rules';
import type { Bridge, SstInventory } from '../../qa/sst';
import { entityKey } from '../../qa/suppress';
import { addAiRule, addSuppression, removeException } from '../../shared/exceptions';
import type { EntityKind, ScopeKey } from '../../shared/types';
import type { Controller } from '../content';
import { h } from './dom';
import { t } from './i18n';

// Labels are resolved at render time (the language can change at runtime).
const severityLabel = (sev: Severity) => t(({ critical: 'sevCritical', warning: 'sevWarning', info: 'sevInfo' } as const)[sev]);
const severityBadge = (sev: Severity) => t(({ critical: 'badgeCritical', warning: 'badgeWarning', info: 'badgeInfo' } as const)[sev]);
const SEVERITY_CLASS: Record<Severity, string> = { critical: 'crit', warning: 'warn', info: '' };
const kindLabel = (kind: Finding['entities'][number]['kind']) =>
  t(({ tag: 'kindTagLower', trigger: 'kindTriggerLower', variable: 'kindVariableLower' } as const)[kind]);
const MAX_DETAILS = 60;

export class QaTab {
  readonly element = h('div');
  private readonly formBox = h('section');
  private readonly status = h('div', { class: 'status' });
  private readonly results = h('div');
  private scope: ScopeKey | '' = '';
  private onlyDiff = false;
  private visible: Record<Severity, boolean> = { critical: true, warning: true, info: false };
  /** Set when the user clicks a marker in GTM's list: show only that entity's findings. */
  private entityFilter: { kind: EntityKind; name: string; related: string[] } | null = null;
  private running = false;

  constructor(private readonly ctl: Controller) {
    this.element.append(this.formBox, this.results);
  }

  /** Opened from a marker in GTM's Tags/Triggers/Variables list. */
  focusEntity(kind: EntityKind, name: string, related: string[] = []): void {
    this.entityFilter = { kind, name, related };
    this.results.replaceChildren();
  }

  show(): void {
    this.renderForm();
    if (this.ctl.lastLint && !this.results.childElementCount) this.renderResult(this.ctl.lastLint);
  }

  /** After a language change: rebuilds the form and the result from ctl.lastLint. */
  /** Container switched: forget the selected scope and entity filter of the previous container. */
  resetForContainer(): void {
    this.scope = '';
    this.entityFilter = null;
    this.refresh();
  }

  refresh(): void {
    this.setStatus('');
    this.renderForm();
    if (this.ctl.lastLint) this.renderResult(this.ctl.lastLint);
    else this.results.replaceChildren();
  }

  private scopes(): { key: ScopeKey; label: string }[] {
    const { store } = this.ctl;
    const out = new Map<ScopeKey, string>();
    const ws = store.context.workspaceId;
    if (ws) out.set(`workspace:${ws}`, t('qaWsCurrent', { id: ws }));
    if (store.context.versionId) out.set(`version:${store.context.versionId}`, t('qaVersionViewed', { id: store.context.versionId }));
    for (const s of store.snapshots.values()) if (!out.has(s.key)) out.set(s.key, s.label);
    const diffTarget = this.ctl.lastDiff?.plan.target.scope;
    if (diffTarget && !out.has(diffTarget)) out.set(diffTarget, this.ctl.lastDiff!.plan.target.label);
    return [...out].map(([key, label]) => ({ key, label }));
  }

  private renderForm(): void {
    const scopes = this.scopes();
    if (!scopes.some((s) => s.key === this.scope)) this.scope = scopes[0]?.key ?? '';
    const diff = this.ctl.lastDiff;
    const diffMatches = !!diff && diff.plan.target.scope === this.scope;

    const select = h('select', {}, ...scopes.map((s) => h('option', { value: s.key, selected: s.key === this.scope }, s.label))) as HTMLSelectElement;
    select.addEventListener('change', () => ((this.scope = select.value as ScopeKey), this.renderForm()));

    const onlyDiff = h('input', { type: 'checkbox', checked: this.onlyDiff && diffMatches, disabled: !diffMatches }) as HTMLInputElement;
    onlyDiff.addEventListener('change', () => (this.onlyDiff = onlyDiff.checked));

    this.formBox.replaceChildren(
      h('h3', {}, t('qaScope')),
      scopes.length ? select : h('p', { class: 'small muted' }, t('qaNoScope')),
      h(
        'label',
        { class: 'inline', title: diffMatches ? '' : t('qaOnlyDiffTitle') },
        onlyDiff,
        diffMatches ? t('qaOnlyDiff', { n: diff!.entities.filter((e) => e.status !== 'removed').length }) : t('qaOnlyDiffDisabled'),
      ),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary', disabled: this.running || !scopes.length, onClick: () => void this.run() }, t('qaRun'))),
      this.status,
    );
  }

  /** Runs QA on the current scope (used by the launcher reminder). */
  start(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running || !this.scope) return;
    this.running = true;
    this.renderForm();
    this.setStatus(t('loadingData'));
    try {
      const diff = this.ctl.lastDiff;
      const result = await this.ctl.runQa(
        { scope: this.scope, onlyChangedIn: this.onlyDiff && diff?.plan.target.scope === this.scope ? diff : undefined },
        (p) => this.setStatus(`${p.label}${p.total ? ` – ${p.done}/${p.total}` : '…'}`),
      );
      this.setStatus(t('qaChecked', { tags: result.checked.tag, triggers: result.checked.trigger, variables: result.checked.variable }), true);
      this.renderResult(result);
    } catch (err) {
      this.setStatus((err as Error).message, false);
      this.results.replaceChildren();
      this.ctl.lastLint = null;
    } finally {
      this.running = false;
      this.renderForm();
    }
  }

  private setStatus(text: string, ok?: boolean): void {
    this.status.textContent = text;
    this.status.className = `status${ok === undefined ? '' : ok ? ' ok' : ' err'}`;
  }

  private renderResult(r: LintResult): void {
    // With an element filter (marker clicked in GTM) the tiles count only that element's findings
    // and show every severity; otherwise they count the whole result and double as visibility toggles.
    const filter = this.entityFilter;
    const matching = filter
      ? r.findings.filter((f) => f.entities.some((e) => (e.kind === filter.kind && e.name === filter.name) || filter.related.includes(`${e.kind}:${e.name}`)))
      : r.findings;
    const counts = filter ? countSeverities(matching) : r.counts;
    const toggle = (sev: Severity) => {
      const box = h('input', { type: 'checkbox', checked: this.visible[sev], disabled: !!filter }) as HTMLInputElement;
      box.addEventListener('change', () => ((this.visible[sev] = box.checked), this.renderResult(r)));
      return h(
        'label',
        { class: `tile ${sev}${filter || this.visible[sev] ? '' : ' off'}` },
        box,
        h('span', { class: 'count' }, counts[sev]),
        h('span', { class: 'label' }, severityLabel(sev)),
      );
    };

    const nodes: Node[] = [
      h(
        'section',
        {},
        h('h3', {}, t('qaResult', { scope: r.scopeLabel })),
        r.limitedTo !== undefined ? h('p', { class: 'small muted' }, t('qaLimited', { n: r.limitedTo })) : null,
        ...r.warnings.map((w) => h('p', { class: 'small' }, h('span', { class: 'badge warn' }, t('warningBadge')), ' ', w)),
        h('div', { class: 'tiles' }, toggle('critical'), toggle('warning'), toggle('info')),
      ),
    ];
    if (r.sst) nodes.push(this.renderSst(r.sst));
    const shown = filter ? matching : r.findings.filter((f) => this.visible[f.severity]);
    if (filter) {
      nodes.push(
        h(
          'div',
          { class: 'filter-bar' },
          h('span', {}, t('filterEntity'), ' ', h('span', { class: 'chip' }, filter.name), filter.related.length ? ` ${t('filterRelated', { n: filter.related.length })}` : ''),
          h('button', { class: 'link-btn', onClick: () => ((this.entityFilter = null), this.renderResult(r)) }, t('clearFilter')),
        ),
      );
    }
    if (!r.findings.length) nodes.push(h('div', { class: 'empty' }, t('qaNoFindings')));
    else if (!shown.length) nodes.push(h('div', { class: 'empty' }, t('qaAllHidden')));
    nodes.push(h('section', { class: 'plain' }, ...shown.map((f) => this.renderFinding(f))));
    const hidden = this.renderHidden(r);
    if (hidden) nodes.push(hidden);
    this.results.replaceChildren(...nodes);
  }

  /** What is sent to the server container, grouped by bridge (GA4 / Data Tag / other). */
  private renderSst(sst: SstInventory): Node {
    // Known bridges first, then the "other templates" group (any remaining Bridge value).
    const isOther = (b: Bridge) => b !== 'GA4' && b !== 'Data Tag';
    const bridges = [...new Set<Bridge>(['GA4', 'Data Tag', ...sst.routes.map((r) => r.bridge)])];
    return h(
      'section',
      {},
      h(
        'details',
        {},
        h('summary', {}, t('sstRouting', { hosts: sst.hosts.join(', '), n: sst.routes.length })),
        ...bridges
          .map((b) => [b, sst.routes.filter((r) => r.bridge === b)] as const)
          .filter(([, routes]) => routes.length)
          .map(([bridge, routes]) =>
            h(
              'div',
              {},
              h('h3', { style: 'margin-top:10px' }, isOther(bridge) ? t('sstOtherTemplates') : `${bridge} Bridge`),
              h(
                'table',
                { class: 'fields' },
                h('thead', {}, h('tr', {}, h('th', {}, t('kindTag')), h('th', {}, t('sstEvent')), h('th', {}, t('sstData')))),
                h(
                  'tbody',
                  {},
                  ...routes.map((r) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, r.tag.name, r.via ? h('div', { class: 'small muted' }, t('sstVia', { via: r.via })) : null, isOther(bridge) ? h('div', { class: 'small muted' }, r.template) : null),
                      h('td', { class: 'small' }, r.events.join(', ') || '—'),
                      h(
                        'td',
                        { class: 'small' },
                        r.fields.join(', ') || '—',
                        r.userData.length ? h('div', {}, h('span', { class: 'badge' }, 'user_data'), ` ${r.userData.join(', ')}`) : null,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ),
    );
  }

  /** "Not an error" form: stores a suppression for this finding's rule + entities. */
  private exceptionForm(f: Finding): HTMLElement {
    const { context } = this.ctl.store;
    const scope = h(
      'select',
      {},
      h('option', { value: 'container' }, t('excThisContainer', { id: context.publicId ?? context.containerId ?? '?' })),
      h('option', { value: 'all' }, t('allContainers')),
    ) as HTMLSelectElement;
    const reason = h('textarea', { rows: 2, placeholder: t('excReasonPlaceholder') }) as HTMLTextAreaElement;
    // The reason also becomes an AI rule, so later summaries stop flagging the same situation.
    const teach = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const form = h(
      'div',
      { class: 'exception-form', hidden: true },
      h('label', {}, t('excReason')),
      reason,
      h('label', { class: 'inline', style: 'margin-top:6px' }, teach, ` ${t('excTeach')}`),
      h('label', {}, t('excScope')),
      scope,
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        h(
          'button',
          {
            class: 'btn primary small',
            onClick: async () => {
              await addSuppression({
                rule: f.rule,
                findingKey: f.key,
                entities: f.entities.map(entityKey),
                containerId: scope.value === 'container' ? context.containerId : undefined,
                publicId: scope.value === 'container' ? context.publicId : undefined,
                title: f.title,
                reason: reason.value.trim() || undefined,
              });
              const why = reason.value.trim();
              const taught =
                teach.checked &&
                !!why &&
                (await addAiRule(
                  t('aiRuleFromException', {
                    finding: f.title.replace(/\s*\(\d+(\/\d+)?\)/g, ''),
                    elements: f.entities.slice(0, 3).map((e) => e.name).join(', ') + (f.entities.length > 3 ? ' …' : ''),
                    reason: why,
                  }),
                ));
              await this.ctl.reapplyExceptions();
              if (this.ctl.lastLint) this.renderResult(this.ctl.lastLint);
              this.setStatus(taught ? t('excSavedTaught') : t('excSaved'), true);
            },
          },
          t('excSave'),
        ),
      ),
    );
    return form;
  }

  /** Findings hidden by exceptions, with the option to restore them. */
  private renderHidden(r: LintResult): Node | null {
    if (!r.hidden.length) return null;
    return h(
      'section',
      {},
      h(
        'details',
        {},
        h('summary', {}, t('qaHidden', { n: r.hidden.length })),
        h(
          'ul',
          { class: 'list' },
          ...r.hidden.map(({ finding, suppressions }) =>
            h(
              'li',
              {},
              h(
                'span',
                { class: 'name' },
                finding.title,
                h(
                  'div',
                  { class: 'small muted' },
                  suppressions
                    .map((s) => `${s.containerId ? t('ctxContainer', { id: s.publicId ?? s.containerId }) : t('allContainers')}${s.reason ? ` – ${s.reason}` : ''}`)
                    .join('; '),
                ),
              ),
              h(
                'button',
                {
                  class: 'btn small',
                  onClick: async () => {
                    for (const s of suppressions) await removeException('suppression', s.id);
                    await this.ctl.reapplyExceptions();
                    if (this.ctl.lastLint) this.renderResult(this.ctl.lastLint);
                  },
                },
                t('restore'),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /** Fixes for elements still in the finding (exceptions may remove some); with a GTM marker filter only that element's. */
  private fixesFor(f: Finding): Fix[] {
    const filter = this.entityFilter;
    return (f.fixes ?? []).filter(
      (x) =>
        f.entities.some((e) => e.kind === x.entity.kind && e.id === x.entity.id) &&
        (!filter || (x.entity.kind === filter.kind && x.entity.name === filter.name) || filter.related.includes(`${x.entity.kind}:${x.entity.name}`)),
    );
  }

  private renderFixes(fixes: Fix[]): Node {
    const copyBtn = (text: string) => {
      const btn = h('button', { class: 'btn small' }, t('fixCopy')) as HTMLButtonElement;
      btn.addEventListener('click', () =>
        void navigator.clipboard.writeText(text).then(() => {
          btn.textContent = t('fixCopied');
          setTimeout(() => (btn.textContent = t('fixCopy')), 1500);
        }),
      );
      return btn;
    };
    return h(
      'div',
      { class: 'fixes' },
      h('div', { class: 'fixes-title' }, '🛠 ', t('fixTitle')),
      h('p', { class: 'small muted' }, t('fixSteps')),
      ...fixes.slice(0, MAX_DETAILS).map((x) =>
        h(
          'div',
          { class: 'fix' },
          h(
            'div',
            { class: 'fix-names' },
            h('span', { class: 'fix-old', title: kindLabel(x.entity.kind) }, x.entity.name),
            h('span', { class: 'fix-arrow' }, '→'),
            h('code', { class: 'fix-new' }, x.suggestion),
          ),
          copyBtn(x.suggestion),
          h('div', { class: 'fix-reason' }, x.reason),
        ),
      ),
      fixes.length > MAX_DETAILS ? h('p', { class: 'small muted' }, t('fixMore', { n: fixes.length - MAX_DETAILS })) : null,
    );
  }

  private renderFinding(f: Finding): Node {
    const details = f.details.length > MAX_DETAILS ? [...f.details.slice(0, MAX_DETAILS), t('moreDetails', { n: f.details.length - MAX_DETAILS })] : f.details;
    const form = this.exceptionForm(f);
    const fixes = this.fixesFor(f);
    return h(
      'details',
      { class: `finding ${f.severity}`, open: f.severity === 'critical' || (!!this.entityFilter && fixes.length > 0) },
      h('summary', {}, h('span', { class: `badge ${SEVERITY_CLASS[f.severity]}` }, severityBadge(f.severity)), ' ', h('span', { class: 'name' }, f.title)),
      h('p', { class: 'small' }, f.message),
      f.entities.length <= 12
        ? h('div', { class: 'chips' }, ...f.entities.map((e) => h('span', { class: 'chip', title: kindLabel(e.kind) }, e.name)))
        : null,
      fixes.length ? this.renderFixes(fixes) : details.length ? h('pre', { class: 'params' }, details.join('\n')) : null,
      h('button', { class: 'btn small', onClick: () => ((form.hidden = !form.hidden), form.hidden || form.querySelector('textarea')?.focus()) }, t('notAnError')),
      form,
    );
  }
}
