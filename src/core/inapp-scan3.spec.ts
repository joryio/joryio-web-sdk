import { InAppMessagingManager } from './inapp';
import { installFakeDocument, uninstallFakeDocument, installFetch, RecordedRequest, settle, waitFor } from './test-harness';

/**
 * In-app, scan 3 (web): #2 one display per trigger burst (item 27), #3 stale
 * sync answers (item 26), #12 host callbacks that throw (item 34).
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
let currentUser: string | null = null;
const identity = {
  getUserId: () => currentUser,
  getAnonymousId: () => 'anon-1',
  getAttributes: () => ({}),
  getAttribute: () => undefined,
  pending: { pending: () => ({}) },
} as any;
const session = { getSessionId: () => 's-1', getSessionInfo: () => ({ sessionStart: 0 }) } as any;

const native = (extra: Record<string, unknown> = {}) =>
  ({
    id: 'c1',
    name: 'Native',
    type: 'modal',
    triggers: [{ type: 'event', event: 'Opened' }],
    content: { kind: 'native', title: 'Hi', body: 'Body' },
    ...extra,
  }) as any;

let calls: RecordedRequest[] = [];
let mounted: any[] = [];
let managers: InAppMessagingManager[] = [];

function make(displayOptions: Record<string, unknown> = {}) {
  (globalThis as any).window = { open: jest.fn() };
  (globalThis as any).navigator = { language: 'en', userAgent: 'jest' };
  const m = new InAppMessagingManager(
    'https://api.example/api',
    'jry_sdk_test',
    identity,
    session,
    logger,
    null,
    { closeButton: true, backdropClose: true, ...displayOptions },
    undefined,
    null,
    {},
  );
  managers.push(m);
  return m;
}

const displayedReports = () => calls.filter((c) => c.path.endsWith('/v1/in-app/track') && c.body.displayedAt).length;
const containers = () => mounted.filter((e: any) => String(e.id).startsWith('joryio-inapp-')).length;

beforeEach(() => {
  ({ mounted } = installFakeDocument());
  currentUser = null;
});
afterEach(() => {
  jest.useRealTimers();
  managers.forEach((m) => m.destroy());
  managers = [];
  uninstallFakeDocument();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).navigator;
});

function serve(campaigns: any[] | ((body: any) => any[])) {
  calls = installFetch((req) =>
    req.path.endsWith('/v1/in-app/sync')
      ? { status: 200, body: { success: true, campaigns: typeof campaigns === 'function' ? campaigns(req.body) : campaigns } }
      : { status: 200, body: { success: true } });
}

describe('one display per trigger burst (finding 2, item 27)', () => {
  it('two synchronous triggers display once and report one displayed', async () => {
    serve([native()]);
    const m = make();
    await m.sync();
    m.onEventTracked('Opened');
    m.onEventTracked('Opened');
    await settle(30);
    expect(containers()).toBe(1);
    expect(displayedReports()).toBe(1);
  });

  it('a re-check campaign (async resolve) triggered twice is resolved and shown once', async () => {
    calls = installFetch((req) => {
      if (req.path.endsWith('/v1/in-app/sync')) {
        return { status: 200, body: { success: true, campaigns: [native({ reevaluateBeforeDisplay: true, content: undefined })] } };
      }
      if (req.path.endsWith('/v1/in-app/resolve')) return { status: 200, body: { eligible: true, campaign: native() } };
      return { status: 200, body: { success: true } };
    });
    const m = make();
    await m.sync();
    m.onEventTracked('Opened');
    m.onEventTracked('Opened');
    await settle(30);
    expect(calls.filter((c) => c.path.endsWith('/v1/in-app/resolve'))).toHaveLength(1);
    expect(displayedReports()).toBe(1);
  });

  it('a delayed campaign triggered again while waiting is not scheduled twice', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    serve([native({ delay: 2 })]);
    const m = make();
    await m.sync();
    m.onEventTracked('Opened');
    await jest.advanceTimersByTimeAsync(10);
    m.onEventTracked('Opened');
    await jest.advanceTimersByTimeAsync(2500);
    expect(containers()).toBe(1);
    expect(displayedReports()).toBe(1);
  });
});

describe('stale sync answers (finding 3, item 26)', () => {
  it('a sync that answers after invalidate() is discarded and a fresh sync follows', async () => {
    let syncs = 0;
    const inner = (body: any) => {
      syncs++;
      return body.userId === 'B' ? [] : [native({ id: 'for-anon', triggers: [] })];
    };
    serve(inner);
    const fetchServe = (globalThis as any).fetch;
    let release: (() => void) | null = null;
    let first = true;
    (globalThis as any).fetch = (url: string, init: any) => {
      if (first && String(url).endsWith('/v1/in-app/sync')) {
        first = false;
        return new Promise((resolve) => {
          release = () => resolve(fetchServe(url, init));
        });
      }
      return fetchServe(url, init);
    };
    const m = make();
    const pending = m.sync();
    await waitFor(() => release !== null);
    // identify('B') while the anonymous visitor's sync is in flight
    currentUser = 'B';
    m.invalidate();
    // A forced sync asked for meanwhile is not dropped either.
    await m.sync();
    release!();
    await pending.catch(() => undefined);
    await waitFor(() => syncs >= 2);
    await settle(20);
    expect(m.getCampaigns().map((c) => c.id)).toEqual([]);
    expect(calls.filter((c) => c.path.endsWith('/v1/in-app/sync')).pop()!.body.userId).toBe('B');
  });
});

describe('host callbacks that throw (finding 12, item 34)', () => {
  it('a throwing onMessageDisplay does not stop the displayed impression', async () => {
    serve([native()]);
    const m = make({
      onDisplay: () => {
        throw new Error('host bug');
      },
    });
    await m.sync();
    m.onEventTracked('Opened');
    await settle(30);
    expect(containers()).toBe(1);
    expect(displayedReports()).toBe(1);
  });

  it('a throwing onMessageDismiss does not leave the message registered', async () => {
    serve([native()]);
    const m = make({
      onDismiss: () => {
        throw new Error('host bug');
      },
    });
    await m.sync();
    m.onEventTracked('Opened');
    await settle(30);
    await expect(m.dismiss('c1')).resolves.toBeUndefined();
    expect(containers()).toBe(0);
    // Shown again on the next trigger only if the cap allows: the manager is
    // not stuck thinking the message is still on screen.
    expect((m as any).displayedMessages.has('c1')).toBe(false);
  });
});
