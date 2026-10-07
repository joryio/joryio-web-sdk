/**
 * Joryio service worker — hosted at sdk.joryio.com/web/1/joryio-sw.js.
 *
 * Customers drop a 1-line stub at their domain root (`joryio-sw.js`) that
 * does `importScripts('https://sdk.joryio.com/web/1/joryio-sw.js')`.
 * Browsers enforce same-origin on the service worker file itself, but
 * importScripts bypasses that for the imported body — so customers host the
 * stub, we ship the logic.
 *
 * Responsibilities:
 *   - `push` event → render notification from the payload
 *   - `notificationclick` event → open the target URL + beacon a click event
 *   - `pushsubscriptionchange` → silent. The SDK page re-registers on next load
 *     (PushManager.syncExistingSubscription).
 *   - a visitor the page may not track (opted out, consent denied or still
 *     pending, Do Not Track - a flag in Cache Storage) still sees the
 *     notification, but no delivery or click receipt is sent.
 *
 * Payload keys: the push data contract (packages/backend/src/common/push/
 * push-payload.contract.ts) - the same names Android and iOS read. The display
 * fields (title, body, icon, image, actions) sit at the top level of the JSON;
 * the contract keys travel in its `data`.
 */

/** The contract keys this worker reads. Grepped by the backend parity spec. */
const KEY_TRACKING_ID = 'trackingId';
const KEY_DEEP_LINK = 'jry_deep_link';
const KEY_IMAGE_URL = 'jry_image_url';
// Web only: where to report. The worker has no SDK config of its own - it read
// an `apiEndpoint` key that nothing sent, so receipts and clicks never fired.
const KEY_API_ORIGIN = 'jry_api_origin';

// The page records a tracking opt-out here (PushManager.setTrackingOptedOut):
// a worker cannot read localStorage, Cache Storage is shared. Keep in step with
// SW_STATE_CACHE / SW_OPT_OUT_URL in src/core/push.ts.
const SW_STATE_CACHE = 'joryio-sdk-state';
const SW_OPT_OUT_URL = '/__joryio/tracking-opted-out';

/** True when this visitor opted out of tracking: show pushes, report nothing. */
function isTrackingOptedOut() {
  try {
    if (typeof caches === 'undefined') return Promise.resolve(false);
    return caches
      .open(SW_STATE_CACHE)
      .then((cache) => cache.match(SW_OPT_OUT_URL))
      .then((hit) => !!hit)
      .catch(() => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: 'Notification', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Notification';
  const options = buildNotificationOptions(payload);
  // Report that it ARRIVED, then draw it.
  //
  // The service worker is the ONLY place a browser learns a push was received -
  // the page may not be open, and there is no other hook. Web push otherwise
  // had no delivery signal at all, the same hole FCM and APNs leave.
  //
  // Before display on purpose: delivery is "the browser received it", not "the
  // user saw it". A notification the OS collapses or the user never looks at
  // still arrived.
  event.waitUntil(
    Promise.all([
      beaconDeliveredEvent(options.data),
      self.registration.showNotification(title, options),
    ]),
  );
});

/**
 * The notification exactly as the composer set it up. The backend sends
 * `badge`, `tag` (from the group key - a newer push with the same tag replaces
 * the one on screen instead of stacking) and `requireInteraction` (stay until
 * dismissed); this worker used to drop all three, so those composer settings
 * did nothing on web.
 */
function buildNotificationOptions(payload) {
  const data = (payload && payload.data) || {};
  const options = {
    body: payload.body,
    icon: payload.icon,
    actions: payload.actions,
    data,
  };
  // Chrome/Edge only; ignored elsewhere.
  options.image = payload.image || data[KEY_IMAGE_URL];
  if (payload.badge) options.badge = payload.badge;
  if (payload.tag) {
    options.tag = payload.tag;
    // A replacement should still alert, not swap silently.
    options.renotify = true;
  }
  if (payload.requireInteraction === true) options.requireInteraction = true;
  return options;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // `url` is the pre-contract key, still sent for one release so a worker
  // cached from before the rename keeps opening the right page.
  const url = data[KEY_DEEP_LINK] || data.url || '/';

  // The click report is part of the work waitUntil() waits for. It was fired
  // and forgotten after the window opened, so the browser was free to stop
  // the worker before the request left - and the click was not counted.
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url === url && 'focus' in client) {
        await Promise.all([client.focus(), beaconClickEvent(data)]);
        return;
      }
    }
    const opened = self.clients.openWindow ? self.clients.openWindow(url) : Promise.resolve();
    await Promise.all([opened, beaconClickEvent(data)]);
  })());
});

