import { InAppMessagingManager } from './inapp';
import { LinkRouter, JoryioLink } from './links';

/**
 * An in-app message's links go through the site-wide link handler
 * (setLinkHandler) first: the HTML bridge's navigate, with a root-relative
 * link resolved against the page, and only http(s) / app deep links at all.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = { getUserId: () => null, getAnonymousId: () => 'anon-1', getAttributes: () => ({}) } as any;
const session = { getSessionId: () => 's-1' } as any;

describe('in-app: the site-wide link handler', () => {
  let open: jest.Mock;
  let top: { location: { href: string } };
  beforeEach(() => {
    open = jest.fn();
    top = { location: { href: 'https://shop.example/home' } };
    (globalThis as any).window = { open, top, location: { href: 'https://shop.example/home' } };
  });
  afterEach(() => {
    delete (globalThis as any).window;
  });

  const make = (handler?: (link: JoryioLink) => boolean) => {
    const m = new InAppMessagingManager('https://api.example', 'jry_sdk_test', identity, session, logger);
    if (handler) {
      m.links = new LinkRouter();
      m.links.setHandler(handler);
    }
    (m as any).installHostBridge();
    (m as any).displayedMessages.set('camp-1', { campaign: { id: 'camp-1' } });
    return (globalThis as any).window.__joryioInApp;
  };

  it('a taken link is not opened; the handler gets the campaign and an absolute url', () => {
    const seen: JoryioLink[] = [];
    const bridge = make((link) => (seen.push(link), true));
    bridge.navigate('camp-1', 'https://shop.example/sale');
    bridge.navigate('camp-1', '/cart', '_top');
    expect(seen.map((l) => [l.url, l.source, l.campaignId])).toEqual([
      ['https://shop.example/sale', 'in_app', 'camp-1'],
      ['https://shop.example/cart', 'in_app', 'camp-1'],
    ]);
    expect(open).not.toHaveBeenCalled();
    expect(top.location.href).toBe('https://shop.example/home');
  });

  it('a declined link opens as without a handler', () => {
    const bridge = make(() => false);
    bridge.navigate('camp-1', 'https://shop.example/sale');
    bridge.navigate('camp-1', '/cart', '_top');
    expect(open).toHaveBeenCalledWith('https://shop.example/sale', '_blank', 'noopener');
    expect(top.location.href).toBe('/cart');
  });

  it('a refused scheme reaches neither the handler nor the page', () => {
    const handler = jest.fn(() => false);
    const bridge = make(handler);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', 'mailto:a@b.example']) bridge.navigate('camp-1', url);
    expect(handler).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('without a router (no SDK) the link opens directly', () => {
    const bridge = make();
    bridge.navigate('camp-1', 'https://shop.example/sale');
    expect(open).toHaveBeenCalledTimes(1);
  });
});
