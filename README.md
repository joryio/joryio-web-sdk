# Joryio Web SDK

The Joryio SDK for websites: identify visitors, track events, show in-app messages and send web push, all through your Joryio workspace.

## Features

- **Event tracking** with batching (50 events or 5 seconds by default), retry with exponential backoff, and a queue persisted to `localStorage` (memory fallback)
- **Identity** - anonymous ID out of the box, `identify`, and labelled aliases (`addAlias`)
- **User attributes** - set, increment, unset, add to and remove from arrays
- **In-app messages** displayed for you, with impressions, clicks and dismissals tracked automatically
- **Web push** through a service worker you host on your own origin
- **E-commerce helpers** that send the standard event names Joryio reports on
- **Subscription preferences** per channel and subscription group
- **Privacy controls** - opt-out, consent state, and Do Not Track honoured by default
- **SDK authentication** (optional) - a customer-minted JWT on every ingest request
- **UTM capture** and session tracking
- **TypeScript** definitions included

## Requirements

- A Joryio workspace and a **web SDK key** (`jry_sdk_web_...`) from **Settings → Apps** in the dashboard. A mobile app's key (`jry_sdk_ios_...`, `jry_sdk_android_...`) is refused: the SDK logs why and stays inactive
- A modern browser (current Chrome, Edge, Firefox and Safari). Web push additionally needs a browser with the Push API and a secure (HTTPS) origin

## Installation

### Option 1: Async snippet (recommended)

Add this to your `<head>`. Calls made before the SDK finishes loading are queued and replayed in order. Every public method can be called this way, and `init` itself may come later - for example from your consent banner's callback - with the calls before it kept until it arrives. The queue holds at most 1,000 calls; beyond that the oldest are dropped - never `init`, `optOut()`, `optIn()`, `updateConsent()` or `wipeData()`.

Privacy decisions are the exception to "replayed in order": a queued `optOut()`, `optIn()` or `updateConsent()`, and a `wipeData()` queued before `init`, are applied **inside** `init`, before it sends anything - so `joryio.updateConsent('denied')` written above `joryio.init(...)` means no Session Start, in-app sync or push registration ever goes out. A queued `track()`, attribute write, `addAlias()` or `trackInAppConversion()` made while the visitor was opted out or consent was denied - by the stored choice, the init config or a decision queued before it - is dropped, and a later queued `optIn()` or `updateConsent('granted')` does not bring it back; `identify()` and unsubscribes are kept. The same goes for one queued before a queued `optOut()` or `updateConsent('denied')`, or before a `wipeData()` queued ahead of `init`. A `ready()` callback queued while tracking was off, or before a queued `optOut()` or `updateConsent('denied')`, still runs, but the `track()` calls, attribute writes, aliases, conversions and subscribes it makes while it runs are dropped too - unless the callback itself lifts what turned tracking off, for the rest of it: its own `optIn()` lifts an opt-out, its own `updateConsent('granted')` lifts a denial, neither lifts the other, and nothing inside it lifts an `optOut()` or denial queued after it. A `wipeData()` queued ahead of `init` does not gate a `ready()` callback queued before it (the callback runs for the fresh visitor). Reads and unsubscribes work, and the SDK instance it was handed behaves normally afterwards.

If `init` fails (a missing or malformed SDK key - the reason is logged to the console), nothing queued is lost: `window.joryio` stays the queue, and calling `joryio.init({...})` again with the right key starts the SDK with every call made so far, privacy decisions first, then the rest in order - an unsubscribe included.

```html
<script>
  !function(){var e=window.joryio=window.joryio||[];if(!e.initialize)if(e.invoked)window.console&&console.error&&console.error("Joryio snippet included twice.");else{e.invoked=!0,e.methods=["init","track","identify","addAlias","setAttributes","setAttribute","incrementAttribute","unsetAttribute","addToArray","removeFromArray","reset","flush","optOut","optIn","updateConsent","getTrackingConsent","isUserOptedOut","setSdkAuthenticationToken","setSdkAuthenticationErrorCallback","getAnonymousId","getUserId","ready","getIdentity","getSessionInfo","getUTMData","updateUTM","syncInAppCampaigns","getInAppCampaigns","displayInAppCampaign","dismissInAppMessage","trackInAppConversion","ecommerce","wipeData","destroy"],e.keep=["init","optOut","optIn","updateConsent","wipeData"],e.factory=function(t){return function(){var n=Array.prototype.slice.call(arguments);if(n.unshift(t),e.length>=1e3)for(var i=0;i<e.length;i++)if(e.keep.indexOf(e[i][0])<0){e.splice(i,1);break}return e.push(n),/^(get|is)[A-Z]/.test(t)?void 0:e}};for(var t=0;t<e.methods.length;t++){var n=e.methods[t];e[n]=e.factory(n)}e.load=function(e){var t=document.createElement("script");t.type="text/javascript",t.async=!0,t.src="https://sdk.joryio.com/web/1/joryio.min.js";var n=document.getElementsByTagName("script")[0];n.parentNode.insertBefore(t,n)},e.load()}}();
  joryio.init({ sdkKey: 'jry_sdk_web_YOUR_SDK_KEY' });
</script>
```

