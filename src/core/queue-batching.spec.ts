import { QueueManager, QueuedEvent, FlushOutcome, MAX_EVENTS_PER_REQUEST } from './queue';

/**
 * One bad batch must never block the queue (SDK 1.3.0 contract item 3).
 *
 * Before: flush() sent the WHOLE queue (up to maxQueueSize = 1000) in one
 * request against a backend that accepts 500 events / 1 MB; any 4xx except 429
 * re-queued the batch at the FRONT, so the same refused batch was sent again
 * on every flush and nothing behind it was ever delivered. A 200 with
 * `success: false` was treated as success and the unstored events deleted.
 */

const ev = (i: number, type = 'track'): QueuedEvent => ({
  eventId: `e${i}`,
  type,
  properties: { i },
  timestamp: 1_700_000_000_000 + i,
  anonymousId: 'anon-1',
});

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeQueue(batchSize = 50, maxQueueSize = 5000) {
  // persistQueue false; flush interval irrelevant (never started).
  return new QueueManager({} as any, logger as any, batchSize, 60_000, false, maxQueueSize, 1000);
}

/** Fill without triggering the auto-flush on batchSize. */
function fill(q: QueueManager, n: number, typeOf: (i: number) => string = () => 'track') {
  const raw = (q as any).queue as QueuedEvent[];
  for (let i = 0; i < n; i++) raw.push(ev(i, typeOf(i)));
}

describe('flush sends bounded batches', () => {
  it('never puts more than min(batchSize, 500) events in one request', async () => {
    const q = makeQueue(1000); // configured above the backend cap
    fill(q, 1200);
    const sizes: number[] = [];
    q.setFlushCallback(async (events) => {
      sizes.push(events.length);
    });

    await q.flush();

    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_EVENTS_PER_REQUEST);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1200);
    expect(q.getQueueSize()).toBe(0);
  });

  it('honours a configured batchSize below the cap', async () => {
    const q = makeQueue(20);
    fill(q, 45);
    const sizes: number[] = [];
    q.setFlushCallback(async (events) => {
      sizes.push(events.length);
    });
    await q.flush();
    expect(sizes).toEqual([20, 20, 5]);
  });

  it('keeps a request under ~900 KB', async () => {
    const q = makeQueue(500);
    const big = 'x'.repeat(100 * 1024);
    const raw = (q as any).queue as QueuedEvent[];
    for (let i = 0; i < 20; i++) raw.push({ ...ev(i), properties: { big } });
    const bytes: number[] = [];
    q.setFlushCallback(async (events) => {
      bytes.push(JSON.stringify(events).length);
    });
    await q.flush();
    expect(Math.max(...bytes)).toBeLessThan(900 * 1024);
    expect(bytes.length).toBeGreaterThan(1);
  });
});

describe('a refused batch (400/413/422) does not block the queue', () => {
  it('splits until the bad event is alone, drops only it, delivers the rest', async () => {
    const q = makeQueue(50);
    fill(q, 50, (i) => (i === 17 ? '' : 'track'));
    const delivered: string[] = [];
    q.setFlushCallback(async (events): Promise<FlushOutcome> => {
      if (events.some((e) => e.type === '')) return { status: 'rejected', httpStatus: 400 };
      delivered.push(...events.map((e) => e.eventId));
      return { status: 'ok' };
    });

    await q.flush();

    expect(delivered).toHaveLength(49);
    expect(delivered).not.toContain('e17');
    expect(q.getQueueSize()).toBe(0);
    // And a later event is not stuck behind it.
    q.enqueue(ev(999));
    await q.flush();
    expect(delivered).toContain('e999');
  });

  it('a refused identify does not take good events down with it', async () => {
    const q = makeQueue(50);
    fill(q, 3);
    q.setPendingIdentify({ userId: 'u'.repeat(300), anonymousId: 'anon-1' });
    const delivered: string[] = [];
    q.setFlushCallback(async (events, identify): Promise<FlushOutcome> => {
      if (identify) return { status: 'rejected', httpStatus: 400 };
      delivered.push(...events.map((e) => e.eventId));
      return { status: 'ok' };
    });
    await q.flush();
    expect(delivered).toEqual(['e0', 'e1', 'e2']);
    expect(q.getPendingIdentify()).toBeNull();
  });
});

describe('200 with success:false', () => {
  it('keeps exactly the failedIndices and deletes the rest', async () => {
    const q = makeQueue(10);
    fill(q, 5);
    q.setFlushCallback(async (): Promise<FlushOutcome> => ({ status: 'ok', failedIndices: [1, 3] }));
    await q.flush();
    expect(q.getQueuedEvents().map((e) => e.eventId)).toEqual(['e1', 'e3']);
  });
});

describe('suspended (402 / 403 / invalid key)', () => {
  it('stops sending for the page view and keeps the events', async () => {
    const q = makeQueue(10);
    fill(q, 25);
    let calls = 0;
    q.setFlushCallback(async (): Promise<FlushOutcome> => {
      calls++;
      return { status: 'suspended', reason: '402' };
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await q.flush();
    await q.flush();
    warn.mockRestore();
    expect(calls).toBe(1);
    expect(q.isSuspended()).toBe(true);
    expect(q.getQueueSize()).toBe(25);
  });
});

describe('retryable failures (429 / 5xx / offline)', () => {
  it('keep every event, in order, and back off instead of hammering', async () => {
    const q = makeQueue(10);
    fill(q, 15);
    let calls = 0;
    q.setFlushCallback(async (): Promise<FlushOutcome> => {
      calls++;
      return { status: 'retry', retryAfterMs: 60_000 };
    });
    await q.flush();
    await q.flush(); // inside the backoff window: no request
    expect(calls).toBe(1);
    expect(q.getQueuedEvents().map((e) => e.eventId)).toEqual(
      Array.from({ length: 15 }, (_v, i) => `e${i}`),
    );
  });

  it('never deletes events however many times it fails - only maxQueueSize trims', async () => {
    const q = makeQueue(10, 30);
    fill(q, 20);
    q.setFlushCallback(async (): Promise<FlushOutcome> => ({ status: 'retry' }));
    for (let i = 0; i < 10; i++) {
      q.resetBackoff();
      await q.flush();
    }
    expect(q.getQueueSize()).toBe(20);
  });

  it('a thrown callback counts as retry, not as delivered', async () => {
    const q = makeQueue(10);
    fill(q, 4);
    q.setFlushCallback(async () => {
      throw new Error('network down');
    });
    await q.flush();
    expect(q.getQueueSize()).toBe(4);
  });
});

describe('paused (consent pending)', () => {
  it('sends nothing while paused and everything once released', async () => {
    const q = makeQueue(10);
    q.setPaused(true);
    fill(q, 3);
    const sent: number[] = [];
    q.setFlushCallback(async (events) => {
      sent.push(events.length);
    });
    await q.flush();
    expect(sent).toEqual([]);
    q.setPaused(false);
    await q.flush();
    expect(sent).toEqual([3]);
  });
});

describe('page-unload hand-off', () => {
  it('stops holding ONLY what was handed off, and can take it back', () => {
    const q = makeQueue(10);
    fill(q, 5);
    const all = q.getQueuedEvents();
    q.markHandedOff(all.slice(0, 2), null);
    expect(q.getQueuedEvents().map((e) => e.eventId)).toEqual(['e2', 'e3', 'e4']);
    q.takeBack(all.slice(0, 2), null);
    expect(q.getQueuedEvents().map((e) => e.eventId)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });
});
