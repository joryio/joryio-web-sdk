import { NetworkClient } from './network';

// sendSetAttributes must forward atomic operation SECTIONS to
// POST /v1/attributes — not a locally-computed absolute value. These tests
// pin the wire contract the backend implements:
//   { userId?, anonymousId?, attributes?, increment?, append?, remove?, unset? }
describe('NetworkClient.sendSetAttributes wire contract', () => {
  const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;
  const make = () => new NetworkClient('jry_sdk_test', stubLogger, { maxRetries: 0, backoffMs: 0 });
  const api = 'https://api.example';

  // Capture the request body without hitting the network.
  const capture = (client: NetworkClient) => {
    const bodies: any[] = [];
    (client as any).request = async (req: any) => {
      bodies.push(req.body);
      return { ok: true, status: 200 };
    };
    return bodies;
  };

  it('increment sends a delta as an `increment` op (never a computed absolute)', async () => {
    const client = make();
    const bodies = capture(client);
    await client.sendSetAttributes(api, { increment: { visits: 1 } }, 'user-1');
    expect(bodies[0]).toEqual({ userId: 'user-1', anonymousId: undefined, increment: { visits: 1 } });
    // No absolute `attributes` section for an increment.
    expect(bodies[0].attributes).toBeUndefined();
  });

  it('setAttributes sends an absolute `attributes` op', async () => {
    const client = make();
    const bodies = capture(client);
    await client.sendSetAttributes(api, { attributes: { email: 'a@b.com' } }, 'user-1');
    expect(bodies[0].attributes).toEqual({ email: 'a@b.com' });
  });

  it('append / remove / unset map to their own sections; anon uses anonymousId', async () => {
    const client = make();
    const bodies = capture(client);
    await client.sendSetAttributes(api, { append: { tags: 'vip' } }, null, 'anon-9');
    await client.sendSetAttributes(api, { remove: { tags: 'vip' } }, null, 'anon-9');
    await client.sendSetAttributes(api, { unset: ['email'] }, null, 'anon-9');
    expect(bodies[0]).toEqual({ userId: undefined, anonymousId: 'anon-9', append: { tags: 'vip' } });
    expect(bodies[1]).toEqual({ userId: undefined, anonymousId: 'anon-9', remove: { tags: 'vip' } });
    expect(bodies[2]).toEqual({ userId: undefined, anonymousId: 'anon-9', unset: ['email'] });
  });
});