A queued call cannot return a value before the SDK has loaded: a getter such as `getUserId()` or `isUserOptedOut()` returns `undefined` until then. To read an ID - or to use `user`, `push` or the tracker `ecommerce()` returns - use `ready`:

```javascript
joryio.ready(function (sdk) {
  var anonymousId = sdk.getAnonymousId();
  var userId = sdk.getUserId(); // null until identify()
  sdk.user.setSubscription('email', 'optedIn');
});
```

### Option 2: npm

```bash
npm install @joryio/web-sdk
```

```javascript
import JoryioSDK from '@joryio/web-sdk';

const joryio = new JoryioSDK({
  sdkKey: 'jry_sdk_web_YOUR_SDK_KEY',
});
```

### Option 3: script tag

```html
<script src="https://sdk.joryio.com/web/1/joryio.min.js"></script>
<script>
  // The script tag exposes the SDK class as window.Joryio
  const joryio = new Joryio({
    sdkKey: 'jry_sdk_web_YOUR_SDK_KEY',
  });
</script>
```

### CDN paths

The SDK files are served from one global host, `https://sdk.joryio.com`:

| Path | What you get |
|------|--------------|
| `/web/1/<file>` | The newest 1.x release - recommended. Picks up fixes, never a breaking change |
| `/web/<version>/<file>` | One exact version, e.g. `/web/1.3.0/joryio.min.js`. Its contents never change |

Files: `joryio.min.js` (the SDK), `joryio-sw.js` (the web push service worker) and `joryio.umd.js` (unminified UMD build).

Only the file location is global. Events and API calls go to your region's API host (the `apiEndpoint` option).

## Quick start

### Initialize

With npm (`import JoryioSDK from '@joryio/web-sdk'`; `import { JoryioSDK }` works too). The package has an `exports` map with an ES module build for `import` and a CommonJS build for `require` (bundlers - webpack, esbuild, Rollup, Vite - use the ES module build for both, so an app that imports it in one file and requires it in another still gets one SDK), so the default import is the class in bundlers and in Node ESM (SSR, Vitest, `.mjs` scripts) alike, and TypeScript types it the same way with `moduleResolution` `node16`, `nodenext` or `bundler`. With the script tag the class is `window.Joryio` - write `new Joryio({...})` - and with the async snippet call `joryio.init({...})`.

```javascript
const joryio = new JoryioSDK({
  sdkKey: 'jry_sdk_web_YOUR_SDK_KEY',
  apiEndpoint: 'https://api-eu1.joryio.com/api', // your region's API host; a bare host also works, /api is added
  enableDebug: false,
});
```

### Track events

```javascript
joryio.track('Button Clicked');

joryio.track('Product Viewed', {
  productId: 'abc123',
  category: 'Electronics',
  price: 299.99,
});
```

### Identify users

```javascript
joryio.identify('user-123');
joryio.setAttributes({
  email: 'user@example.com',
  name: 'Jane Doe',
  plan: 'premium',
});
```

### User attributes

```javascript
joryio.setAttributes({ totalPurchases: 5 });
joryio.setAttribute('language', 'en');
joryio.incrementAttribute('pageViews', 1);
joryio.unsetAttribute('temporaryFlag');
joryio.addToArray('interests', 'running');
joryio.removeFromArray('interests', 'cycling');
```

### Reset on logout

```javascript
// Clears the user identity and starts a fresh anonymous session
joryio.reset();
```

