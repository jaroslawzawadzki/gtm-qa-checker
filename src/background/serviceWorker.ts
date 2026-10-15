// MV3 service worker: toggles the panel and runs LLM calls (host_permissions bypass CORS here,
// and the API key read from chrome.storage never enters the GTM page context).
import { setLang } from '../i18n';
import { complete } from '../llm/providers';
import { buildPreviewPrompt, buildSystemPrompt } from '../llm/prompt';
import { loadExceptions } from '../shared/exceptions';
import type { LlmResponse, RuntimeMsg } from '../shared/messages';
import { loadSettings } from '../shared/storage';

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined || !/^https:\/\/(tagmanager|tagassistant)\.google\.com\//.test(tab.url ?? '')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'panel:toggle' } satisfies RuntimeMsg).catch(() => {
    // Content script not present yet (tab opened before install): a page reload fixes it.
  });
});

chrome.runtime.onMessage.addListener((msg: RuntimeMsg, _sender, sendResponse: (r: LlmResponse | { ok: true }) => void) => {
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'llm:summarize' || msg.type === 'llm:preview') {
    Promise.all([loadSettings(), loadExceptions()])
      .then(([settings, exceptions]) => {
        // Error messages and the answer follow the user's language.
        setLang(settings.language);
        const rules = exceptions.aiRules.map((r) => r.text);
        const system = msg.type === 'llm:preview' ? buildPreviewPrompt(settings.language, rules) : buildSystemPrompt(settings.language, rules);
        return complete(settings, system, msg.input);
      })
      .then((r) => sendResponse({ ok: true, text: r.text, model: r.model }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  }
  return false;
});
