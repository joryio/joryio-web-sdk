import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { installSnippetQueue, JoryioSDK } from '../index';
import { installFetch, installLocalStorage, uninstallLocalStorage, waitFor } from '../core/test-harness';

/**
 * The async snippet (review findings 2 and 11).
 *
 * - The bundle used to assign `window.joryio.push = ...` on the SDK instance,
 *   whose `push` is a getter: in the strict-mode bundle that threw on EVERY
 *   page using the snippet and aborted the UMD factory.
 * - The stub listed 15 methods; calling any other public method before load
 *   (updateConsent, addAlias, ...) threw "is not a function" in the host page.
 * - A late `init` (pushed after the bundle loaded) was never processed.
 */

const ROOT = path.join(__dirname, '..', '..');
const loaderSrc = fs.readFileSync(path.join(__dirname, 'loader.js'), 'utf8');
const sdkSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sdk.ts'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** Public instance methods of JoryioSDK, read from the source (TS privates are not visible at runtime). */
function publicMethods(): string[] {
  const out = new Set<string>();
  for (const m of sdkSrc.matchAll(/^ {2}(?:async )?([a-zA-Z]+)\(/gm)) {
    if (m[1] !== 'constructor') out.add(m[1]);
  }
  return [...out].sort();
}

const minifiedLine = (): string => {
  const m = loaderSrc.match(/^ \* {3}(!function\(\)\{.*\}\(\);)$/m);
  if (!m) throw new Error('minified snippet not found in loader.js header');
  return m[1];
};

const minifiedMethods = (): string[] => {
  const m = minifiedLine().match(/e\.methods=\[([^\]]*)\]/);
  return JSON.parse(`[${m![1]}]`);
};

const readableMethods = (): string[] => {
  const m = loaderSrc.match(/joryio\.methods = \[([\s\S]*?)\];/);
  return m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
};

describe('the snippet stubs every public method', () => {
  it('readable list = minified list = public SDK methods + init', () => {
    const expected = ['init', ...publicMethods()].sort();
    expect([...readableMethods()].sort()).toEqual(expected);
    expect([...minifiedMethods()].sort()).toEqual(expected);
  });

  it('never stubs the removed alias()', () => {
    expect(readableMethods()).not.toContain('alias');
  });

  it('the README carries the minified snippet unchanged', () => {
    expect(readme).toContain(minifiedLine());
  });
});

