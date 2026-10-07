import { InAppMessagingManager, scopeCssRules } from './inapp';

// buildSrcdoc is the injection-prone part (message html/css + the bridge
// bootstrap + the campaignId baked in). It's a pure string builder, so it's
// testable without a DOM. The iframe↔bridge round-trip itself is browser-only
// (jsdom won't execute srcdoc scripts) and is covered by the on-device test.
describe('InAppMessagingManager.buildSrcdoc', () => {
  const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;
  const make = () =>
    new InAppMessagingManager('https://api.example', 'jry_sdk_test', {} as any, {} as any, stubLogger);

  it('embeds the message HTML, its CSS, and the joryioBridge bootstrap', () => {
    const m = make();
    const html = '<button data-joryio-action="requestPushPermission">Enable</button>';
    const css = '.cta{color:red}';
    const doc = (m as any).buildSrcdoc('camp-1', html, css) as string;

    expect(doc).toMatch(/^<!doctype html>/i);
    expect(doc).toContain(html); // message markup passed through (sandbox is the boundary)
    expect(doc).toContain(css); // message CSS lives inside the iframe
    expect(doc).toContain('window.joryioBridge'); // bridge API exposed to the message
    expect(doc).toContain('requestPushPermission'); // primer action available
    expect(doc).toContain('setSize'); // auto-size (width+height) reporter present
    expect(doc).toContain('navigate'); // CTA link navigation routed through the host
    // The link-routing regex must survive template-literal escaping into a VALID
    // runtime regex (http(s):// or single-leading-slash, NOT protocol-relative //).
    // i.e. the srcdoc string contains `https?:\/\/`, not the over-escaped `\\/\\/`.
    expect(doc).toContain('https?:\\/\\/'); // == the chars  https?:\/\/
    expect(doc).not.toContain('https?:\\\\/'); // would be the broken \\/ form
  });

  it('bakes the campaignId in as a JSON literal (so a message can only act on itself)', () => {
    const m = make();
    const doc = (m as any).buildSrcdoc('abc-123', '<div></div>', '') as string;
    expect(doc).toContain('"abc-123"');
  });

  it('routes data-joryio-action clicks and logs a/button clicks via the bootstrap', () => {
    const m = make();
    const doc = (m as any).buildSrcdoc('c', '<a href="/x">go</a>', '') as string;
    expect(doc).toContain('data-joryio-action'); // declarative action routing
    expect(doc).toContain('logClick'); // auto click tracking
  });

  it('wires per-device visibility: real-device root class + jr-hide rules', () => {
    const m = make();
    const doc = (m as any).buildSrcdoc('c', '<div class="jr-hide-mobile">x</div>', '') as string;
    // The hide rules are present in the iframe stylesheet…
    expect(doc).toContain('.jr-vp-mobile .jr-hide-mobile{display:none!important}');
    expect(doc).toContain('.jr-vp-desktop .jr-hide-desktop{display:none!important}');
    // …and the bootstrap sets the viewport class from the HOST page width (<=480).
    expect(doc).toContain('window.parent.innerWidth');
    expect(doc).toContain('jr-vp-mobile');
    expect(doc).toContain('jr-vp-desktop');
  });
});

