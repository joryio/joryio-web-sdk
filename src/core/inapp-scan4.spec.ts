import { InAppMessagingManager } from './inapp';
import { installFakeDocument, uninstallFakeDocument, installFetch, RecordedRequest, settle } from './test-harness';

/**
 * In-app, scan 4 (web) #7 and contract item 43: a delayed display is tied to
 * the identity/consent generation and to canSend, and a slot is released on
 * dismiss even while sending is blocked.
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = {
  getUserId: () => null,
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
let allowed = true;

function make() {
  (globalThis as any).window = { open: jest.fn() };
  (globalThis as any).navigator = { language: 'en', userAgent: 'jest' };
  const m = new InAppMessagingManager(
    'https://api.example/api',
    'jry_sdk_test',
    identity,
    session,
    logger,
    null,
    { closeButton: true, backdropClose: true },
    undefined,
    null,
    { canSend: () => allowed },
  );
  managers.push(m);
  return m;
}

const containers = () => mounted.filter((e: any) => String(e.id).startsWith('joryio-inapp-')).length;
const displayedReports = () => calls.filter((c) => c.path.endsWith('/v1/in-app/track') && c.body.displayedAt).length;

beforeEach(() => {
  ({ mounted } = installFakeDocument());
  allowed = true;
  calls = installFetch((req) =>
    req.path.endsWith('/v1/in-app/sync')
      ? { status: 200, body: { success: true, campaigns: [native({ delay: 2 })] } }
      : { status: 200, body: { success: true } });
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

describe('a delayed display is tied to the generation and to canSend (scan 4 #7, item 43)', () => {
  it("identify('B') without reset during the delay: the previous visitor's message is not shown", async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const m = make();
    await m.sync();
    m.onEventTracked('Opened');
    await jest.advanceTimersByTimeAsync(10);
    m.invalidate(); // what identify() of another user calls
    await jest.advanceTimersByTimeAsync(2500);
    expect(containers()).toBe(0);
    expect(displayedReports()).toBe(0);
  });

  it('sending blocked during the delay (consent pending at runtime): not shown', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const m = make();
    await m.sync();
    m.onEventTracked('Opened');
    await jest.advanceTimersByTimeAsync(10);
    allowed = false;
    await jest.advanceTimersByTimeAsync(2500);
    expect(containers()).toBe(0);
  });

  it('a message dismissed while sending is blocked releases its slot', async () => {
    calls = installFetch((req) =>
      req.path.endsWith('/v1/in-app/sync')
        ? { status: 200, body: { success: true, campaigns: [native({ frequencyCap: { type: 'unlimited' } })] } }
        : { status: 200, body: { success: true } });
    const m = make();
    await m.sync();
    m.onEventTracked('Opened');
    await settle(20);
    expect(containers()).toBe(1);
    allowed = false;
    await m.dismiss('c1', 'close_button');
    expect((m as any).displayedMessages.has('c1')).toBe(false);
    expect(containers()).toBe(0);
  });
});
