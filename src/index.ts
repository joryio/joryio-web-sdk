/**
 * Joryio Web SDK
 * Main entry point
 */

import { JoryioSDK, PRE_INIT_BASELINE, runWithDataCallsDropped, DataGateReason } from './core/sdk';
import type { TrackingConsent, PreInitDecision } from './core/sdk';
import type { InitConfig, Plugin, InAppOptions, InAppDisplayOptions } from './core/config';
import type { UTMParameters, UTMData } from './core/utm';
import type { InAppCampaign, InAppMessage, InAppTrigger } from './core/inapp';
import type {
  SdkAuthFailureInfo,
  SdkAuthFailureReason,
  SdkAuthFailureCallback,
} from './core/network';
import { User, SubscriptionStatus } from './core/user';
import type { SubscriptionChannel, SubscriptionPreferences } from './core/user';
import { PushManager } from './core/push';
import type { PushSubscribeOptions, PushPermissionState } from './core/push';
import { EcommerceTracker, createEcommerceTracker } from './core/ecommerce';
import type {
  EcommerceProduct,
  EcommerceCartItem,
  EcommerceOrder,
  EcommerceConfig,
} from './core/ecommerce';

// Export main SDK class
export { JoryioSDK };

// Export User class and subscription types
export { User, SubscriptionStatus };

// Export Push manager
export { PushManager };

// Export E-commerce tracker
export { EcommerceTracker, createEcommerceTracker };

// Export types
export type {
  InitConfig,
  Plugin,
  InAppOptions,
  InAppDisplayOptions,
  InAppCampaign,
  InAppMessage,
  InAppTrigger,
  UTMParameters,
  UTMData,
  SubscriptionChannel,
  SubscriptionPreferences,
  PushSubscribeOptions,
  PushPermissionState,
  TrackingConsent,
  EcommerceProduct,
  EcommerceCartItem,
  EcommerceOrder,
  EcommerceConfig,
  SdkAuthFailureInfo,
  SdkAuthFailureReason,
  SdkAuthFailureCallback,
};

// Export SDK version
export { SDK_VERSION } from './core/config';

// Default export for convenience
export default JoryioSDK;

/**
 * Wire the async snippet's command queue to the SDK.
 *
 * The snippet makes `window.joryio` an array whose stub methods push
 * `[method, ...args]` onto it. When this bundle loads:
 *  - if an `init` is already queued, the SDK is created, `window.joryio`
 *    becomes the SDK instance, and every other queued call is replayed in
 *    order;
 *  - if not (a site that calls `joryio.init()` later - after its consent
 *    banner, say), the queue keeps collecting and the SDK starts the moment
 *    `init` is pushed. That case used to be ignored: the late init sat in the
 *    array forever and nothing was ever tracked.
 *
 * This used to also assign `window.joryio.push = ...` on the SDK instance,
 * where `push` is the read-only web-push getter. In the (strict-mode) bundle
 * that assignment THREW - "Cannot set property push of #<L> which has only a
 * getter" - on every page using the snippet, aborting the UMD factory before
 * it exported anything. Late calls need no override: the stubs push onto the
 * original array (handled below), and calls on `window.joryio` after load go
 * straight to the SDK's own methods.
 *
 * Exported for tests. Never throws into the host page.
 */
/** Calls held before `init` (snippet queue). The same cap on every Joryio SDK. */
const MAX_PRE_INIT_CALLS = 1000;
/** Never dropped by that cap: `init` and the visitor's privacy decisions (rule 51). */
const KEPT_PRE_INIT_CALLS = ['init', 'optOut', 'optIn', 'updateConsent', 'wipeData'];
/**
 * Queued calls that COLLECT data (rule 73): one made while the visitor was
 * opted out or consent was denied - by the stored state, the init config or
 * a decision queued before it - is dropped, not replayed after a later
 * queued optIn() or grant. identify() is not one (a user kept for
 * withdrawals, D-b), nor are withdrawals and control calls.
 */
const DATA_CALLS = [
  'track',
  'setAttributes',
  'setAttribute',
  'incrementAttribute',
  'unsetAttribute',
  'addToArray',
  'removeFromArray',
  'addAlias',
  'trackInAppConversion',
];

