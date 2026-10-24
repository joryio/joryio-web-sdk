import { QueueManager, QueuedEvent } from './queue';

/**
 * `enqueue` used to write the whole queue to storage on EVERY event.
 *
 * Both halves of that are synchronous main-thread work — `JSON.stringify` of
 * the entire queue, then a `localStorage.setItem` of the result — so the cost of
 * adding one event was O(queue), making a burst O(N²). Measured at ~261ms of
 * stringify alone to reach the 1000-event cap, versus ~1.5ms if each event were
 * serialized once, before the ~295KB storage write is even counted.
 *
 * The shape of the bug is what makes it nasty: the queue only grows when
 * flushes are FAILING, so the pathological cost arrives precisely when the user
 * is on a bad connection and the page is already struggling.
 *
 * These tests pin the fix AND the durability guarantee that justifies it: the
 * write is coalesced, but every path that could actually lose events still
 * persists synchronously.
 */

const ev = (i: number): QueuedEvent => ({
  eventId: `e${i}`,
  type: 'track',
  properties: { i },
  timestamp: 1_700_000_000_000 + i,
  anonymousId: 'anon-1',
});

/** Minimal StorageManager stand-in that counts writes. */
function makeStorage() {
  const data = new Map<string, any>();
  const writes: string[] = [];
  return {
    writes,
    data,
    set: jest.fn((k: string, v: any) => {
      writes.push(k);
      data.set(k, JSON.parse(JSON.stringify(v)));
    }),
    get: jest.fn((k: string) => data.get(k)),
    remove: jest.fn((k: string) => data.delete(k)),
  };
}

const noopLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeQueue(storage: any) {
  // batchSize high enough that enqueue() never auto-flushes during these tests.
  return new QueueManager(storage as any, noopLogger as any, 10_000, 60_000, true);
}

const queueWrites = (s: ReturnType<typeof makeStorage>) =>
  s.writes.filter((k) => k === 'event_queue').length;

describe('queue persistence is coalesced', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('writes ONCE for a burst of events, not once per event', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    for (let i = 0; i < 100; i++) q.enqueue(ev(i));

    // Nothing written yet — the burst is still collapsing.
    expect(queueWrites(storage)).toBe(0);

    jest.advanceTimersByTime(200);
    expect(queueWrites(storage)).toBe(1);
  });

  it('persists the COMPLETE queue once the window elapses', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    for (let i = 0; i < 25; i++) q.enqueue(ev(i));
    jest.advanceTimersByTime(200);

    expect(storage.data.get('event_queue')).toHaveLength(25);
  });

  it('starts a fresh window for later events', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    q.enqueue(ev(1));
    jest.advanceTimersByTime(200);
    expect(queueWrites(storage)).toBe(1);

    q.enqueue(ev(2));
    jest.advanceTimersByTime(200);
    expect(queueWrites(storage)).toBe(2);
    expect(storage.data.get('event_queue')).toHaveLength(2);
  });

  it('does not leave a timer pending after it fires (no leak)', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    q.enqueue(ev(1));
    jest.advanceTimersByTime(200);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('coalescing never costs durability', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('persistNow() forces the outstanding write immediately', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    q.enqueue(ev(1));
    expect(queueWrites(storage)).toBe(0);

    q.persistNow(); // what the page-unload path calls
    expect(queueWrites(storage)).toBe(1);
    expect(storage.data.get('event_queue')).toHaveLength(1);
  });

  it('persistNow() is a no-op when nothing is outstanding', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    q.enqueue(ev(1));
    jest.advanceTimersByTime(200);
    const before = queueWrites(storage);

    q.persistNow();
    expect(queueWrites(storage)).toBe(before);
  });

  it('stop() flushes a pending write, so teardown cannot strand events', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    q.enqueue(ev(1));
    q.stop();

    expect(storage.data.get('event_queue')).toHaveLength(1);
  });

  it('a forced write cancels the scheduled one rather than double-writing', () => {
    const storage = makeStorage();
    const q = makeQueue(storage);

    q.enqueue(ev(1));
    q.persistNow();
    jest.advanceTimersByTime(500);

    expect(queueWrites(storage)).toBe(1);
  });

  it('recovers everything a previous page persisted', () => {
    const storage = makeStorage();
    const first = makeQueue(storage);
    for (let i = 0; i < 10; i++) first.enqueue(ev(i));
    first.persistNow();

    // New page load, same storage.
    const second = makeQueue(storage);
    expect(second.getQueuedEvents()).toHaveLength(10);
  });
});
