# Changelog

## 1.4.0 - 2026-11-18

Added: recognise people who click your messages (Joryio BACKLOG D407). A tracked link from a Joryio message lands with `jr_t`, an opaque token Joryio signs and encrypts (no personal data in it, 7 days; added only to links to the workspace's own websites). On load the SDK removes `jr_t` from the address bar with `history.replaceState` - before the landing page is recorded, so the token is never bookmarked, shared or stored; `jr_cid` / `jr_jid` / utm_* stay - and, only while tracking is allowed (consent granted, not opted out, Do Not Track respected; held in memory while consent is `pending`, dropped on a denial or opt-out), sends it once to `POST /v1/identify-link` as `{ token, anonymousId }`. The server uses it only to attribute this visitor's events (Session Start, page views, conversions) to the recipient - it never identifies the browser as the contact. Not sent when a user is identified on the browser or a storefront identity token is held for this visitor - a link never overrides a stronger identity. New method `identifyFromLink(url)` for single-page apps and routers (also stubbed by the snippet). The same name and wire on all five SDKs.

Added: `resetTo(anonymousId)` - everything `reset()` does, then the anonymous id you pass instead of a random one, for an app that keeps its own visitor id (BACKLOG D366). The id must be 8 to 255 letters, digits, `.`, `_`, `:` or `-`, must not have the shape of a Joryio profile id (24 lowercase hex) and must not be the user id the SDK holds; a refused id is logged and the call is a plain `reset()` (a random id), so a logout is never skipped. The same name and rule on all five SDKs. No wire changes: the server sees an ordinary anonymous id. Like `reset()`, `resetTo` drops a click-link token the SDK has not sent yet (one held while consent is pending), so the link is never attributed to the next visitor on the browser. Also stubbed by the snippet.

Changed (BACKLOG D366, before any release of resetTo): it also refuses the anonymous id the SDK holds while a user is signed in - that id is tied to the signed-in person's profile, and adopting it would hand their in-app messages, events, form attribution and push subscription to the next person on a shared device (a random id is used instead). `resetTo` now resolves `true` (adopted) or `false` (refused, or the SDK is not initialized). The same on all five SDKs.

Changed (BACKLOG D366): `resetTo` also refuses the last 20 anonymous ids this device held for a signed-in user when a reset signed them out (stored locally, newest kept; `wipeData()` forgets them) - a random id is used and it answers `false`, the same message and cap on all five SDKs.

Added: the storefront identity token, for the Joryio store plugins. `storefrontIdentityToken` (init) / `setStorefrontIdentityToken(token)` set a token Joryio signs for a signed-in store customer's browser, bound to one anonymous id; `storefrontIdentityTokenProvider` (init) / `setStorefrontIdentityTokenProvider(fn)` supply a fresh one. Sent as `X-Joryio-Auth` on ANONYMOUS requests only, and only while the token's `vid` is the SDK's anonymous id and the request's; independent of `enableSdkAuthentication`. Not sent within 30 seconds of its expiry (the provider is asked instead). A `401 storefront_identity_error` refreshes it (`expired`) or drops it (any other reason) and retries once; an in-app form is sent once more the same way. `reset()` and `wipeData()` drop it. Both setters are stubbed by the snippet. Wire: the header is the existing `X-Joryio-Auth`; nothing changes for sites that do not set it.

Fixed: the `push_permission` profile attribute is reported only on a site that uses web push. It used to be written on every page load where it had changed - for a new visitor, always - even on a site that never turned web push on (for example the WordPress plugin with only in-app messages on): a `/v1/attributes` request per new visitor that said nothing anyone could act on and, for an anonymous visitor the SDK sent nothing else for, created a profile of its own.

Added: the `webPush` init option. `true`: reported on page load, as before. Unset (the default): reported once this browser has used web push - `push.subscribe()` was called or `push.prepare()` succeeded, on this or an earlier page view, or an earlier SDK version registered it - and from then on whenever it changes. `false`: never on page load; a `push.subscribe()` on the page still reports its answer. The WordPress, WooCommerce, Magento and PrestaShop plugins pass their Web push setting. Values and change detection unchanged (`granted`, `denied`, `not_determined`, `unavailable`, sent only when different from what the server acknowledged). No wire changes.

## 1.3.3 - 2026-11-03

Fixed: an in-app message counts as displayed only once someone could have seen it. It used to be counted - `in_app.displayed` reported and the campaign's frequency cap spent - the moment it was put on the page, so a message that appeared during a sign-in redirect, or just as someone clicked a logout link, used up the cap while it was visible for a flash at most. Now:

- a message appears only once the page has finished loading and gone idle, and never while the page is unloading (`beforeunload` / `pagehide`);
- it counts as displayed after it has been on screen for `IN_APP_DISPLAY_DWELL_MS` (1000 ms) with the tab visible. If the tab is hidden first the timer starts again when it is visible; if the page unloads first, nothing is reported, the frequency cap is untouched, and the message is eligible again on the next page;
- a click or a close by the person before then counts as seen: `displayed` is reported first, then the click or dismissal. Removal by the SDK or by your code (`dismissInAppMessage`, `reset()`) before then reports nothing.

Changed: `inApp.displayOptions.onDisplay` fires when the message counts as displayed, together with the `displayed` report, rather than when it is put on screen - the same timing as `onMessageDisplay` on iOS. `IN_APP_DISPLAY_DWELL_MS` is exported. No wire changes.

Fixed: the script-tag file (`joryio.min.js`, `joryio.umd.js`) is safe on a page with an AMD loader such as RequireJS (every Magento Luma store). Loaded by a plain `<script>`, the old UMD wrapper called an anonymous `define()`, which RequireJS attached to another module that was loading or reported as "Mismatched anonymous define() module" - and the SDK did not start. The SDK now always starts and sets `window.Joryio`; on an AMD page it defines an anonymous module only when RequireJS itself requested the file, and otherwise the named module `joryio-web-sdk`. Loading it with `require()` under any module id, as a CommonJS module or from npm (`import` / `require`) is unchanged.

## 1.3.2 - 2026-10-25

No change from the in-app hold added to the other four SDKs in this version (`holdInAppMessagesForHandler`): the web SDK always draws its own in-app messages and has no handler that takes drawing over after `init()` - its `inApp` hooks are passed in the init config, before the first sync - so the window that option closes does not exist here.

## 1.3.1 - 2026-10-24

Fixed: HTML modals and slide-ups are responsive. The message frame used to start narrow and take the width the content reported, so the author's media queries (for example `@media (max-width: 560px)`) fired even on a desktop screen. The frame is now given min(maxWidth, viewport width - 16px on each side) before the content loads (`maxWidth` comes from the "Max width" field in the dashboard; modal 600 and slide-up 400 when unset), re-fits when the window is resized, and only its height follows the content.

Fixed: the height is measured from the message body, so a message can shrink as well as grow (a form replaced by its thank-you line).

No API changes. Banner and fullscreen messages are unchanged.

## 1.3.0 - 2026-10-06

First public release.