/**
 * Which queued data calls (DATA_CALLS) and ready() callbacks were made while
 * tracking was off - or before a queued optOut(), updateConsent('denied') or
 * pre-init wipeData() (rule 83, the pre-init purge: the person withdrew what
 * was queued before it, and a later queued optIn() or grant does not bring it
 * back). The data calls are dropped; such a ready() callback still runs, with
 * the data calls it makes dropped (rule 83) - and each callback carries WHY
 * (rule 92), so only the matching decision inside it lifts the gate. A
 * pre-init wipeData() gates no ready() callback by itself: the callback runs
 * after it, for the fresh visitor.
 */
function callsMadeWhileOff(
  commands: any[],
  baseline: { optedOut: boolean; consent: string } | null | undefined,
  initIndex: number = commands.length,
  reasons: Map<any, Set<DataGateReason>> = new Map(),
): Set<any> {
  const off = new Set<any>();
  // `reasons` (filled for the caller): why each one is off (rule 92).
  const gate = (command: any, reason: DataGateReason) => {
    off.add(command);
    const why = reasons.get(command) || new Set<DataGateReason>();
    why.add(reason);
    reasons.set(command, why);
  };
  let optedOut = !!baseline?.optedOut;
  let consent = baseline?.consent || 'granted';
  const collecting: any[] = [];
  const purge = (byWipe = false) => {
    const kept = collecting.filter((command) => byWipe && command[0] === 'ready');
    collecting.forEach((command) => {
      if (!kept.includes(command)) gate(command, 'purged');
    });
    collecting.length = 0;
    collecting.push(...kept);
  };
  commands.forEach((command, index) => {
    if (!Array.isArray(command)) return;
    const [method, arg] = command;
    if (method === 'optOut') {
      optedOut = true;
      purge();
    } else if (method === 'optIn') optedOut = false;
    else if (method === 'updateConsent') {
      if (arg === 'granted' || arg === 'denied') consent = arg;
      // 'pending' never reopens a denial.
      else if (arg === 'pending' && consent !== 'denied') consent = 'pending';
      if (arg === 'denied') purge();
    } else if (method === 'wipeData' && index < initIndex) {
      // Applied inside init, before the replay: what was queued before it
      // would otherwise be collected for the fresh visitor the wipe makes.
      purge(true);
    } else if (DATA_CALLS.includes(method) || method === 'ready') {
      if (optedOut) gate(command, 'optedOut');
      if (consent === 'denied') gate(command, 'denied');
      if (!optedOut && consent !== 'denied') collecting.push(command);
    }
  });
  return off;
}

