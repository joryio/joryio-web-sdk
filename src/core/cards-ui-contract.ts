/**
 * The contract between the core (src/core/cards.ts) and the default card feed
 * renderer, `joryio-cards-ui.min.js` (src/cards-ui/), a separate file next to
 * `joryio.min.js` on the SDK host (BACKLOG D444). Only a page that calls
 * `mountCardFeed` downloads it; the data API (getCards, markCard*, ...) stays
 * in the core.
 *
 * The renderer registers one global, `__joryioCardsUi`, and nothing else. The
 * core reads it once, checks `version`, keeps the reference, and hands each
 * mount a `CardFeedHost`: what the renderer may do is exactly what the public
 * API already lets a page do (read the feed, report viewed / read / clicked /
 * dismissed, pass a link to its own link handler, load the next page) - never
 * the delivery tokens, the request code or the storage. A page that replaced the global
 * would get nothing it could not already call on `window.Joryio`.
 *
 * Type-only imports: nothing of the core is bundled into the renderer through here.
 */
import type { Card, CardFeed, MountCardFeedOptions } from './cards';
import type { ViewTracker } from './placements';
import type { Logger } from '../utils/logger';

export const CARDS_UI_GLOBAL = '__joryioCardsUi';
/** Bumped on a breaking change to CardFeedHost / CardsUiBundleApi; a renderer of another version is refused. */
export const CARDS_UI_API_VERSION = 1;
/** The file next to joryio.min.js on the SDK host (and in the npm package's dist/). */
export const CARDS_UI_BUNDLE_FILE = 'joryio-cards-ui.min.js';

/** What one mounted feed may ask of the core. */
export interface CardFeedHost {
  /** The feed now (cached, with this browser's read / dismissed state applied). */
  view(): CardFeed;
  /** Bumped when the person or the consent changes: a node drawn under an older one does nothing. */
  generation(): number;
  markCardViewed(card: Card): void;
  markCardRead(card: Card): void;
  markCardClicked(card: Card): void;
  dismissCard(card: Card): void;
  /** Hand a card link to the site-wide link handler (`setLinkHandler`); `fallback` runs when there is none or it declined. */
  routeLink(url: string, context: { campaignId?: string; cardId?: string }, fallback: () => void): void;
  /** Load the page after the feed's nextCursor, if any (a no-op on the last page). */
  loadMore(): Promise<void>;
  /** The viewability rule (half the card on screen for the dwell), the same as placements'. */
  trackViewable(node: Element, onViewable: () => void): ViewTracker;
  logger: Logger;
}

/** One drawn feed. */
export interface CardFeedView {
  /** Redraw from host.view() (the core calls it on every feed change). */
  render(): void;
  /** Take out everything drawn and stop observing. */
  remove(): void;
}

export interface CardsUiBundleApi {
  version: number;
  mount(element: HTMLElement, options: MountCardFeedOptions, host: CardFeedHost): CardFeedView;
}
