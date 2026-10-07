import { PendingAttributes } from './pending-attributes';

/**
 * The attribute write path was fire-and-forget on all three SDKs: a failure
 * logged and dropped the value. An attribute set while offline never reached
 * the server, and the in-app sync's read-time override hid it - targeting
 * looked right while segments, journeys and email never saw the value.
 *
 * Since scan 3 (contract item 31) the store is an ORDERED log: every call is
 * kept in order, a request carries at most one write per key, and an ack
 * removes exactly what was sent.
 */
describe('PendingAttributes', () => {
  it('keeps a write until the server acknowledges it', () => {
    const p = new PendingAttributes();
    p.mark({ attributes: { plan: 'pro' } });

    expect(p.isEmpty()).toBe(false);
    expect(p.pending()).toEqual({ plan: 'pro' });

    const req = p.nextRequest()!;
    expect(req.ops).toEqual({ attributes: { plan: 'pro' } });
    p.acknowledge(req.entries);
    expect(p.isEmpty()).toBe(true);
  });

  it('accumulates every failed write, not just the most recent', () => {
    const p = new PendingAttributes();
    p.mark({ attributes: { a: 1 } });
    p.mark({ attributes: { b: 2 } });
    p.mark({ attributes: { c: 3 } });

    // Three writes failed while offline; reconnecting must deliver all three.
    expect(p.toOps()).toEqual({ attributes: { a: 1, b: 2, c: 3 } });
  });

  it('does NOT ack a value written while the request was in flight', () => {
    const p = new PendingAttributes();
    p.mark({ attributes: { plan: 'free' } });
    const inFlight = p.nextRequest()!;

    // Flush carrying plan=free is in flight; the app sets plan=pro.
    p.mark({ attributes: { plan: 'pro' } });

    // The in-flight request comes back OK. Acking it must not clear the newer
    // value, or 'pro' is silently lost and the profile keeps 'free' forever.
    p.acknowledge(inFlight.entries);

    expect(p.pending()).toEqual({ plan: 'pro' });
    expect(p.nextRequest()!.ops).toEqual({ attributes: { plan: 'pro' } });
  });

  it('a newer write to a key waits for the one in flight (never overtakes it)', () => {
    const p = new PendingAttributes();
    p.mark({ attributes: { plan: 'free' } });
    p.nextRequest();
    p.mark({ attributes: { plan: 'pro' } });
    // Sending 'pro' now could land BEFORE 'free' and be overwritten by it.
    expect(p.nextRequest()).toBeNull();
  });

  it('sums increments while they wait; drops them on an ambiguous failure, keeps them on a clear refusal', () => {
    const p = new PendingAttributes();
    p.mark({ increment: { lifetimeOrders: 1 } });
    p.mark({ increment: { lifetimeOrders: 2 } });
    let req = p.nextRequest()!;
    expect(req.ops).toEqual({ increment: { lifetimeOrders: 3 } });

    // 401/403/429: nothing was applied, so retrying is safe.
    expect(p.release(req.entries, false)).toBe(0);
    req = p.nextRequest()!;
    expect(req.ops).toEqual({ increment: { lifetimeOrders: 3 } });

    // No answer / 5xx: it may have been applied - a retry would double-count.
    expect(p.release(req.entries, true)).toBe(1);
    expect(p.isEmpty()).toBe(true);
  });

  it('two addToArray calls on one key send BOTH values (scan 3, web #1)', () => {
    const p = new PendingAttributes();
    p.add('append', 'tags', 'a');
    p.add('append', 'tags', 'b');
    p.add('append', 'tags', 'a');
    expect(p.nextRequest()!.ops).toEqual({ append: { tags: ['a', 'b'] } });
  });

  it('append and remove of the same key never share a request, and keep call order', () => {
    const p = new PendingAttributes();
    p.add('append', 'tags', 'x');
    p.add('remove', 'tags', 'y');
    // The API applies one operator per key per request ($addToSet beats
    // $pull), so sharing one silently skipped the remove.
    const first = p.nextRequest()!;
    expect(first.ops).toEqual({ append: { tags: ['x'] } });
    expect(p.nextRequest()).toBeNull();
    p.acknowledge(first.entries);
    expect(p.nextRequest()!.ops).toEqual({ remove: { tags: ['y'] } });
  });

  it('a set and an increment of one key go in call order, in separate requests', () => {
    const p = new PendingAttributes();
    p.add('set', 'score', 10);
    p.add('increment', 'score', 5);
    const first = p.nextRequest()!;
    expect(first.ops).toEqual({ attributes: { score: 10 } });
    p.acknowledge(first.entries);
    expect(p.nextRequest()!.ops).toEqual({ increment: { score: 5 } });
  });

  it('an absolute write supersedes everything still waiting for that key', () => {
    const p = new PendingAttributes();
    p.mark({ unset: ['plan'] });
    p.mark({ attributes: { plan: 'pro' } });
    p.add('append', 'tags', 'a');
    p.add('set', 'tags', ['z']);

    const ops = p.toOps()!;
    expect(ops.attributes).toEqual({ plan: 'pro', tags: ['z'] });
    expect(ops.unset).toBeUndefined();
    expect(ops.append).toBeUndefined();
  });

  it('different keys travel together in one request', () => {
    const p = new PendingAttributes();
    p.add('set', 'a', 1);
    p.add('append', 'tags', 'vip');
    p.add('remove', 'labels', 'trial');
    p.add('unset', 'nickname');
    expect(p.nextRequest()!.ops).toEqual({
      attributes: { a: 1 },
      append: { tags: ['vip'] },
      remove: { labels: ['trial'] },
      unset: ['nickname'],
    });
  });

  it('round-trips through storage in order', () => {
    const p = new PendingAttributes();
    p.add('append', 'tags', 'x');
    p.add('remove', 'tags', 'y');
    p.add('increment', 'n', 2);
    const q = new PendingAttributes();
    q.restore(JSON.parse(JSON.stringify(p.serialize())));
    expect(q.serialize()).toEqual(p.serialize());
  });

  it('bounds memory when an app writes unique keys in a loop offline', () => {
    const p = new PendingAttributes(10);
    for (let i = 0; i < 50; i++) p.mark({ attributes: { [`k${i}`]: i } });

    expect(Object.keys(p.pending()).length).toBe(10);
  });
});
