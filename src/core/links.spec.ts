import { LinkRouter, JoryioLink } from './links';

/**
 * The site-wide link handler (setLinkHandler): the routing decision every
 * surface shares and the refused schemes. The same cases as iOS
 * LinkHandlerTests and Android LinkRouterTest.
 */
describe('LinkRouter', () => {
  const route = (r: LinkRouter, url: unknown) => {
    let fallback = 0;
    const routed = r.route(url, 'placement', { placementKey: 'home_hero', itemId: 'i1' }, () => fallback++);
    return { routed, fallback };
  };

  it('without a handler the fallback runs', () => {
    const r = new LinkRouter();
    expect(r.hasHandler).toBe(false);
    for (const url of ['https://shop.example/sale', 'myapp://cart']) expect({ url, ...route(r, url) }).toEqual({ url, routed: true, fallback: 1 });
  });

  it('a handler that takes the link stops the fallback, and sees every link with its context', () => {
    const r = new LinkRouter();
    const seen: JoryioLink[] = [];
    r.setHandler((link) => (seen.push(link), true));
    expect(route(r, 'https://shop.example/sale')).toEqual({ routed: true, fallback: 0 });
    expect(route(r, ' myapp://cart ')).toEqual({ routed: true, fallback: 0 });
    expect(seen.map((l) => [l.url, l.source, l.isAppDeepLink, l.placementKey, l.itemId])).toEqual([
      ['https://shop.example/sale', 'placement', false, 'home_hero', 'i1'],
      ['myapp://cart', 'placement', true, 'home_hero', 'i1'],
    ]);
    expect(seen[0]).not.toHaveProperty('cardId');
  });

  it('a handler that declines, returns a non-boolean or throws falls back', () => {
    const errors: unknown[] = [];
    const r = new LinkRouter((e) => errors.push(e));
    r.setHandler(() => false);
    expect(route(r, 'https://shop.example')).toEqual({ routed: true, fallback: 1 });
    r.setHandler((() => 'yes') as any);
    expect(route(r, 'https://shop.example')).toEqual({ routed: true, fallback: 1 });
    r.setHandler(() => {
      throw new Error('boom');
    });
    expect(route(r, 'https://shop.example')).toEqual({ routed: true, fallback: 1 });
    expect(errors).toHaveLength(1);
  });

  it('openDefault later runs the fallback once', () => {
    const r = new LinkRouter();
    let held: JoryioLink | null = null;
    r.setHandler((link) => ((held = link), true));
    let fallback = 0;
    r.route('myapp://cart', 'card', { campaignId: 'camp', cardId: 'c1' }, () => fallback++);
    expect(fallback).toBe(0);
    held!.openDefault();
    held!.openDefault();
    expect(fallback).toBe(1);
    expect(held!.cardId).toBe('c1');
  });

  it('refused schemes reach neither the handler nor the page', () => {
    const r = new LinkRouter();
    const handler = jest.fn(() => false);
    r.setHandler(handler);
    for (const url of [
      'javascript:alert(1)', 'data:text/html,x', 'file:///etc/hosts', 'vbscript:x', 'blob:https://x/1', 'about:blank',
      'content://x', 'intent://x#Intent;end', 'mailto:a@b.example', '/relative', '', null, 42,
    ]) expect({ url, ...route(r, url) }).toEqual({ url, routed: false, fallback: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('clearing the handler restores the default', () => {
    const r = new LinkRouter();
    r.setHandler(() => true);
    r.setHandler(null);
    expect(r.hasHandler).toBe(false);
    expect(route(r, 'https://shop.example')).toEqual({ routed: true, fallback: 1 });
  });
});
