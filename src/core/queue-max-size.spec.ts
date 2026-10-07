import { QueueManager, QueuedEvent } from './queue';

/**
 * `maxQueueSize` is a documented init option. It was resolved, stored on the
 * config, and never read: the queue trimmed at a private constant of 1,000
 * whatever the integrator asked for (audit 2026-09-26, W4). iOS and Android
 * pass theirs through to their queues, so web was the only platform where the
 * option was a no-op.
 *
 * This pins the option reaching the queue, and the queue trimming to it.
 */

const ev = (i: number): QueuedEvent => ({
  eventId: `e${i}`,
  type: 'track',
  properties: { i },
  timestamp: 1_700_000_000_000 + i,
  anonymousId: 'anon-1',
});

const noopLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeQueue(maxQueueSize?: number) {
  // persistQueue false: storage is irrelevant here. batchSize high enough that
  // enqueue() never auto-flushes.
  return new QueueManager({} as any, noopLogger as any, 10_000, 60_000, false, maxQueueSize);
}

describe('maxQueueSize is honoured by the queue', () => {
  it('trims to the configured cap, dropping the OLDEST events', () => {
    const q = makeQueue(5);
    for (let i = 0; i < 8; i++) q.enqueue(ev(i));

    expect(q.getQueueSize()).toBe(5);
    expect(q.getQueuedEvents().map((e) => e.eventId)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);
  });

  it('falls back to 1,000 when nothing is passed', () => {
    const q = makeQueue();
    for (let i = 0; i < 1_005; i++) q.enqueue(ev(i));
    expect(q.getQueueSize()).toBe(1_000);
  });

  it('treats a non-positive cap as the default rather than dropping everything', () => {
    const q = makeQueue(0);
    for (let i = 0; i < 3; i++) q.enqueue(ev(i));
    expect(q.getQueueSize()).toBe(3);
  });
});

describe('the SDK passes config.maxQueueSize to the queue', () => {
  it('names the option at the QueueManager construction site', () => {
    // Source-level pin: the bug was precisely that the value never reached the
    // constructor, and no behavioural test of QueueManager alone can see that.
    const fs = require('fs');
    const path = require('path');
    const sdk = fs.readFileSync(path.join(__dirname, 'sdk.ts'), 'utf8');
    const at = sdk.indexOf('new QueueManager(');
    expect(at).toBeGreaterThan(-1);
    const ctorCall = sdk.slice(at, sdk.indexOf(');', at));
    expect(ctorCall).toContain('this.config.maxQueueSize');
  });
});
