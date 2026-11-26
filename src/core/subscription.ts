/**
 * Returned by every `on...Updated` listener - `onCardsUpdated`,
 * `onPlacementsUpdated` and `onFlagsUpdated`: `cancel()` stops the updates.
 * It is also callable, `sub()` being `sub.cancel()`, so code that called the
 * returned function keeps working. Cancelling twice is harmless.
 *
 * One type with the same name and the same `cancel()` on every Joryio SDK
 * (iOS, Android, React Native; Unity `JoryioSubscription.Cancel()`), pinned by
 * the backend's SDK parity spec.
 */
export interface JoryioSubscription {
  (): void;
  cancel(): void;
}

/** A JoryioSubscription that runs `stop` once. */
export function joryioSubscription(stop: () => void): JoryioSubscription {
  let done = false;
  const cancel = (): void => {
    if (done) return;
    done = true;
    stop();
  };
  const sub = (() => cancel()) as JoryioSubscription;
  sub.cancel = cancel;
  return sub;
}