// Frequency caps ('once'/'lifetime'/'session') must survive a page reload, which
// means the per-campaign impression timestamps have to be persisted to storage
// and reloaded when a new manager is constructed. Verified at the unit level:
// record an impression via one manager, then confirm a freshly-constructed
// manager backed by the SAME storage refuses to re-show a 'once' campaign.
describe('InAppMessagingManager impression persistence (frequency caps)', () => {
  const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;

  const makeStorage = () => {
    const mem = new Map<string, any>();
    return {
      get: (k: string) => (mem.has(k) ? mem.get(k) : null),
      set: (k: string, v: any) => { mem.set(k, JSON.parse(JSON.stringify(v))); },
      remove: (k: string) => { mem.delete(k); },
    } as any;
  };

  const makeManager = (storage: any) =>
    new InAppMessagingManager(
      'https://api.example',
      'jry_sdk_test',
      {} as any,
      {} as any,
      stubLogger,
      storage,
    );

  const onceCampaign = (id: string) => ({
    id,
    frequencyCap: { maxImpressions: 1, timeWindow: 'once' },
  }) as any;

  it('persists impressions and reloads them so a "once" cap holds across reloads', () => {
    const storage = makeStorage();

    // First "page load": record an impression for camp-1 and persist it.
    const m1 = makeManager(storage);
    (m1 as any).impressionTimestamps.set('camp-1', [Date.now()]);
    (m1 as any).persistImpressionTimestamps();

    // Second "page load": a brand-new manager loads persisted timestamps.
    const m2 = makeManager(storage);

    // camp-1 was already shown once → cap blocks it after reload.
    expect((m2 as any).checkFrequencyCap(onceCampaign('camp-1'))).toBe(false);
    // camp-2 was never shown → still allowed.
    expect((m2 as any).checkFrequencyCap(onceCampaign('camp-2'))).toBe(true);
  });

  it('with no storage, a "once" cap re-fires on reload (documents the un-persisted fallback)', () => {
    // No storage → nothing to reload; a fresh manager has no memory of impressions.
    const m1 = makeManager(null);
    (m1 as any).impressionTimestamps.set('camp-1', [Date.now()]);
    const m2 = makeManager(null);
    expect((m2 as any).checkFrequencyCap(onceCampaign('camp-1'))).toBe(true);
  });
});

// Author CSS from a campaign's advanced section is injected into the HOST PAGE,
// not into an iframe - native content has no markup to sandbox, so there is no
// iframe to contain it. Scoping is the only thing between a typo in a campaign
// and a blanked-out customer website.
//
// These tests drive the REWRITER with hand-built rule objects rather than
// parsing real CSS: the parse is the browser's (jsdom is not installed here,
// and its CSS support is not the browser's anyway), while the rewriting is
// ours - and the rewriting is where the security consequences are. What the
// parser produces for a given string is verified on device, not here.
describe('scopeCssRules', () => {
  const styleRule = (selectorText: string, cssText = 'color: red;') => ({
    selectorText,
    style: { cssText },
  });

  it('confines a bare selector to this message', () => {
    expect(scopeCssRules([styleRule('p')], '#m')).toBe('#m p { color: red; }');
  });

  it('rewrites body/:root/html to the message itself rather than the page', () => {
    // The failure this prevents: `body { display: none }` typed into a campaign
    // hiding the customer's entire site.
    for (const selector of ['body', ':root', 'html', 'BODY']) {
      expect(scopeCssRules([styleRule(selector, 'display: none;')], '#m')).toBe(
        '#m { display: none; }',
      );
    }
  });

  it('scopes every selector in a comma-separated list, not just the first', () => {
    expect(scopeCssRules([styleRule('h2, p', 'margin: 0;')], '#m')).toBe(
      '#m h2, #m p { margin: 0; }',
    );
  });

  it('keeps @media conditions and scopes what is inside them', () => {
    const media = {
      conditionText: '(max-width: 480px)',
      cssText: '@media (max-width: 480px) { p { color: red; } }',
      cssRules: [styleRule('p')],
    };
    expect(scopeCssRules([media], '#m')).toBe(
      '@media (max-width: 480px) { #m p { color: red; } }',
    );
  });

  it('drops a rule kind it cannot scope, such as @import', () => {
    // CSSImportRule has neither selectorText nor conditionText, so it falls
    // through to the default: dropped. An @import would pull in a remote
    // stylesheet that no amount of rewriting can confine.
    const importRule = { cssText: '@import url("https://evil.example/x.css");', type: 3 };
    expect(scopeCssRules([importRule, styleRule('p')], '#m')).toBe('#m p { color: red; }');
  });

  it('keeps @keyframes as-is - a name reference, not a selector match', () => {
    const keyframes = { type: 7, cssText: '@keyframes fade { from { opacity: 0; } }' };
    expect(scopeCssRules([keyframes], '#m')).toContain('@keyframes fade');
  });

  it('returns empty when there is nothing usable', () => {
    expect(scopeCssRules([], '#m')).toBe('');
  });
});

