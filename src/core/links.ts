import { isAppDeepLink, safeHttpUrl } from './placements';

/**
 * Where a link the SDK is about to open came from. The same wire values on
 * every Joryio SDK, pinned by the backend spec sdk-link-handler-parity.spec.ts.
 * `push` is not emitted on web: a web push click is handled by the service
 * worker, outside any page, where no page handler can run.
 */
export type JoryioLinkSource = 'in_app' | 'placement' | 'card' | 'push';

/** A link the SDK is about to open, handed to the site's link handler first (`setLinkHandler`). */
export interface JoryioLink {
  /** An http(s) link (a root-relative in-app link resolved against the page) or an app deep link (`myapp://cart`). */
  url: string;
  source: JoryioLinkSource;
  /** The in-app message's or card's campaign, when known. */
  campaignId?: string;
  /** The placement the link was clicked in (source `placement`). */
  placementKey?: string;
  /** The placement item (source `placement`). */
  itemId?: string;
  /** The card (source `card`). */
  cardId?: string;
  /** True for an app-scheme link, false for http(s). */
  isAppDeepLink: boolean;
  /**
   * Do what the SDK does without a handler: http(s) opens (a new tab, or the
   * page itself for an in-app link that targets it), an app deep link goes to
   * the mount's `onDeepLink`. Runs at most once. Called later than the click,
   * the browser may block a new tab: decide inside the handler where you can.
   */
  openDefault: () => void;
}

/** Return true to take the link over (route it in your app), false to let the SDK open it. */
export type JoryioLinkHandler = (link: JoryioLink) => boolean;

export interface LinkContext {
  campaignId?: string;
  placementKey?: string;
  itemId?: string;
  cardId?: string;
}

/**
 * The one way the in-app renderer, placements and the card feed open a link:
 * refused schemes stop here, the site's handler goes first, then the
 * surface's own fallback.
 */
export class LinkRouter {
  private handler: JoryioLinkHandler | null = null;

  constructor(private onHandlerError: (error: unknown) => void = () => undefined) {}

  setHandler(handler: JoryioLinkHandler | null): void {
    this.handler = typeof handler === 'function' ? handler : null;
  }

  get hasHandler(): boolean {
    return this.handler !== null;
  }

  /**
   * Route `url`: the handler first, then `fallback`. Only http(s) and app deep
   * links are routed; anything else (javascript:, data:, intent:, ...) is
   * dropped and false returned. Synchronous, so the click's user activation
   * still holds when the fallback opens a tab.
   */
  route(url: unknown, source: JoryioLinkSource, context: LinkContext, fallback: () => void): boolean {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    const appLink = isAppDeepLink(trimmed);
    if (!safeHttpUrl(trimmed) && !appLink) return false;
    let done = false;
    const openDefault = () => {
      if (done) return;
      done = true;
      fallback();
    };
    const link: JoryioLink = { url: trimmed, source, ...definedOnly(context), isAppDeepLink: appLink, openDefault };
    const handler = this.handler;
    if (handler) {
      let taken = false;
      try {
        taken = handler(link) === true;
      } catch (error) {
        // A throwing handler declines: the link still opens.
        this.onHandlerError(error);
      }
      if (taken) return true;
    }
    openDefault();
    return true;
  }
}

function definedOnly(context: LinkContext): LinkContext {
  const out: LinkContext = {};
  for (const key of ['campaignId', 'placementKey', 'itemId', 'cardId'] as const) {
    const value = context[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}
