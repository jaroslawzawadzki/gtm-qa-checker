// "Report" tab: Markdown report from the last diff + QA run, editable before copying.
import { buildLlmPayload } from '../../llm/payload';
import { buildReport, DEFAULT_REPORT_OPTIONS, type ReportOptions } from '../../report/markdown';
import { addAiRule } from '../../shared/exceptions';
import type { LlmResponse, RuntimeMsg } from '../../shared/messages';
import { loadSettings } from '../../shared/storage';
import type { DiffResult } from '../../diff/diffEngine';
import type { Controller } from '../content';
import type { Progress } from '../loader';
import { h } from './dom';
import { t } from './i18n';

export class ReportTab {
  readonly element = h('div');
  private readonly status = h('div', { class: 'status' });
  private readonly editor = h('textarea', { class: 'report', spellcheck: 'false' }) as HTMLTextAreaElement;
  private options: ReportOptions = { ...DEFAULT_REPORT_OPTIONS };
  private aiSummary = '';
  private running = false;
  /** Results produced by the one-click flow (anything else in ctl.lastDiff/lastLint was made by hand). */
  private autoDiff: DiffResult | null = null;
  private autoLint: Controller['lastLint'] = null;
  /** Containers a report was generated for in this tab (the publish reminder skips them). */
  readonly reportedContainers = new Set<string>();

  constructor(private readonly ctl: Controller) {}

  /**
   * One-click report: compares the user's changes (unsaved workspace changes, otherwise the latest
   * publication), runs QA on the changed elements, builds the report and copies it to the clipboard.
   */
  async quickReport(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.show();
    const { store } = this.ctl;
    const ctx = store.context;
    const progress = (label: string) => (p: Progress) => this.setStatus(`${label}: ${p.label}${p.total ? ` – ${p.done}/${p.total}` : '…'}`);
    try {
      if (!ctx.containerId) throw new Error(t('qrNoContainer'));
      this.setStatus(`${t('qrDiff')}…`);
      let diff: DiffResult | null = null;
      if (ctx.workspaceId) diff = await this.ctl.runDiff({ mode: 'workspace', workspaceId: ctx.workspaceId }, progress(t('qrDiff')));
      if (!diff?.entities.length) {
        // Nothing unsaved: the work was already published – report the latest publication.
        const versions = [...store.versionHeaders.values()].filter((v) => !v.deleted).sort((a, b) => Number(b.versionId) - Number(a.versionId));
        if (versions.length >= 2) {
          diff = await this.ctl.runDiff({ mode: 'range', fromVersionId: versions[1].versionId, toVersionId: versions[0].versionId }, progress(t('qrDiff')));
        }
      }
      const scope = diff?.plan.target.scope;
      if (!diff || !scope) throw new Error(t('qrNothing'));
      this.setStatus(`${t('qrQa')}…`);
      this.autoDiff = diff;
      this.autoLint = await this.ctl.runQa({ scope, onlyChangedIn: diff.entities.length ? diff : undefined }, progress(t('qrQa')));
      this.show();
      await this.generate();
      const copied = await this.tryCopy();
      this.setStatus(copied ? t('qrCopied') : t('qrReadyCopy'), copied);
    } catch (err) {
      this.setStatus((err as Error).message, false);
    } finally {
      this.running = false;
      // Re-enable the button; the status line and editor are reused nodes, so their content stays.
      this.show();
    }
  }

  /** After a language change: the generated report and AI summary are in the old language. */
  refresh(): void {
    const hadReport = !!this.editor.value || !!this.aiSummary;
    this.aiSummary = '';
    this.editor.value = '';
    this.setStatus('');
    this.show();
    if (hadReport) this.setStatus(t('reportLangChanged'));
  }

