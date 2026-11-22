/**
 * The default card feed (`mountCardFeed`), drawn from what the core's
 * CardFeedHost gives it (src/core/cards-ui-contract.ts). Lives in
 * `joryio-cards-ui.min.js`, loaded only by a page that mounts a feed.
 *
 * Text is set as text, never as markup; colors and fonts are the page's.
 */
import type { Card, MountCardFeedOptions } from '../core/cards';
import type { CardFeedHost, CardFeedView } from '../core/cards-ui-contract';
import type { ViewTracker } from '../core/placements';
import { isAppDeepLink, safeHttpUrl } from '../core/placements';

type DrawnCard = { node: HTMLElement; sig: string; tracker: ViewTracker | null };

const DEFAULT_LABELS = { emptyText: 'No messages yet', pinnedLabel: 'Pinned', dismissLabel: 'Dismiss', unreadLabel: 'Unread' };

export function mountFeedView(element: HTMLElement, options: MountCardFeedOptions, host: CardFeedHost): CardFeedView {
  const opts = options || {};
  let removed = false;
  let loadingMore = false;
  /** Drawn card nodes by card key, reused while the card looks the same. */
  let nodes = new Map<string, DrawnCard>();
  let empty: HTMLElement | null = null;

  const root = document.createElement('div');
  root.className = 'joryio-card-feed';
  root.setAttribute('role', 'list');
  const sentinel = document.createElement('div');
  sentinel.className = 'joryio-card-feed-end';
  sentinel.setAttribute('aria-hidden', 'true');
  element.appendChild(root);

  /** A tap: report clicked, then open the url by the placement link rule (the site-wide link handler sees it first). */
  const click = (card: Card): void => {
    host.markCardClicked(card);
    const url = card.url?.trim();
    if (!url) return;
    const context = { campaignId: card.campaignId, cardId: card.id };
    const http = safeHttpUrl(url);
    if (http) {
      host.routeLink(http, context, () => {
        try {
          window.open(http, '_blank', 'noopener');
        } catch (error) {
          host.logger.debug('Could not open the card link', error);
        }
      });
      return;
    }
    if (isAppDeepLink(url)) {
      // The site routes its own links; the SDK never navigates to a custom scheme.
      host.routeLink(url, context, () => {
        if (!opts.onDeepLink) return;
        try {
          opts.onDeepLink(url, card);
        } catch (error) {
          host.logger.error('The mountCardFeed onDeepLink callback threw; ignored:', error);
        }
      });
      return;
    }
    host.logger.warn('Card link refused: not http(s) or an app deep link');
  };

  const label = (k: keyof typeof DEFAULT_LABELS): string => {
    const v = opts[k];
    return typeof v === 'string' ? v : DEFAULT_LABELS[k];
  };

  /** Image on top, a header with the unread dot, the title, the pinned marker and the dismiss control, then the body and the button. */
  const drawCard = (card: Card, generation: number): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'joryio-card';
    el.setAttribute('role', 'listitem');
    el.setAttribute('data-joryio-card', card.id);
    el.setAttribute('data-joryio-card-read', card.read ? 'true' : 'false');
    if (card.pinned) el.setAttribute('data-joryio-card-pinned', 'true');
    el.style.cssText = `position:relative;box-sizing:border-box;padding:12px 16px;${card.url ? 'cursor:pointer;' : ''}`;
    const open = () => !removed && generation === host.generation() && click(card);
    if (card.url) {
      el.setAttribute('tabindex', '0');
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e: any) => {
        if (e?.key === 'Enter' && e?.target === el) open();
      });
    }
    const image = safeHttpUrl(card.imageUrl);
    if (image) {
      const img = document.createElement('img');
      img.className = 'joryio-card-image';
      img.src = image;
      img.alt = '';
      img.style.cssText = 'display:block;max-width:100%;height:auto;margin-bottom:8px;';
      el.appendChild(img);
    }
    const header = document.createElement('div');
    header.className = 'joryio-card-header';
    header.style.cssText = 'display:flex;align-items:center;gap:6px;';
    if (!card.read) {
      const dot = document.createElement('span');
      dot.className = 'joryio-card-unread';
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', label('unreadLabel'));
      dot.textContent = '●';
      dot.style.cssText = 'font-size:10px;line-height:1;';
      header.appendChild(dot);
    }
    const title = document.createElement('div');
    title.className = 'joryio-card-title';
    title.textContent = card.title || '';
    title.style.cssText = 'flex:1;font-weight:bold;';
    header.appendChild(title);
    if (card.pinned) {
      const pinned = document.createElement('span');
      pinned.className = 'joryio-card-pinned';
      pinned.textContent = label('pinnedLabel');
      pinned.style.cssText = 'font-size:0.8em;';
      header.appendChild(pinned);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'joryio-card-dismiss';
    dismiss.setAttribute('aria-label', label('dismissLabel'));
    dismiss.textContent = '×';
    dismiss.style.cssText = 'background:none;border:0;padding:4px 8px;color:inherit;font:inherit;font-size:1.25em;line-height:1;cursor:pointer;';
    dismiss.addEventListener('click', (e: any) => {
      e?.stopPropagation?.();
      if (generation === host.generation()) host.dismissCard(card);
    });
    header.appendChild(dismiss);
    el.appendChild(header);
    if (card.body) {
      const body = document.createElement('div');
      body.className = 'joryio-card-body';
      body.textContent = card.body;
      el.appendChild(body);
    }
    if (card.buttonText && card.url) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'joryio-card-button';
      btn.textContent = card.buttonText;
      btn.style.cssText = 'margin-top:8px;font:inherit;';
      btn.addEventListener('click', (e: any) => {
        e?.stopPropagation?.();
        open();
      });
      el.appendChild(btn);
    }
    return el;
  };

  const render = (): void => {
    if (removed) return;
    const feed = host.view();
    const generation = host.generation();
    const keep = new Map<string, DrawnCard>();
    for (const card of feed.cards) {
      const key = `${card.id}\u0000${card.createdAt}`;
      const sig = JSON.stringify(card);
      const existing = nodes.get(key);
      if (existing && existing.sig === sig) {
        keep.set(key, existing);
        nodes.delete(key);
        continue;
      }
      const node = drawCard(card, generation);
      // Viewed, then read, once at least half the card was on screen for a second.
      const tracker = card.read
        ? null
        : host.trackViewable(node, () => {
            if (generation !== host.generation()) return;
            host.markCardViewed(card);
            host.markCardRead(card);
          });
      keep.set(key, { node, sig, tracker });
    }
    // Cards no longer in the feed (dismissed, expired, another person's) go.
    nodes.forEach((n) => {
      n.tracker?.cancel();
      n.node.remove();
    });
    nodes = keep;
    if (empty) {
      empty.remove();
      empty = null;
    }
    sentinel.remove();
    if (!feed.cards.length) {
      empty = document.createElement('div');
      empty.className = 'joryio-card-feed-empty';
      empty.textContent = label('emptyText');
      empty.style.cssText = 'padding:32px 16px;text-align:center;';
      root.appendChild(empty);
    } else {
      // appendChild moves a node that is already drawn: the order follows the feed.
      keep.forEach((n) => root.appendChild(n.node));
    }
    root.appendChild(sentinel);
    element.setAttribute('data-joryio-card-feed-state', feed.cards.length ? 'filled' : 'empty');
    if (opts.onRender) {
      try {
        opts.onRender(feed, element);
      } catch (error) {
        host.logger.error('The mountCardFeed onRender callback threw; ignored:', error);
      }
    }
  };

  // Load the next page when the end of the feed comes into view.
  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      if (removed || loadingMore || !entries.some((e) => e.isIntersecting)) return;
      loadingMore = true;
      host
        .loadMore()
        .catch(() => undefined)
        .finally(() => {
          loadingMore = false;
        });
    });
    observer.observe(sentinel);
  }

  // The viewability dwell stops while the page is hidden.
  const onVisibility = () => {
    const visible = document.visibilityState !== 'hidden';
    nodes.forEach((n) => {
      if (!n.tracker) return;
      if (visible) n.tracker.resume();
      else n.tracker.pause();
    });
  };
  if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility);

  return {
    render,
    remove() {
      if (removed) return;
      removed = true;
      observer?.disconnect();
      if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility);
      nodes.forEach((n) => n.tracker?.cancel());
      nodes.clear();
      root.remove();
    },
  };
}