The new anonymous ID is in place as soon as `reset()` returns - the returned promise only covers delivering what was queued - so `reset(); identify(nextUser)` is safe without `await`. The previous user's SDK authentication token is forgotten. Their attribute, alias and subscription writes that were not acknowledged yet are still sent, with their own IDs, never the next visitor's. Calling `identify('B')` while user A is signed in, without `reset()`, does the same for A's queued writes and token.

A `null` or `undefined` value in `setAttributes` / `setAttribute` removes the attribute, the same as `unsetAttribute`.

A value JSON cannot carry - `NaN`, `Infinity`, a `BigInt`, a function, an object that refers to itself - is dropped where it enters, with a warning in the log: that attribute key (or that event property) is left out and the rest of the call goes ahead. One bad value never holds up other writes.

## Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sdkKey` | `string` | **required** | Your web SDK key |
| `apiEndpoint` | `string` | `https://api-eu1.joryio.com/api` | Your region's API host. A bare host works; `/api` is added |
| `userId` | `string` | - | Start with a known user ID |
| `anonymousId` | `string` | generated | Use your own anonymous ID |
| `batchSize` | `number` | `50` | Events per request (at most 500, the API's limit) |
| `batchFlushInterval` | `number` | `5000` | Flush interval in ms (at least `1000`; lower values are raised to it) |
| `sendImmediately` | `boolean` | `false` | Send each event immediately instead of batching |
| `maxQueueSize` | `number` | `1000` | Most events held while sends fail. The oldest are dropped beyond it - the only way an undelivered event is ever dropped |
| `persistQueue` | `boolean` | `true` | Persist the queue to `localStorage` |
| `maxRetries` | `number` | `3` | Immediate retries of one request (5xx, 429, network error). A batch that still fails is kept and retried later |
| `retryBackoffMs` | `number` | `1000` | Initial retry backoff in ms; doubles per failure, up to 5 minutes |
| `requestTimeout` | `number` | `10000` | Timeout in ms for each API request (events, attributes, in-app, push) |
| `sessionTimeout` | `number` | `1800000` | Inactivity (ms) before a new session starts. Checked on every `track()` and when the tab becomes visible again |
| `trackSessionStart` | `boolean` | `true` | Track one "Session Start" per new session (a reload that resumes the session sends none) |
| `trackPageViews` | `boolean` | `false` | Track "Page Viewed" on page load |
| `trackPageProperties` | `boolean` | `true` | Include referrer and landing page in events |
| `trackDeviceProperties` | `boolean` | `true` | Include device info in events |
| `captureUTM` | `boolean` | `true` | Capture UTM parameters from the URL |
| `resetSessionOnNewCampaign` | `boolean` | `false` | Start a new session when the UTM campaign changes |
| `respectDoNotTrack` | `boolean` | `true` | Honour the browser's Do Not Track setting |
| `optOut` | `boolean` | `false` | `true` opts the visitor out (remembered, like `optOut()`). `false` does not lift a stored opt-out - only `optIn()` does |
| `trackingConsent` | `string` | unset | `'granted'`, `'denied'` or `'pending'`. Leave it unset if your site has no consent banner - see [Privacy controls](#privacy-controls) |
| `enableSdkAuthentication` | `boolean` | `false` | Attach and refresh a customer-minted `X-Joryio-Auth` JWT (see [SDK authentication](#sdk-authentication-optional)) |
| `sdkAuthenticationToken` | `string` | - | Initial JWT, used when `enableSdkAuthentication` is true |
| `inApp` | `object` | see below | In-app messaging options |
| `enableDebug` | `boolean` | `false` | Log everything to the console (`logLevel: 'debug'`). An explicit `logLevel` wins |
| `logLevel` | `string` | - | `'error'`, `'warn'`, `'info'` or `'debug'`. Nothing is logged unless this or `enableDebug` is set |
| `plugins` | `Plugin[]` | `[]` | SDK plugins (web only - see [Plugins](#plugins)) |

`inApp` options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Turn in-app messaging on or off |
| `evaluationMode` | `string` | `'differential-sync'` | When campaigns are fetched. `'differential-sync'`: on load, `identify()`, `reset()`, a new session, a change to a watched attribute, and every `syncInterval`. `'session-start-only'`: on load, `identify()`, `reset()` and a new session only |
| `syncInterval` | `number` | `0` (off) | Re-fetch campaigns every N ms in `'differential-sync'` mode. Values below `30000` are raised to `30000`; paused while the tab is hidden |
| `allowHtmlJsInAppMessages` | `boolean` | `false` | Allow HTML in-app messages (see below) |
| `displayOptions.defaultPosition` | `string` | `'center'` | `'top'`, `'center'` or `'bottom'`: where a `custom`-type message sits. Modal, banner, slide-up and full-screen messages keep their own placement |
| `displayOptions.defaultAnimation` | `string` | `'fade'` | `'fade'`, `'slide'` or `'none'`: how messages enter. Skipped when the visitor's system asks for reduced motion |
| `displayOptions.backdropColor` | `string` | `'rgba(0, 0, 0, 0.5)'` | Colour of the dim layer behind modal and full-screen messages |
| `displayOptions.closeButtonColor` | `string` | the message's text colour | Colour of the close button |
| `displayOptions.zIndex` | `number` | `999999` | Stacking order of messages (the backdrop sits one below) |
| `onMessageDisplay` / `onMessageClick` / `onMessageDismiss` | `function` | - | Callbacks for each lifecycle step. A callback that throws is logged and ignored; the SDK's own bookkeeping carries on |

## In-app messaging

The SDK displays in-app messages for you. Eligible campaigns appear on their own, and impressions, clicks and dismissals are tracked automatically.

Messages arrive in one of two shapes:

- **Native** - structured data (headline, body, image, buttons) written into plain DOM elements as text nodes. No iframe, no script execution.
- **HTML** - author-supplied markup and CSS, shown in a sandboxed iframe.

**HTML messages are off by default.** Joryio strips scripts and event handlers from HTML messages before sending them, but the iframe runs the SDK's own bootstrap and can execute script at your page's origin, so the residual risk is a sanitiser bypass. Opting in is a decision for your own team:

```javascript
const joryio = new JoryioSDK({
  sdkKey: 'jry_sdk_web_YOUR_SDK_KEY',
  inApp: {
    allowHtmlJsInAppMessages: true, // default: false
  },
});
```

Leaving it off does **not** disable in-app messaging: native messages still display. HTML campaigns are skipped (with a warning in the log when logging is on - see `logLevel`).

An HTML message can never navigate its own frame: links and redirects go through the SDK, which opens them on your page (`http(s)` and root-relative links only). The frame may load only the message itself - if it navigates anyway, the message is closed - and the message's CSS cannot end its `<style>` element.

If your Content Security Policy forbids inline scripts or framed content, leave this off and author your campaigns as native messages.

Manual control, when you need it:

```javascript
await joryio.syncInAppCampaigns();               // fetch campaigns now
const campaigns = joryio.getInAppCampaigns();    // what is currently eligible
await joryio.displayInAppCampaign(campaignId);   // show one now
joryio.dismissInAppMessage(campaignId);
await joryio.trackInAppConversion(campaignId, 'Order Completed');
```

## Web push

Web push needs a service worker on **your own origin** (browsers require it). Host a file named `joryio-sw.js` at the root of your site containing one line:

```javascript
importScripts('https://sdk.joryio.com/web/1/joryio-sw.js');
```

Then ask for permission from a user gesture, such as a button click:

```javascript
if (joryio.push.isSupported() && joryio.push.getPermissionState() === 'notDetermined') {
  button.onclick = () => joryio.push.subscribe();
}
```

| Method | Description |
|--------|-------------|
| `push.isSupported()` | Whether this browser can do web push at all |
| `push.getPermissionState()` | `'granted'`, `'denied'`, `'notDetermined'` or `'unavailable'` - the same names as every Joryio SDK |
| `push.prepare(options?)` | Pre-register the service worker so the later `subscribe()` is fast |
| `push.subscribe(options?)` | Prompt (if needed), subscribe and register this browser with Joryio |
| `push.getExistingSubscription(options?)` | The current subscription, without prompting |
| `push.unsubscribe(options?)` | Remove this browser's subscription and unregister it with Joryio. It stays unsubscribed on later visits until `subscribe()` is called again. Never rejects; resolves `false` when nothing could be removed |

`options` takes `swPath` (default `'/joryio-sw.js'`) and `scope` (default `'/'`) if you host the worker elsewhere.

You do not need to call `subscribe()` again on later visits. When permission is already granted, the SDK checks the browser's subscription on load and registers it again if the browser rotated it, if your workspace's VAPID key changed (it re-subscribes without a prompt), or after `reset()` (so the subscription follows the new anonymous visitor rather than the user who logged out) - unless `unsubscribe()` was called. Each registration carries the SDK's stable device ID. Nothing is registered while tracking is opted out or consent is pending.

The service worker shows the push with its title, body, icon, image, badge, actions, `tag` (a newer push with the same tag replaces the one on screen) and `requireInteraction` (stays until dismissed), as the campaign set them.

The service worker shows each push, reports its delivery and records the click. It reads these keys from the push's `data`, the same names the Android and iOS SDKs read:

| Key | Effect |
|-----|--------|
| `trackingId` | Used for the delivery receipt and for click tracking. Absent on test sends, which are not counted |
| `jry_deep_link` | The page a click opens (the site root when absent) |
| `jry_image_url` | Large image, in browsers that show one |
| `jry_api_origin` | Where the worker sends the receipt and the click |
| `jry_campaign_id` | The campaign id, or the journey id for a journey send. Informational |

## E-commerce

The e-commerce helper sends the standard event names that Joryio's revenue reporting and attribution read, so you do not have to spell them yourself:

```javascript
const ecommerce = joryio.ecommerce({ currency: 'USD' });

ecommerce.viewProduct({ productId: 'SKU123', name: 'Blue Shirt', price: 29.99 });
ecommerce.addToCart({ productId: 'SKU123', name: 'Blue Shirt', price: 29.99, quantity: 1 });
ecommerce.purchase({
  orderId: 'ORD123',
  items: [{ productId: 'SKU123', name: 'Blue Shirt', price: 29.99, quantity: 1 }],
  value: 29.99,
});
```

Also available: `viewCategory`, `search`, `removeFromCart`, `cartViewed`, `updateCart`, `startCheckout`, `addPaymentInfo`, `orderFulfilled`, `orderDelivered`, `orderCancelled`, `orderRefunded`, `addToWishlist`, `removeFromWishlist`, `shareProduct`, `applyCoupon`, `removeCoupon` and `submitReview`. See [E-commerce tracking](https://docs.joryio.com/developers/sdk/ecommerce-tracking).

Every helper checks its required arguments - a `productId`, an `orderId`, a finite order `value`, an `items` array. When one is missing it logs a warning and sends nothing (never an empty or zero-value order), and it never throws into your page. `ecommerce()` takes one option, `currency` (default `'USD'`).

## Advanced usage

### Plugins

Plugins are a **web-only** feature: the mobile, React Native and Unity SDKs have no plugin API. A plugin can inspect, change or block every event before it is queued.

```javascript
const myPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  load(sdk) {},
  unload() {},
  beforeTrack(event) {
    // Modify the event, or return null to block it
    return event;
  },
  afterTrack(event) {},
};

const joryio = new JoryioSDK({
  sdkKey: 'jry_sdk_web_YOUR_SDK_KEY',
  plugins: [myPlugin],
});
```

To turn a plugin off, leave it out of `plugins`. A plugin hook that throws is logged and the event is kept unchanged.

### Flushing

```javascript
await joryio.flush();
```

`flush()` sends now, skipping the SDK's own retry backoff - but never a `Retry-After` the API asked for.

### Privacy controls

Two independent switches decide whether anything is collected: **consent** (your cookie banner's answer) and the visitor's own **opt-out**. The SDK collects only when consent is granted **and** the visitor has not opted out - any "no" wins.

```javascript
joryio.updateConsent('granted'); // or 'denied' or 'pending'
joryio.optOut();                 // remembered across page loads until optIn()
joryio.optIn();

joryio.ready(function (sdk) {
  sdk.getTrackingConsent();      // 'granted' | 'denied' | 'pending'
  sdk.isUserOptedOut();          // the opt-out switch only
});
```

| State | What the SDK does |
|-------|-------------------|
| Consent `granted` (or never set, with no stored denial) | Collects and sends normally |
| Consent `pending` | Collects locally and sends **nothing** - no Session Start, no in-app sync, no push registration - until `updateConsent('granted')` releases it all. `updateConsent('denied')` discards it. What is held, all kept in `localStorage` so a reload does not lose it: events and `identify` (up to `maxQueueSize` events), attribute writes (up to 500) and alias and subscription changes (up to 200). Unsubscribes are the exception: they are sent anyway. The web push service worker does not report deliveries or clicks meanwhile |
| Consent `denied` | Collects nothing and clears anything queued. The service worker stops reporting deliveries and clicks |
| `optOut()` / `optOut: true` | Collects nothing, clears queued events and pending attribute, alias and subscribe writes (unsubscribes are still delivered), and is stored so it survives a reload. The web push service worker still shows notifications but stops reporting deliveries and clicks |
| Do Not Track | Treated as opted out while `respectDoNotTrack` is true |

How the two switches behave:

- **`denied` is remembered.** It stays in force on later page views until `updateConsent('granted')` or an explicit `trackingConsent: 'granted'` in the init config. Leaving `trackingConsent` unset keeps a stored denial - which is why it has no default.
- **`pending` is for one page view.** It is never stored, and never overrides a stored denial.
- **Consent never lifts an opt-out.** `updateConsent('granted')` does not undo `optOut()`; only `optIn()` does. `optOut()` and `optIn()` never change the stored consent.
- **The profile records the opt-out.** When the opt-out switch changes - including `optOut: true` at init - the SDK writes `tracking_opted_out` (`true` or `false`) to the profile, with the IDs of the visitor who made the choice, and sends nothing while it is unchanged. It is retried by the rule under [Delivery](#delivery). `true` is a withdrawal and is sent even while consent is denied or pending, or after `wipeData()`; `false` waits until tracking is allowed.
- **A session that began while tracking was off** gets its one Session Start when consent is granted or the visitor opts back in.
- **`identify()` while tracking is off** (consent denied, or opted out) sends nothing and writes nothing to a profile. The user ID is kept on this device only, so a later unsubscribe or opt-out reaches that person rather than an anonymous profile; the normal `identify()` runs when tracking is allowed again - before the Session Start of a session that began meanwhile, so that session is the new user's. It is used for every withdrawal: an unsubscribe, a group unsubscribe, the opt-out marker and `push.unsubscribe()`. An `identify()` once tracking is allowed replaces it, an explicit `userId` in the init config wins over it, and `reset()` and `wipeData()` forget it.
- **Every open tab follows.** An opt-out, a consent change, a `reset()` or an `identify()` made in one tab of your site applies to its other open tabs at once, not at their next reload. A logout in one tab is a full `reset()` in the others: they move to the new visitor and the new session, and writes they made for the outgoing user stay that user's. A grant in one tab also releases a tab waiting in `pending`. Another tab or script calling `localStorage.clear()` never lifts an opt-out or a denial: the tab keeps it and stores it again. The profile writes and logged-out users' tokens every tab keeps in `localStorage` are merged, never overwritten by one tab. The user an `identify()` keeps for withdrawals while tracking is off is followed too. An explicit `updateConsent('granted')` or `optIn()` made right after such a `localStorage.clear()` is newer than the stored decision and wins in every tab. A profile write that another tab has already delivered, or replaced with a newer one, is never sent by this tab, and `wipeData()` in one tab discards the other tabs' waiting writes too (withdrawals excepted).

With the async snippet, `optOut()`, `optIn()`, `updateConsent()` and a `wipeData()` called before `init` take effect **before** the SDK starts - nothing is sent under the state they replace. See [Option 1: Async snippet](#option-1-async-snippet-recommended).

### Erasing local data

```javascript
await joryio.wipeData();
```

Erases everything the SDK keeps about the visitor in this browser: the identity (a new anonymous ID, no user ID), queued events and a pending `identify`, pending attribute, alias and subscription writes, in-app state and impression history, the session, UTM data, the device ID and the push subscription (unregistered with Joryio as well). Withdrawals still waiting - an unsubscribe, the opt-out marker, the push unregister - are still delivered, with the IDs they were made with. It **keeps** the opt-out and a denied consent, and does not opt anyone out - that is `optOut()`. Tracking continues as a new anonymous visitor, in a new session.

### Aliases

```javascript
// A labelled alias, e.g. a CRM ID. Works before identify() too:
// the alias is attached to the anonymous visitor's profile.
joryio.addAlias('crm', 'crm_98765');
```

To link an anonymous visitor to their user ID, call `identify()` - it merges the anonymous profile into the user's.

### SDK authentication (optional)

For hardened deployments you can require every ingest request to carry a JWT that your backend mints. When enabled, the SDK attaches it as an `X-Joryio-Auth` header to every ingest request (event batches, identify, alias, attributes, in-app sync and track, and push) and refreshes it when the backend rejects it. It is opt-in: when disabled, nothing changes.

Your backend signs the JWT with a key you register with Joryio, with a `sub` matching the identified user. A bad, expired or missing token is rejected with `401 { error: 'sdk_authentication_error', reason: 'missing' | 'invalid' | 'expired' | 'sub_mismatch' }`.

```javascript
const joryio = new JoryioSDK({
  sdkKey: 'jry_sdk_web_YOUR_SDK_KEY',
  enableSdkAuthentication: true,
  sdkAuthenticationToken: await mintJoryioJwt(),
});

// Fires on a 401 sdk_authentication_error. Return a fresh token (or call
// setSdkAuthenticationToken); the failed request is then retried once.
joryio.setSdkAuthenticationErrorCallback(async (info) => {
  // info = { reason, endpoint, userId }
  return await mintJoryioJwt();
});

// Update the token at any time, e.g. before it expires
joryio.setSdkAuthenticationToken(await mintJoryioJwt());
```

- **The callback fires on an SDK-auth `401` for the current user's request** while `enableSdkAuthentication` is on - including before any token was set (`reason: 'missing'`). It never fires for a request of a user who has since logged out, so it cannot make your app sign out the person now using it.
- **One immediate retry, outside the normal backoff.** If no callback is registered, the callback returns no token, or the retry fails too, the request is not dropped: the events stay queued and are retried with the normal backoff, carrying whatever token is set by then. A profile write is retried at most 10 times.
- **A logged-out user's token is kept for their leftovers.** At `reset()` - or `identify()` of another user - the token stops being the session's but stays bound to the outgoing user's queued events and writes, kept in `localStorage` with them so a reload does not lose it, and deleted once the last of them is delivered or dropped - no sooner than a minute after it was set aside, and never later than 30 days. Setting a token whose `sub` is another user does the same to the token it replaces, so the order does not matter: a token you set for the incoming user before calling `identify()` is recognised by its `sub` and stays theirs, and the outgoing user's leftovers keep the outgoing user's token. Refreshing the token of the same user sets nothing aside. A token whose `sub` is not the current user's is kept for that user this way also when no one is signed in, until `identify()` makes it the session's; `wipeData()` deletes such a token.
- **One user per request.** Events are never batched across a change of user, so a logged-out user's queued events cannot hold up the next user's. A request carries only a token whose `sub` is that request's user: the current token when it is theirs, else the token set aside for them, else none - so a token you set for the next user before `identify()` never goes out on the current user's requests. Anonymous requests carry no token.
- **A logged-out user's leftovers are dropped, not retried forever.** `reset()` takes the token off the session; it stays with the outgoing user's own queued work. Events and writes the outgoing user had already queued still go out with that user's token, so a normal logout loses nothing. Events, an `identify` and profile writes of a user who is no longer the current one, refused with any SDK-auth `401` (`missing`, `sub_mismatch`, `expired` or `invalid`), are dropped: no token for that user will be set again.
- **In-app requests** carry the header too; a 401 there triggers a refresh so the next sync carries a valid token.

### Subscription preferences

```javascript
import { SubscriptionStatus } from '@joryio/web-sdk';

joryio.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
joryio.user.setSubscriptions({
  email: SubscriptionStatus.OPTED_IN,
  sms: SubscriptionStatus.UNSUBSCRIBED,
});

joryio.user.addToSubscriptionGroup('newsletter-list-id', 'email');
joryio.user.removeFromSubscriptionGroup('newsletter-list-id', 'email');
```

Channels: `email`, `sms`, `whatsapp`, `push`, `viber`.

| Status | Meaning |
|--------|---------|
| `SubscriptionStatus.OPTED_IN` | Explicitly opted in (double opt-in confirmed) |
| `SubscriptionStatus.SUBSCRIBED` | Subscribed (single opt-in) |
| `SubscriptionStatus.UNSUBSCRIBED` | Opted out |

The `user` object is write-only: there are no getters for subscription state. Changes are kept and delivered in order (see [Delivery](#delivery)); a change made before `identify()` is sent with the user ID once the identify has reached the server, so SDK authentication accepts it. An unsubscribe is delivered even while the visitor is opted out or consent is denied.

### Delivery

- Events go out in requests of at most `batchSize` (and never more than 500 events or about 900 KB).
- A request the API refuses as malformed (400, 413, 422) is split in half and retried, until the one bad event is found and dropped (logged as an error when logging is on). It never holds up the events behind it.
- Events the API would refuse for good are dropped by `track()` before they are queued, with a log line: a name that is not 1-255 characters, or properties over the API's limits - more than 50 KB serialized, more than 200 keys, or nested deeper than 5 levels.
- If the API stores only some events of a batch, only the ones it reports as failed (`failedIndices`) are retried. Events it reports as refused for good (`rejectedIndices`) are dropped.
- Attribute writes keep call order per attribute: two `addToArray()` calls on one key both arrive, and a later write to a key never shares a request with an earlier one. A 2xx response whose body says `success: false` - for a batch, identify, attributes, an alias, a subscription change or a push registration - counts as a failure and is retried, never treated as done.
- Profile writes - attributes, `addAlias()`, subscription and subscription-group changes - are kept in `localStorage` until the API acknowledges them, so a navigation or a closed tab does not lose them; at page unload the ones waiting are handed to `fetch(..., { keepalive: true })` as well. A newer change to the same channel, group or attribute replaces an older one still waiting, so an older change never lands after a newer one.
- A write keeps the identity it was made under: one made just before `identify()` is sent with that user ID once the identify has reached the server; one of user A still waiting when `identify('B')` or `reset()` is called still goes to A.
- One retry rule for every write (`identify()` included): network errors, timeouts, 429, 5xx and 402 never count against it and are retried with a growing backoff; a 404 ("no profile yet") is retried at most 5 times and any other retryable refusal (`success: false`, an SDK-auth 401 for the current user) at most 10 times; 400, 403, 409, 413 and 422 drop the write with a log line.
- Network errors, timeouts, 429 and 5xx keep every event and retry with exponential backoff (honouring `Retry-After`), and immediately when the browser comes back online.
- A 402 (event ingestion paused for your workspace), 403 or an invalid key stops sending events for the rest of the page view. Queued events are kept for the next one. After a 402, profile writes wait too - except withdrawals, which the API still accepts and which are still sent.
- When the page is closed, queued events are handed to the browser with `fetch(..., { keepalive: true })` and your SDK auth header. Anything that does not fit the browser's 64 KB limit - one budget for the whole page, however many unload events fire - stays queued for the next visit. While the browser is offline, or after the last send failed, nothing is handed off: the events stay queued rather than ride a request that is likely to fail.
- Event timestamps are ISO 8601 in UTC with milliseconds (`2026-10-07T09:30:00.123Z`), as on every Joryio SDK.
- Subscription and alias changes wait for a pending `identify()` to reach the server first, carry both your user ID and the anonymous ID, and are retried if the contact does not exist yet.
- **Withdrawals are always delivered**: an unsubscribe (`SubscriptionStatus.UNSUBSCRIBED`, `removeFromSubscriptionGroup()`), the `tracking_opted_out` marker and a push unregister are sent even while the visitor is opted out, with consent denied or pending, and after `wipeData()`. Every other write stops with them.

### Teardown

```javascript
await joryio.destroy(); // flush, stop every timer and remove listeners
```

The SDK never throws into your page. A missing or malformed `sdkKey` is logged once (always, whatever the log level) and the instance ignores every call; a `null` argument where one is required is logged and ignored.

## TypeScript

```typescript
import JoryioSDK, { InitConfig, Plugin } from '@joryio/web-sdk';

const config: InitConfig = {
  sdkKey: 'jry_sdk_web_YOUR_SDK_KEY',
  enableDebug: true,
};

const sdk = new JoryioSDK(config);
sdk.track('Event', { property: 'value' });
```

## Bundle size

`joryio.min.js` 1.3.0 is about 167 KB minified, about 45 KB gzipped.

## Documentation

- [Web SDK guide](https://docs.joryio.com/developers/sdk/web-sdk)
- [UTM and attribution](https://docs.joryio.com/developers/sdk/web-utm-tracking)
- [Tracking events](https://docs.joryio.com/developers/sdk/tracking-events)
- [E-commerce tracking](https://docs.joryio.com/developers/sdk/ecommerce-tracking)
- [Changelog](./CHANGELOG.md)

## Support

- Issues: https://github.com/joryio/joryio-web-sdk/issues
- Email: support@joryio.com

## License

Commercial - see [LICENSE](./LICENSE). Use of the SDK requires an active Joryio subscription or agreement.