  show(): void {
    const { lastDiff: diff, lastLint: lint } = this.ctl;
    const option = (key: 'includeInfo' | 'includeChangeList', label: string) => {
      const box = h('input', { type: 'checkbox', checked: this.options[key] }) as HTMLInputElement;
      box.addEventListener('change', () => (this.options[key] = box.checked));
      return h('label', { class: 'inline' }, box, ` ${label}`);
    };

    // Results the user produced by hand in the Diff / QA tabs (not by the one-click flow).
    const manual = (!!diff && diff !== this.autoDiff) || (!!lint && lint !== this.autoLint);
    const sources = [
      diff && `${t('reportComparison')}: ${diff.plan.base.label} → ${diff.plan.target.label}`,
      lint && `QA: ${lint.scopeLabel} – ${lint.counts.critical}/${lint.counts.warning}/${lint.counts.info}`,
    ].filter(Boolean) as string[];

    this.element.replaceChildren(
      // One entry point: the one-click report.
      h(
        'section',
        { class: 'quick-report' },
        h('h3', {}, t('quickTitle')),
        h('p', { class: 'small muted' }, t('quickDesc')),
        h('button', { class: 'btn primary', disabled: this.running, onClick: () => void this.quickReport() }, t('quickButton')),
        manual
          ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'link-btn', disabled: this.running, onClick: () => void this.generate() }, t('useCurrent')))
          : null,
        this.status,
        h('details', { class: 'plain options' }, h('summary', { class: 'small' }, t('reportOptions')), option('includeChangeList', t('optChangeList')), option('includeInfo', t('optInfo'))),
      ),
      // Report tools appear once there is a report.
      ...(this.editor.value
        ? [h(
            'section',
            {},
            h('h3', {}, t('reportOutput')),
            sources.length ? h('p', { class: 'small muted' }, sources.join(' · ')) : null,
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'btn primary small', onClick: () => void this.copy() }, t('copy')),
              h('button', { class: 'btn small', onClick: () => this.download() }, t('downloadMd')),
              h('button', { class: 'btn small', disabled: !diff && !lint, onClick: (e: Event) => void this.summarize(e.currentTarget as HTMLButtonElement) }, t('aiSummary')),
              h('button', { class: 'btn small', title: t('selToRuleTitle'), onClick: () => void this.selectionToRule() }, t('selToRule')),
            ),
            h('div', { style: 'margin-top:10px' }, this.editor),
            diff || lint
              ? h(
                  'details',
                  { style: 'margin-top:8px' },
                  h('summary', { class: 'small' }, t('payloadPreview')),
                  h('p', { class: 'small muted' }, t('payloadNote')),
                  h('pre', { class: 'params' }, this.payloadJson()),
                )
              : null,
          )]
        : []),
    );
  }

  private async generate(): Promise<void> {
    const { store, lastDiff: diff, lastLint: lint } = this.ctl;
    const scope = diff?.plan.target.scope ?? lint?.scope;
    this.editor.value = buildReport({
      context: store.context,
      diff,
      lint,
      snapshot: scope ? store.snapshots.get(scope) ?? null : null,
      templates: store.templates,
      settings: await loadSettings(),
      aiSummary: this.aiSummary,
      options: this.options,
    });
    if (store.context.containerId) this.reportedContainers.add(store.context.containerId);
    this.show(); // reveals the report tools and editor
    this.setStatus(t('reportReady', { n: this.editor.value.length }), true);
  }

  private payloadJson(): string {
    const { store, lastDiff, lastLint } = this.ctl;
    return JSON.stringify(buildLlmPayload(store.context, lastDiff, lastLint, store.templates), null, 1);
  }

  /** Asks the configured LLM (via the service worker) for a business summary, then rebuilds the report. */
  private async summarize(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const settings = await loadSettings();
    this.setStatus(t('summarizing', { provider: settings.llmProvider, model: settings.llmModel }));
    try {
      const response: LlmResponse = await chrome.runtime.sendMessage({ type: 'llm:summarize', input: this.payloadJson() } satisfies RuntimeMsg);
      if (!response?.ok) throw new Error(response?.error ?? t('noSwResponse'));
      this.aiSummary = response.text;
      await this.generate();
      this.setStatus(t('summaryAdded', { model: response.model }), true);
    } catch (err) {
      this.setStatus((err as Error).message, false);
    } finally {
      button.disabled = false;
    }
  }

  /** Turns a selected fragment of the AI summary into an agency rule for future summaries. */
  private async selectionToRule(): Promise<void> {
    const selected = this.editor.value.slice(this.editor.selectionStart, this.editor.selectionEnd).trim();
    if (!selected) {
      this.setStatus(t('selectFragment'), false);
      return;
    }
    const text = window.prompt(t('rulePrompt'), selected.replace(/^[\s*\-\d.]+/, ''));
    if (!text?.trim()) return;
    const added = await addAiRule(text);
    this.setStatus(added ? t('ruleAdded') : t('ruleExists'), added);
  }

  private async copy(): Promise<void> {
    if (!this.editor.value) await this.generate();
    const copied = await this.tryCopy();
    this.setStatus(copied ? t('copied') : t('qrReadyCopy'), copied);
  }

  /** Clipboard API first; selection copy as fallback. Both can fail once the click's user activation expired. */
  private async tryCopy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.editor.value);
      return true;
    } catch {
      this.editor.select();
      return document.execCommand('copy');
    }
  }

  private download(): void {
    if (!this.editor.value) return;
    const blob = new Blob([this.editor.value], { type: 'text/markdown' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${t('reportFilePrefix')}-${this.ctl.store.context.publicId ?? t('containerFallback')}-${new Date().toISOString().slice(0, 10)}.md` });
    this.element.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120_000);
  }

  private setStatus(text: string, ok?: boolean): void {
    this.status.textContent = text;
    this.status.className = `status${ok === undefined ? '' : ok ? ' ok' : ' err'}`;
  }
}
