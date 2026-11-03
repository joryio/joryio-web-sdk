# Changelog

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
