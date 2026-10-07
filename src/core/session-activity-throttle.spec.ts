import { SessionManager } from './session';

/**
 * `updateActivity()` is called on EVERY tracked event and wrote the
 * last-activity stamp to localStorage each time — synchronous main-thread I/O
 * per event.
 *
 * Found by running the SDK in headless Chrome rather than by reading it: a
 * 40-event burst produced 41 storage writes, and breaking them down by key
 * showed 40 of them were `last_activity` (the event queue itself correctly
 * coalesced to 1). Unit tests could not have caught it — they don't count
 * writes, and each individual write is perfectly correct.
 *
 * The stamp only feeds a 30-MINUTE timeout decision, so persisting at most
 * every 30s cannot change any decision it participates in.
 */

const noopLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeStorage() {
  const data = new Map<string, any>();
  const writes: string[] = [];
  return {
    writes,
    data,
    set: jest.fn((k: string, v: any) => {
      writes.push(k);
      data.set(k, v);
    }),
    get: jest.fn((k: string) => data.get(k)),
    remove: jest.fn((k: string) => data.delete(k)),
  };
}

const activityWrites = (s: ReturnType<typeof makeStorage>) =>
  s.writes.filter((k) => k === 'last_activity').length;

describe('session last-activity persistence is throttled', () => {
  it('writes ONCE for a burst of events, not once per event', () => {
    const storage = makeStorage();
    const session = new SessionManager(storage as any, noopLogger as any);
    const baseline = activityWrites(storage); // the new session writes it once

    for (let i = 0; i < 40; i++) session.updateActivity();

    expect(activityWrites(storage) - baseline).toBe(0);
  });

  it('persists again once the interval has elapsed', () => {
    const storage = makeStorage();
    const session = new SessionManager(storage as any, noopLogger as any);
    const baseline = activityWrites(storage);

    const realNow = Date.now;
    try {
      // 31s later — past the 30s persist interval.
      Date.now = () => realNow() + 31_000;
      session.updateActivity();
      expect(activityWrites(storage) - baseline).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('keeps the IN-MEMORY activity time exact even while throttled', () => {
    // Throttling the write must not make the SDK's own view of activity stale,
    // or a session could be judged expired using a value up to 30s old.
    const storage = makeStorage();
    const session = new SessionManager(storage as any, noopLogger as any);

    const realNow = Date.now;
    try {
      const t = realNow() + 5_000; // inside the throttle window
      Date.now = () => t;
      session.updateActivity();
      expect(session.getSessionInfo().lastActivity).toBe(t);
    } finally {
      Date.now = realNow;
    }
  });

  it('still records a session id and start (unchanged behaviour)', () => {
    const storage = makeStorage();
    const session = new SessionManager(storage as any, noopLogger as any);
    expect(session.getSessionId()).toEqual(expect.any(String));
    expect(storage.writes).toContain('session_id');
    expect(storage.writes).toContain('session_start');
  });
});
