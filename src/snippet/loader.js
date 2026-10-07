/**
 * Joryio Web SDK - Async Loader Snippet
 *
 * This snippet should be embedded in the <head> of your website.
 * It creates a command queue pattern that allows you to call the SDK
 * before the full SDK is loaded.
 *
 * Usage:
 * <script>
 *   !function(){var e=window.joryio=window.joryio||[];if(!e.initialize)if(e.invoked)window.console&&console.error&&console.error("Joryio snippet included twice.");else{e.invoked=!0,e.methods=["init","track","identify","addAlias","setAttributes","setAttribute","incrementAttribute","unsetAttribute","addToArray","removeFromArray","reset","flush","optOut","optIn","updateConsent","getTrackingConsent","isUserOptedOut","setSdkAuthenticationToken","setSdkAuthenticationErrorCallback","getAnonymousId","getUserId","ready","getIdentity","getSessionInfo","getUTMData","updateUTM","syncInAppCampaigns","getInAppCampaigns","displayInAppCampaign","dismissInAppMessage","trackInAppConversion","ecommerce","wipeData","destroy"],e.keep=["init","optOut","optIn","updateConsent","wipeData"],e.factory=function(t){return function(){var n=Array.prototype.slice.call(arguments);if(n.unshift(t),e.length>=1e3)for(var i=0;i<e.length;i++)if(e.keep.indexOf(e[i][0])<0){e.splice(i,1);break}return e.push(n),/^(get|is)[A-Z]/.test(t)?void 0:e}};for(var t=0;t<e.methods.length;t++){var n=e.methods[t];e[n]=e.factory(n)}e.load=function(e){var t=document.createElement("script");t.type="text/javascript",t.async=!0,t.src="https://sdk.joryio.com/web/1/joryio.min.js";var n=document.getElementsByTagName("script")[0];n.parentNode.insertBefore(t,n)},e.load()}}();
 *   joryio.init({ sdkKey: 'YOUR_SDK_KEY' });
 * </script>
 *
 * `init` may also come later (for example from a consent banner's callback):
 * calls made before it are kept and run, in order, once it arrives.
 *
 * Reading a value: the queued stubs above cannot return anything before the
 * SDK finishes loading - a getter (getUserId(), isUserOptedOut(), ...) returns
 * `undefined` until then, never a truthy placeholder - so read values in
 * ready(), or on the resolved instance after load. The same goes for `user`,
 * `push` and the tracker `ecommerce()` returns:
 *
 *   joryio.ready(function (sdk) {
 *     var anonId = sdk.getAnonymousId();
 *     var userId = sdk.getUserId(); // null until identify()
 *     sdk.user.setSubscription('email', 'optedIn');
 *   });
 *
 * The readable version is below for reference. Keep the two in step: a test
 * (src/snippet/loader.spec.ts) checks that both list every public SDK method
 * and that the README carries the minified line unchanged.
 */

(function() {
  // Create the joryio queue
  var joryio = window.joryio = window.joryio || [];

  // If already initialized, skip
  if (!joryio.initialize) {
    if (joryio.invoked) {
      window.console && console.error && console.error('Joryio snippet included twice.');
    } else {
      joryio.invoked = true;

      // Every public method of the SDK instance (src/core/sdk.ts), so no call
      // made before load throws "is not a function". Methods that RETURN a
      // value can only do so after load - see ready() above.
      joryio.methods = [
        'init',
        'track',
        'identify',
        'addAlias',
        'setAttributes',
        'setAttribute',
        'incrementAttribute',
        'unsetAttribute',
        'addToArray',
        'removeFromArray',
        'reset',
        'flush',
        'optOut',
        'optIn',
        'updateConsent',
        'getTrackingConsent',
        'isUserOptedOut',
        'setSdkAuthenticationToken',
        'setSdkAuthenticationErrorCallback',
        'getAnonymousId',
        'getUserId',
        'ready',
        'getIdentity',
        'getSessionInfo',
        'getUTMData',
        'updateUTM',
        'syncInAppCampaigns',
        'getInAppCampaigns',
        'displayInAppCampaign',
        'dismissInAppMessage',
        'trackInAppConversion',
        'ecommerce',
        'wipeData',
        'destroy'
      ];

      // Calls the cap below never drops: `init`, and the visitor's privacy
      // decisions (rule 51) - an optOut() lost to a burst of track() calls
      // would let the SDK start tracking someone who said no.
      joryio.keep = ['init', 'optOut', 'optIn', 'updateConsent', 'wipeData'];

      // Factory for creating queue methods. The queue holds at most 1000
      // calls - the pre-init cap every Joryio SDK uses - dropping the OLDEST
      // first, but never one in `keep`: a page that never loads the bundle
      // (blocked script) must not grow it without bound.
      joryio.factory = function(method) {
        return function() {
          var args = Array.prototype.slice.call(arguments);
          args.unshift(method);
          if (joryio.length >= 1000) {
            for (var j = 0; j < joryio.length; j++) {
              if (joryio.keep.indexOf(joryio[j][0]) < 0) {
                joryio.splice(j, 1);
                break;
              }
            }
          }
          joryio.push(args);
          // A getter has no answer before load: undefined, not the queue (an
          // array is truthy, so `if (joryio.isUserOptedOut())` was wrong).
          return /^(get|is)[A-Z]/.test(method) ? undefined : joryio;
        };
      };

      // Create queue methods
      for (var i = 0; i < joryio.methods.length; i++) {
        var key = joryio.methods[i];
        joryio[key] = joryio.factory(key);
      }

      // Load the SDK asynchronously
      joryio.load = function() {
        var script = document.createElement('script');
        script.type = 'text/javascript';
        script.async = true;
        script.src = 'https://sdk.joryio.com/web/1/joryio.min.js';

        var first = document.getElementsByTagName('script')[0];
        first.parentNode.insertBefore(script, first);
      };

      // Auto-load
      joryio.load();
    }
  }
})();
