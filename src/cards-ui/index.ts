/**
 * The default card feed bundle - `joryio-cards-ui.min.js` on the SDK host,
 * next to `joryio.min.js` (BACKLOG D444).
 *
 * Loaded by the core (src/core/cards.ts) the first time the page calls
 * `mountCardFeed`, so a visitor of a site without a feed never downloads it.
 * It registers one global and does nothing else on its own: no request, no
 * listener, until the core calls `mount` with a CardFeedHost.
 *
 * A bundler user who does not want the SDK host fetch imports this file once
 * (`import '@joryio/web-sdk/dist/joryio-cards-ui.min.js'`): the core finds the
 * global and draws at once.
 */
import { mountFeedView } from './card-feed-view';
import { CARDS_UI_API_VERSION, CARDS_UI_GLOBAL, type CardsUiBundleApi } from '../core/cards-ui-contract';

const api: CardsUiBundleApi = {
  version: CARDS_UI_API_VERSION,
  mount: mountFeedView,
};

if (typeof window !== 'undefined' && !(window as any)[CARDS_UI_GLOBAL]) {
  (window as any)[CARDS_UI_GLOBAL] = api;
}

export { api as cardsUiApi };
