/**
 * Shared stubs for the SDK-level specs (not a spec itself). Node has no DOM,
 * no localStorage and a real fetch; these give the SDK just enough of each.
 */

export interface RecordedRequest {
  url: string;
  init: any;
  body: any;
  path: string;
}

export type Responder = (req: RecordedRequest) => { status: number; body?: any; headers?: Record<string, string> };

/** Install a Map-backed localStorage (shared across SDK instances, like a real browser). */
export function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  return map;
}

export function uninstallLocalStorage(): void {
  delete (globalThis as any).localStorage;
}

/** Replace global fetch; every call is recorded. Default answer: 200 { success: true }. */
export function installFetch(responder?: Responder): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  (globalThis as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    let body: any;
    try {
      body = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init.body;
    }
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const req: RecordedRequest = { url: String(url), init, body, path };
    calls.push(req);
    const res = responder ? responder(req) : { status: 200, body: defaultBody(path, body) };
    const headers = { 'content-type': 'application/json', ...(res.headers || {}) };
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: `HTTP ${res.status}`,
      headers: { get: (k: string) => (headers as any)[k.toLowerCase()] ?? null },
      json: async () => res.body,
      text: async () => JSON.stringify(res.body),
      clone() {
        return this;
      },
    };
  });
  return calls;
}

function defaultBody(path: string, body: any): any {
  if (path.endsWith('/v1/track/batch')) {
    return { success: true, processed: body?.events?.length ?? 0, ...(body?.identify ? { identified: true } : {}) };
  }
  if (path.endsWith('/v1/in-app/sync')) return { success: true, campaigns: [], evaluatedAt: new Date().toISOString() };
  return { success: true };
}

export const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Wait until `pred` holds (polling), or fail after `timeoutMs`. */
export async function waitFor(pred: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await settle(10);
  }
}

export const BASE_CONFIG = {
  sdkKey: 'jry_sdk_test',
  apiEndpoint: 'https://api.example/api',
  trackPageViews: false,
  persistQueue: false,
  maxRetries: 0,
  retryBackoffMs: 10,
  inApp: { enabled: false },
};

/** A tiny DOM: enough for the in-app renderer to build and mount a message. */
export function installFakeDocument(): { mounted: any[] } {
  const mounted: any[] = [];
  const byId = new Map<string, any>();
  const make = (tag: string): any => {
    const el: any = {
      tagName: tag.toUpperCase(),
      children: [] as any[],
      style: { setProperty() {} },
      dataset: {},
      _id: '',
      get id() {
        return this._id;
      },
      set id(v: string) {
        this._id = v;
        byId.set(v, el);
      },
      className: '',
      textContent: '',
      innerHTML: '',
      setAttribute() {},
      getAttribute() {
        return null;
      },
      addEventListener(type: string, fn: () => void) {
        el['on_' + type] = fn;
      },
      appendChild(child: any) {
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      remove() {
        if (el._id) byId.delete(el._id);
        const i = mounted.indexOf(el);
        if (i >= 0) mounted.splice(i, 1);
      },
    };
    return el;
  };
  const root = make('html');
  root.appendChild = (child: any) => {
    mounted.push(child);
    return child;
  };
  (globalThis as any).document = {
    createElement: make,
    documentElement: root,
    body: root,
    hidden: false,
    getElementById: (id: string) => byId.get(id) || null,
  };
  return { mounted };
}

export function uninstallFakeDocument(): void {
  delete (globalThis as any).document;
}