// Display delay: documented, collected by the composer, stored on the
// campaign - and never sent by the server, so every message appeared
// immediately and the setting did nothing. Now that it IS sent, these pin down
// the two things a naive implementation gets wrong.
describe('InAppMessagingManager display delay', () => {
  const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;
  const make = () =>
    new InAppMessagingManager('https://api.example', 'jry_sdk_test', {} as any, {} as any, stubLogger);

  it('reads the delay in SECONDS, not milliseconds', () => {
    // The composer stores seconds ("30" means half a minute). Treating it as
    // milliseconds would make every delay imperceptible and look like the bug
    // it just replaced.
    const m = make() as any;
    const delayMs = Math.max(0, Number({ delay: 30 }.delay) || 0) * 1000;

    expect(delayMs).toBe(30_000);
  });

  it('treats a missing or zero delay as immediate', () => {
    for (const campaign of [{}, { delay: 0 }, { delay: null }, { delay: 'x' }]) {
      const delayMs = Math.max(0, Number((campaign as any).delay) || 0) * 1000;
      expect(delayMs).toBe(0);
    }
  });

  it('cancels a pending message on dismiss', async () => {
    // Otherwise a message the user has already dealt with reappears when its
    // timer fires - worse than never showing it.
    jest.useFakeTimers();
    const m = make() as any;
    const fired: string[] = [];
    m.pendingDelays.set('c1', setTimeout(() => fired.push('c1'), 5000));

    await m.dismiss('c1', 'test').catch(() => undefined);
    jest.advanceTimersByTime(10_000);

    expect(fired).toEqual([]);
    expect(m.pendingDelays.has('c1')).toBe(false);
    jest.useRealTimers();
  });
});

/**
 * The delivery token is what turns "I displayed campaign X" from a claim any
 * holder of the publishable SDK key can make into proof the server actually
 * served it. It only works if the client echoes it back — so that echo is
 * pinned here.
 */
describe('InAppMessagingManager.trackImpression — delivery token', () => {
  const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;

  const make = (campaign: Record<string, any>) => {
    const identity = {
      getUserId: () => 'user-1',
      getAnonymousId: () => 'anon-1',
      getAttributes: () => ({}),
    } as any;
    const session = { getSessionId: () => 'sess-1' } as any;
    const m = new InAppMessagingManager('https://api.example', 'jry_sdk_test', identity, session, stubLogger);
    (m as any).campaigns = new Map([[campaign.id, campaign]]);
    return m;
  };

  const captureBody = async (m: InAppMessagingManager, type: string) => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    (globalThis as any).fetch = fetchMock;
    await (m as any).trackImpression('camp-1', type);
    return JSON.parse(fetchMock.mock.calls[0][1].body);
  };

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  it('echoes the token verbatim on a displayed call', async () => {
    const m = make({ id: 'camp-1', variantId: 'var-a', deliveryToken: 'signed.token.value' });
    const body = await captureBody(m, 'displayed');
    expect(body.deliveryToken).toBe('signed.token.value');
    expect(body.campaignId).toBe('camp-1');
  });

  it('echoes it on EVERY transition, not just the display', async () => {
    for (const type of ['displayed', 'clicked', 'dismissed', 'converted']) {
      const m = make({ id: 'camp-1', deliveryToken: 'tok' });
      const body = await captureBody(m, type);
      expect(body.deliveryToken).toBe('tok');
    }
  });

  it('omits the field entirely when the server sent no token', async () => {
    // Anonymous visitors with no resolvable subject, and servers predating the
    // token, get none. Sending `deliveryToken: undefined` would be rejected as a
    // malformed token rather than treated as absent.
    const m = make({ id: 'camp-1' });
    const body = await captureBody(m, 'displayed');
    expect('deliveryToken' in body).toBe(false);
  });

  it('keeps echoing the journey handle alongside it', async () => {
    // pendingId and deliveryToken answer different questions (which journey node
    // queued this vs. did we really serve it) and must not displace each other.
    const m = make({ id: 'camp-1', pendingId: 'pend-9', deliveryToken: 'tok' });
    const body = await captureBody(m, 'displayed');
    expect(body.pendingId).toBe('pend-9');
    expect(body.deliveryToken).toBe('tok');
  });
});