/**
 * Browser may silently rotate the subscription. We can't re-post to the
 * customer backend from here — the SW doesn't know the SDK key/endpoint.
 * The SDK page picks this up on next load via getExistingSubscription().
 */
self.addEventListener('pushsubscriptionchange', () => {
  // no-op
});

/**
 * Best-effort delivery receipt, same shape as the click beacon above.
 *
 * Uses the root-mounted `/track/push/delivered/:trackingId`, which needs NO SDK
 * key - which is the whole reason that route is keyless. A service worker has
 * the trackingId and the API origin and nothing else; a keyed endpoint would
 * have been unreachable from the one place web push can report at all.
 *
 * The server deduplicates by tracking id, so a browser replaying a push after a
 * restart collapses to one event rather than inflating delivery past sends.
 */
function beaconDeliveredEvent(data) {
  return isTrackingOptedOut().then((optedOut) => (optedOut ? undefined : sendDeliveredEvent(data)));
}

function sendDeliveredEvent(data) {
  const endpoint = data && data[KEY_API_ORIGIN];
  const trackingId = data && data[KEY_TRACKING_ID];
  if (!endpoint || !trackingId) return Promise.resolve();

  let origin;
  try {
    origin = new URL(endpoint).origin;
  } catch (_) {
    return Promise.resolve();
  }

  // no-cors: /track/* is not in the SDK CORS allowlist, and we do not read the
  // response. Never rejects - a receipt must not be able to stop the
  // notification it is reporting.
  return fetch(`${origin}/track/push/delivered/${encodeURIComponent(trackingId)}`, {
    method: 'POST',
    mode: 'no-cors',
    keepalive: true,
  }).catch(() => {});
}

/**
 * Best-effort click beacon. The push `data` payload carries a signed
 * `trackingId` that encodes the RECIPIENT (the contact the push was sent to)
 * plus campaign/canvas/variant ids. We hit the dedicated push-click route,
 * which decodes it server-side and logs a `message.clicked` event attributed
 * to that recipient.
 *
 * Why this route and not /v1/track/batch:
 *  - It needs NO SDK key and NO client identity. The previous beacon posted an
 *    identity-less `notification_clicked` to /v1/track/batch, which is rejected
 *    (the batch DTO requires an anonymousId) AND would misattribute anyway — the
 *    browser's current anonymousId can differ from the recipient (e.g. after the
 *    visitor cleared storage). The trackingId is the authoritative recipient.
 *  - The route is mounted at the ROOT (excluded from the /api prefix), so we
 *    take the origin of `jry_api_origin` and drop any path.
 */
function beaconClickEvent(data) {
  return isTrackingOptedOut()
    .then((optedOut) => (optedOut ? undefined : sendClickEvent(data)))
    .catch(() => {});
}

function sendClickEvent(data) {
  const endpoint = data && data[KEY_API_ORIGIN];
  const trackingId = data && data[KEY_TRACKING_ID];
  if (!endpoint || !trackingId) return Promise.resolve();

  let origin;
  try {
    origin = new URL(endpoint).origin;
  } catch (_) {
    return Promise.resolve();
  }

  // GET. no-cors: /track/* isn't in the SDK CORS allowlist, but the
  // server-side click attribution still runs (we don't read the response).
  // Never rejects - a lost report must not break the click.
  return fetch(`${origin}/track/push/click/${encodeURIComponent(trackingId)}`, {
    method: 'GET',
    mode: 'no-cors',
    keepalive: true,
  }).catch(() => {});
}
