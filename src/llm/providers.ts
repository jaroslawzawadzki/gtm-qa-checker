// LLM calls, executed only in the service worker (the API key never reaches the GTM page).
// Anthropic goes through the official SDK; OpenAI and Gemini through their REST endpoints.
import Anthropic from '@anthropic-ai/sdk';
import { defineMessages } from '../i18n';
import type { Settings } from '../shared/storage';

const t = defineMessages({
  en: {
    noKey: 'No API key – add it in the Settings tab.',
    refused: 'The model declined to answer{category}.',
    truncated: 'Answer truncated (max_tokens).',
    empty: 'Empty model response.',
    badKey: 'Invalid {provider} API key.',
    noModel: 'Model “{model}” does not exist or is not available for this key.',
    rateLimit: '{provider} rate limit exceeded – try again in a moment.',
    badRequest: 'Invalid request: {message}',
    apiError: '{provider} API error {status}: {message}',
  },
  de: {
    noKey: 'Kein API-Schlüssel – bitte im Tab „Einstellungen“ hinterlegen.',
    refused: 'Das Modell hat die Antwort verweigert{category}.',
    truncated: 'Antwort abgeschnitten (max_tokens).',
    empty: 'Leere Antwort des Modells.',
    badKey: 'Ungültiger {provider}-API-Schlüssel.',
    noModel: 'Das Modell „{model}“ existiert nicht oder ist für diesen Schlüssel nicht verfügbar.',
    rateLimit: '{provider}-Anfragelimit überschritten – bitte gleich erneut versuchen.',
    badRequest: 'Ungültige Anfrage: {message}',
    apiError: '{provider}-API-Fehler {status}: {message}',
  },
  pl: {
    noKey: 'Brak klucza API – uzupełnij go w zakładce Ustawienia.',
    refused: 'Model odmówił odpowiedzi{category}.',
    truncated: 'Odpowiedź ucięta (max_tokens).',
    empty: 'Pusta odpowiedź modelu.',
    badKey: 'Nieprawidłowy klucz API {provider}.',
    noModel: 'Model „{model}” nie istnieje lub nie jest dostępny dla tego klucza.',
    rateLimit: 'Przekroczony limit zapytań {provider} – spróbuj za chwilę.',
    badRequest: 'Błędne zapytanie: {message}',
    apiError: 'Błąd API {provider} {status}: {message}',
  },
});

export interface LlmResult {
  text: string;
  model: string;
}

export async function complete(settings: Settings, system: string, user: string): Promise<LlmResult> {
  if (!settings.apiKey) throw new Error(t('noKey'));
  switch (settings.llmProvider) {
    case 'anthropic':
      return anthropic(settings, system, user);
    case 'openai':
      return openai(settings, system, user);
    case 'gemini':
      return gemini(settings, system, user);
  }
}

/** Models that accept output_config.effort and server-side refusal fallbacks ("default" form). */
const CURRENT_CLAUDE = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/;

async function anthropic(settings: Settings, system: string, user: string): Promise<LlmResult> {
  // The key is the user's own and stays inside the extension's service worker.
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const current = CURRENT_CLAUDE.test(settings.llmModel);
  try {
    const response = await client.beta.messages.create({
      model: settings.llmModel,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      ...(current
        ? {
            // A summary doesn't need deep reasoning; set explicitly (default differs per model).
            output_config: { effort: 'medium' as const },
            // Retry automatically on another model if a safety classifier declines.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default' as const,
          }
        : {}),
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(t('refused', { category: response.stop_details?.category ? ` (${response.stop_details.category})` : '' }));
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    if (!text) throw new Error(response.stop_reason === 'max_tokens' ? t('truncated') : t('empty'));
    return { text, model: response.model };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error(t('badKey', { provider: 'Anthropic' }));
    if (err instanceof Anthropic.NotFoundError) throw new Error(t('noModel', { model: settings.llmModel }));
    if (err instanceof Anthropic.RateLimitError) throw new Error(t('rateLimit', { provider: 'Anthropic' }));
    if (err instanceof Anthropic.BadRequestError) throw new Error(t('badRequest', { message: err.message }));
    if (err instanceof Anthropic.APIError) throw new Error(t('apiError', { provider: 'Anthropic', status: err.status ?? '', message: err.message }));
    throw err;
  }
}

/**
 * REST calls for OpenAI / Gemini: retry twice on overload (429 / 503) – these are usually short spikes.
 * The Anthropic SDK already retries on its own.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status !== 503) || i >= attempts) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * i, 10_000)));
  }
}

async function openai(settings: Settings, system: string, user: string): Promise<LlmResult> {
  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.llmModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(t('apiError', { provider: 'OpenAI', status: res.status, message: json?.error?.message ?? res.statusText }));
  const text = String(json?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error(t('empty'));
  return { text, model: json.model ?? settings.llmModel };
}

async function gemini(settings: Settings, system: string, user: string): Promise<LlmResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.llmModel)}:generateContent`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(t('apiError', { provider: 'Gemini', status: res.status, message: json?.error?.message ?? res.statusText }));
  const parts: { text?: string }[] = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('').trim();
  if (!text) throw new Error(t('empty'));
  return { text, model: settings.llmModel };
}
