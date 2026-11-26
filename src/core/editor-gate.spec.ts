/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes?joryio_editor=1"}
 */
import { EditorGate, editorBundleUrls, editorRequested, EDITOR_GLOBAL, EDITOR_MESSAGES, EDITOR_API_VERSION } from './editor-gate';
import { SDK_VERSION } from './config';

/**
 * The editor's door in the core bundle (D444 Phase 4 follow-up): the
 * handshake (no credential in the URL, origin-checked postMessage, the token
 * vouched for by the server) and the rule that the editor bundle is loaded
 * ONLY after that - never for an ordinary visitor.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const DASHBOARD = 'https://app-eu1.joryio.com';
let posted: Array<{ msg: any; origin: string }>;
let opener: any;
let verify: (token: string) => any;
let loaded: string[];
let started: any[];

const fakeBundle = (src: string) => {
  loaded.push(src);
  (window as any)[EDITOR_GLOBAL] = {
    version: EDITOR_API_VERSION,
    start: (ctx: any) => {
      started.push(ctx);
      return { stop: jest.fn() };
    },
  };
  return Promise.resolve();
};

beforeEach(() => {
  delete (window as any)[EDITOR_GLOBAL];
  posted = [];
  loaded = [];
  started = [];
  opener = { postMessage: (msg: any, origin: string) => posted.push({ msg, origin }) };
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
  verify = () => ({ valid: true, dashboardOrigin: DASHBOARD });
  (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => ({ ok: true, status: 200, json: async () => verify(JSON.parse(init.body).token) }));
});

const deliver = async (data: any, origin: string, source: any = opener) => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('the editor gate', () => {
  it('starts only with the flag and an opener, and says ready without any secret', () => {
    expect(editorRequested()).toBe(true);
    const gate = new EditorGate('https://api.example/api', 'jry_sdk', logger, { load: fakeBundle });
    gate.start();
    expect(posted).toEqual([{ msg: { type: EDITOR_MESSAGES.READY }, origin: '*' }]);
    expect(loaded).toEqual([]);
    gate.stop();
  });

  it('without an opener nothing happens', () => {
    Object.defineProperty(window, 'opener', { configurable: true, value: null });
    expect(editorRequested()).toBe(false);
    const gate = new EditorGate('https://api.example/api', 'jry_sdk', logger, { load: fakeBundle });
    gate.start();
    expect(posted).toEqual([]);
  });

  it('loads the editor bundle only for a token the server vouched for, from the dashboard origin it names', async () => {
    const gate = new EditorGate('https://api.example/api', 'jry_sdk', logger, { load: fakeBundle });
    gate.start();
    await deliver({ type: EDITOR_MESSAGES.TOKEN, token: 't' }, 'https://evil.example');
    expect(loaded).toEqual([]); // verified, but the message came from another origin
    await deliver({ type: EDITOR_MESSAGES.TOKEN, token: 't' }, DASHBOARD, {});
    expect(loaded).toEqual([]); // not the opener window
    verify = () => ({ valid: false });
    await deliver({ type: EDITOR_MESSAGES.TOKEN, token: 't' }, DASHBOARD);
    expect(loaded).toEqual([]);
    verify = () => ({ valid: true, dashboardOrigin: DASHBOARD });
    await deliver({ type: EDITOR_MESSAGES.TOKEN, token: 't' }, DASHBOARD);
    expect((globalThis as any).fetch.mock.calls.at(-1)[0]).toBe('https://api.example/api/v1/in-app/editor/verify');
    expect(loaded).toEqual([`https://sdk.joryio.com/web/${SDK_VERSION}/joryio-editor.min.js`]);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ dashboardOrigin: DASHBOARD, opener });
    expect(gate.isActive()).toBe(true);
    gate.stop();
    expect(gate.isActive()).toBe(false);
  });

  it('falls back to the major channel, and refuses a bundle of another contract version', async () => {
    const failFirst = (src: string) => (loaded.length === 0 ? (loaded.push(src), Promise.reject(new Error('404'))) : fakeBundle(src));
    const gate = new EditorGate('https://api.example/api', 'jry_sdk', logger, { load: failFirst });
    gate.start();
    await deliver({ type: EDITOR_MESSAGES.TOKEN, token: 't' }, DASHBOARD);
    expect(loaded).toEqual(editorBundleUrls());
    expect(loaded[1]).toBe(`https://sdk.joryio.com/web/${SDK_VERSION.split('.')[0]}/joryio-editor.min.js`);
    expect(gate.isActive()).toBe(true);

    delete (window as any)[EDITOR_GLOBAL];
    const wrongVersion = (src: string) => {
      loaded.push(src);
      (window as any)[EDITOR_GLOBAL] = { version: 99, start: () => ({ stop() {} }) };
      return Promise.resolve();
    };
    const gate2 = new EditorGate('https://api.example/api', 'jry_sdk', logger, { load: wrongVersion });
    gate2.start();
    await deliver({ type: EDITOR_MESSAGES.TOKEN, token: 't' }, DASHBOARD);
    expect(gate2.isActive()).toBe(false);
  });

  it('a self-hosted SDK names its own editor file', () => {
    expect(editorBundleUrls('https://cdn.shop.example/joryio-editor.min.js')).toEqual(['https://cdn.shop.example/joryio-editor.min.js']);
  });
});