describe('the loaded bundle processes the queue', () => {
  let calls: ReturnType<typeof installFetch>;
  beforeEach(() => {
    installLocalStorage();
    calls = installFetch();
  });
  afterEach(async () => {
    await JoryioSDK.getInstance()?.destroy();
    uninstallLocalStorage();
    delete (globalThis as any).fetch;
  });

  /** Run the real loader.js against a fake window, without loading any script. */
  function runSnippet() {
    const win: any = {};
    const document = {
      createElement: () => ({}),
      getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
    };
    win.window = win;
    vm.runInNewContext(loaderSrc, { window: win, document, console });
    return win;
  }

  it('a queued init starts the SDK, swaps window.joryio and replays every call in order', async () => {
    const win = runSnippet();
    win.joryio.updateConsent('granted'); // not stubbed before 1.3.0
    win.joryio.track('Early Event');
    const seen: string[] = [];
    win.joryio.ready((sdk: JoryioSDK) => seen.push(sdk.getAnonymousId()));
    win.joryio.init({ sdkKey: 'jry_sdk_test', apiEndpoint: 'https://api.example/api', trackSessionStart: false, persistQueue: false, inApp: { enabled: false } });

    expect(() => installSnippetQueue(win)).not.toThrow();

    expect(win.joryio).toBeInstanceOf(JoryioSDK);
    expect(seen).toHaveLength(1);
    await win.joryio.flush();
    const batch = calls.find((c) => c.path === '/api/v1/track/batch')!;
    expect(batch.body.events.map((e: any) => e.type)).toEqual(['Early Event']);
  });

  it('an init that arrives AFTER the bundle loaded still starts the SDK', async () => {
    const win = runSnippet();
    win.joryio.track('Before Init');
    installSnippetQueue(win); // bundle loads; no init yet
    expect(Array.isArray(win.joryio)).toBe(true);

    win.joryio.init({ sdkKey: 'jry_sdk_test', apiEndpoint: 'https://api.example/api', trackSessionStart: false, persistQueue: false, inApp: { enabled: false } });

    expect(win.joryio).toBeInstanceOf(JoryioSDK);
    await win.joryio.flush();
    await waitFor(() => calls.some((c) => c.path === '/api/v1/track/batch'));
    expect(calls.find((c) => c.path === '/api/v1/track/batch')!.body.events[0].type).toBe('Before Init');
  });

  it('an invalid init logs instead of throwing into the page', () => {
    const win = runSnippet();
    win.joryio.init({ sdkKey: 'not-a-key' });
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => installSnippetQueue(win)).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('a failed init, then a corrected one (rule 65)', () => {
  let calls: ReturnType<typeof installFetch>;
  beforeEach(() => {
    installLocalStorage();
    calls = installFetch();
  });
  afterEach(async () => {
    await JoryioSDK.getInstance()?.destroy();
    uninstallLocalStorage();
    delete (globalThis as any).fetch;
  });

  function runSnippet() {
    const win: any = {};
    const document = {
      createElement: () => ({}),
      getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
    };
    win.window = win;
    vm.runInNewContext(loaderSrc, { window: win, document, console });
    return win;
  }

  it('keeps every queued call - privacy decisions and withdrawals included - and runs them on the retry', async () => {
    const win = runSnippet();
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    win.joryio.ready((sdk: JoryioSDK) => sdk.user.setSubscription('email', 'unsubscribed' as any));
    win.joryio.optOut();
    win.joryio.track('Never sent');
    win.joryio.init({ sdkKey: 'not-a-key' });
    installSnippetQueue(win); // the bundle loads: the init fails
    err.mockRestore();

    // Still the queue, nothing swallowed by an inert instance; the retry works.
    expect(Array.isArray(win.joryio)).toBe(true);
    expect(win.joryio.isUserOptedOut()).toBeUndefined();
    win.joryio.init({ sdkKey: 'jry_sdk_test', apiEndpoint: 'https://api.example/api', trackSessionStart: true, inApp: { enabled: false } });

    expect(win.joryio).toBeInstanceOf(JoryioSDK);
    // The opt-out was applied inside init, before any side effect.
    expect(win.joryio.isUserOptedOut()).toBe(true);
    await win.joryio.flush();
    await waitFor(() => calls.some((c) => c.path === '/api/v1/subscriptions/channel'));
    expect(calls.find((c) => c.path === '/api/v1/subscriptions/channel')!.body.status).toBe('unsubscribed');
    expect(calls.some((c) => c.path === '/api/v1/track/batch')).toBe(false);
  });
});

describe('the pre-init queue is capped at 1000 calls (addendum 20)', () => {
  function runSnippet() {
    const win: any = {};
    const document = {
      createElement: () => ({}),
      getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
    };
    win.window = win;
    vm.runInNewContext(loaderSrc, { window: win, document, console });
    return win;
  }

  it('the snippet drops the oldest calls, never init', () => {
    const win = runSnippet();
    win.joryio.init({ sdkKey: 'jry_sdk_test' });
    for (let i = 0; i < 1500; i++) win.joryio.track(`E${i}`);
    expect(win.joryio.length).toBe(1000);
    expect(win.joryio[0][0]).toBe('init');
    expect(win.joryio[1]).toEqual(['track', 'E501']);
    expect(win.joryio[999]).toEqual(['track', 'E1499']);
  });

  it('the same cap holds once the bundle is loaded and waits for a late init', () => {
    const win = runSnippet();
    installSnippetQueue(win); // bundle loaded, no init yet
    for (let i = 0; i < 1500; i++) win.joryio.push(['track', `E${i}`]);
    expect(win.joryio.length).toBe(1000);
    expect(win.joryio[0]).toEqual(['track', 'E500']);
  });
});

// Real timers and real debounce windows; generous under a loaded CI machine.
jest.setTimeout(30_000);
