// Runs in the page's MAIN world at document_start.
// Observes GTM UI network traffic (fetch + XHR) and forwards raw response text to content.js.
// It does no parsing: all knowledge of GTM payload formats lives in gtmApiAdapter.ts.
import {
  CHANNEL,
  isChannelMsg,
  type CaptureMsg,
  type CaptureVia,
  type FetchResultMsg,
  type ToContentMsg,
  type ToInjectedMsg,
} from '../shared/messages';

const MAX_TEXT = 20_000_000;
const MAX_QUEUE = 300;

const SKIP_PATH = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)|\/static\//i;
const SKIP_HOST = /(^|\.)(google-analytics\.com|googletagmanager\.com|gstatic\.com|doubleclick\.net)$|^play\.google\.com$|^ogs\.google\.com$/i;
const SKIP_CONTENT_TYPE = /^(image|font|audio|video)\/|text\/css|javascript/i;

const origFetch = window.fetch.bind(window);

// Request headers seen on GTM API calls (e.g. XSRF / X-* client headers), per host.
// Kept only in page memory and reused for read-only GETs to the same host; never forwarded.
const replayHeaders = new Map<string, Record<string, string>>();
const observedHosts = new Set<string>([location.host]);

let contentReady = false;
const queue: ToContentMsg[] = [];

function post(msg: ToContentMsg): void {
  if (!contentReady && msg.type !== 'ready') {
    if (queue.length < MAX_QUEUE) queue.push(msg);
    return;
  }
  window.postMessage(msg, location.origin);
}

function toUrl(raw: string): URL | null {
  try {
    return new URL(raw, location.href);
  } catch {
    return null;
  }
}

function shouldCapture(raw: string): boolean {
  const url = toUrl(raw);
  if (!url || !/^https?:$/.test(url.protocol)) return false;
  if (SKIP_HOST.test(url.hostname) || SKIP_PATH.test(url.pathname)) return false;
  return url.host === location.host || /\.google(apis)?\.com$/.test(url.hostname);
}

function rememberHeaders(raw: string, headers: Record<string, string>): void {
  const url = toUrl(raw);
  if (!url) return;
  observedHosts.add(url.host);
  const keep: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^x-|^authorization$/i.test(name)) keep[name] = value;
  }
  if (Object.keys(keep).length) {
    replayHeaders.set(url.host, { ...replayHeaders.get(url.host), ...keep });
  }
}

function headersToObject(init?: HeadersInit): Record<string, string> {
  if (!init) return {};
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, name) => (out[name] = value));
  return out;
}

function emitCapture(url: string, method: string, status: number, via: CaptureVia, text: string): void {
  if (!text || text.length > MAX_TEXT) return;
  const msg: CaptureMsg = {
    channel: CHANNEL,
    dir: 'toContent',
    type: 'capture',
    url: toUrl(url)?.href ?? url,
    method: method.toUpperCase(),
    status,
    via,
    text,
    ts: Date.now(),
  };
  post(msg);
}

// --- fetch ---------------------------------------------------------------

window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await origFetch(input, init);
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const contentType = response.headers.get('content-type') ?? '';
    if (shouldCapture(url) && !SKIP_CONTENT_TYPE.test(contentType)) {
      rememberHeaders(url, headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
      response
        .clone()
        .text()
        .then((text) => emitCapture(url, method, response.status, 'fetch', text))
        .catch(() => undefined);
    }
  } catch {
    // Never break the GTM UI because of the observer.
  }
  return response;
};

// --- XMLHttpRequest ------------------------------------------------------

interface XhrMeta {
  method: string;
  url: string;
  headers: Record<string, string>;
}
const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();
const proto = XMLHttpRequest.prototype;
const origOpen = proto.open;
const origSend = proto.send;
const origSetRequestHeader = proto.setRequestHeader;

proto.open = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]) {
  xhrMeta.set(this, { method: String(args[0] ?? 'GET'), url: String(args[1] ?? ''), headers: {} });
  return (origOpen as (...a: unknown[]) => void).apply(this, args);
} as typeof proto.open;

proto.setRequestHeader = function patchedSetRequestHeader(this: XMLHttpRequest, name: string, value: string) {
  const meta = xhrMeta.get(this);
  if (meta) meta.headers[name] = value;
  return origSetRequestHeader.call(this, name, value);
};

proto.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const meta = xhrMeta.get(this);
  if (meta && shouldCapture(meta.url)) {
    rememberHeaders(meta.url, meta.headers);
    this.addEventListener('loadend', () => {
      try {
        if (SKIP_CONTENT_TYPE.test(this.getResponseHeader('content-type') ?? '')) return;
        let text: string | null = null;
        if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
        else if (this.responseType === 'json') text = JSON.stringify(this.response);
        if (text) emitCapture(meta.url, meta.method, this.status, 'xhr', text);
      } catch {
        // ignore
      }
    });
  }
  return origSend.call(this, body);
};

// --- requests from content.js ----------------------------------------------

async function handleFetchRequest(id: string, rawUrl: string): Promise<void> {
  const url = toUrl(rawUrl);
  const reply = (partial: Omit<FetchResultMsg, 'channel' | 'dir' | 'type' | 'id' | 'url'>) =>
    post({ channel: CHANNEL, dir: 'toContent', type: 'fetchResult', id, url: url?.href ?? rawUrl, ...partial });

  if (!url || url.protocol !== 'https:' || !observedHosts.has(url.host)) {
    reply({ ok: false, status: 0, error: 'URL poza dozwolonymi hostami (tylko hosty widziane w ruchu GTM).' });
    return;
  }
  try {
    const res = await origFetch(url.href, {
      method: 'GET',
      credentials: 'include',
      headers: replayHeaders.get(url.host) ?? {},
    });
    const text = await res.text();
    reply({ ok: res.ok, status: res.status, text: text.length > MAX_TEXT ? undefined : text });
  } catch (err) {
    reply({ ok: false, status: 0, error: String(err) });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || !isChannelMsg<ToInjectedMsg>(event.data, 'toInjected')) return;
  const msg = event.data;
  if (msg.type === 'hello') {
    if (!contentReady) {
      contentReady = true;
      post({ channel: CHANNEL, dir: 'toContent', type: 'ready' });
      queue.splice(0).forEach(post);
    }
  } else if (msg.type === 'fetch') {
    void handleFetchRequest(msg.id, msg.url);
  }
});

// content.js may already be listening; announce ourselves so it sends "hello".
post({ channel: CHANNEL, dir: 'toContent', type: 'ready' });