export function installSnippetQueue(win: any): void {
  try {
    const queue = win && win.joryio;
    if (!Array.isArray(queue)) return;

    const initCommand = queue.find((cmd: any) => Array.isArray(cmd) && cmd[0] === 'init');
    if (!initCommand) {
      if ((queue as any).__joryioWaitingForInit) return;
      (queue as any).__joryioWaitingForInit = true;
      // An own property on the array instance - assignable, unlike the SDK's getter.
      (queue as any).push = function (...commands: any[]) {
        // Same pre-init cap as the snippet (and every Joryio SDK): 1000
        // calls, oldest dropped first - never `init` nor a privacy decision.
        for (let overflow = queue.length + commands.length - MAX_PRE_INIT_CALLS; overflow > 0; overflow--) {
          const oldest = queue.findIndex((cmd: any) => !(Array.isArray(cmd) && KEPT_PRE_INIT_CALLS.includes(cmd[0])));
          if (oldest < 0) break;
          queue.splice(oldest, 1);
        }
        const length = Array.prototype.push.apply(queue, commands);
        if (commands.some((cmd) => Array.isArray(cmd) && cmd[0] === 'init')) {
          installSnippetQueue(win);
        }
        return length;
      };
      return;
    }

    // Privacy decisions queued before the bundle loaded take effect INSIDE
    // init, before any of its side effects (contract item 25). Replayed
    // afterwards, as they used to be, they came too late: `optOut()` or
    // `updateConsent('denied')` queued ahead of `init` still let init send
    // Session Start, sync in-app messages and re-register push first.
    //
    // optOut / optIn / updateConsent are folded from the WHOLE queue (all of
    // it predates the SDK, and replaying, say, an identify under a consent
    // that a later queued call grants would drop it). wipeData only when it
    // came before init: after init it is ordered against the calls around it.
    const commands = queue.slice();
    const initIndex = commands.indexOf(initCommand);
    const preInit: PreInitDecision[] = [];
    const folded = new Set<any>();
    commands.forEach((command: any, index: number) => {
      if (!Array.isArray(command)) return;
      const [method, arg] = command;
      if (method === 'optOut' || method === 'optIn') {
        preInit.push({ method });
      } else if (method === 'updateConsent') {
        preInit.push({ method, consent: arg });
      } else if (method === 'wipeData' && index < initIndex) {
        preInit.push({ method });
      } else {
        return;
      }
      folded.add(command);
    });

    let sdk: JoryioSDK | null = null;
    try {
      sdk = new JoryioSDK(initCommand[1], preInit);
    } catch (error) {
      // eslint-disable-next-line no-console -- no SDK instance (and so no logger) exists when init itself fails
      console.error('[Joryio] init failed:', error);
    }
    if (!sdk || JoryioSDK.getInstance() !== sdk) {
      // The init failed (a missing or malformed key builds an inert
      // instance). Nothing queued is replayed into it - an unsubscribe or an
      // optOut() would be swallowed - and `window.joryio` stays the queue:
      // every call, privacy decisions and withdrawals included, is KEPT in
      // order, and a corrected `joryio.init(...)` starts the SDK with them
      // (decisions first, rule 65). The failed init is dropped so it is not
      // tried again.
      const at = queue.indexOf(initCommand);
      if (at >= 0) queue.splice(at, 1);
      (queue as any).__joryioWaitingForInit = false;
      installSnippetQueue(win);
      return;
    }

    // Data calls made while tracking was off are dropped, whatever a later
    // queued decision says (rule 73).
    const gateReasons = new Map<any, Set<DataGateReason>>();
    const madeWhileOff = callsMadeWhileOff(commands, PRE_INIT_BASELINE.get(sdk), initIndex, gateReasons);
    // Swap first, so a replayed ready(cb) - or anything it calls - sees the SDK.
    win.joryio = sdk;
    for (const command of commands) {
      if (!Array.isArray(command) || folded.has(command)) continue;
      const [method, ...args] = command;
      if (method === 'init') continue;
      const gated = madeWhileOff.has(command);
      if (gated && method !== 'ready') {
        (sdk as any).logger?.debug?.(`${String(method)} queued before load dropped: tracking was off when it was called`);
        continue;
      }
      const fn = (sdk as any)[method];
      if (typeof fn !== 'function') {
        // eslint-disable-next-line no-console -- surfaced regardless of log level: a typo in a queued call is otherwise invisible
        console.warn(`[Joryio] Unknown method queued before load: ${String(method)}`);
        continue;
      }
      try {
        let result: any;
        // A ready() callback queued while tracking was off runs at the state
        // of its queue position: the data calls it makes are dropped (rule 83).
        if (gated) runWithDataCallsDropped(sdk, gateReasons.get(command) || [], () => (result = fn.apply(sdk, args)));
        else result = fn.apply(sdk, args);
        if (result && typeof result.catch === 'function') {
          result.catch((error: unknown) => {
            // eslint-disable-next-line no-console -- see above
            console.error(`[Joryio] Error executing ${String(method)}:`, error);
          });
        }
      } catch (error) {
        // eslint-disable-next-line no-console -- see above
        console.error(`[Joryio] Error executing ${String(method)}:`, error);
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- see above
    console.error('[Joryio] Could not process the snippet queue:', error);
  }
}

// Browser global initialization
if (typeof window !== 'undefined') {
  // Make SDK available on window object as 'Joryio'
  (window as any).Joryio = JoryioSDK;
  installSnippetQueue(window);
}
