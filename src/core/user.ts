/**
 * Joryio SDK User
 * Provides methods to update user subscription status
 * Write-only for security - no getter methods
 */

import { Logger } from '../utils/logger';
import { NetworkClient } from './network';
import { IdentityManager } from './identity';
import type { WriteRunner, WriteRecord } from './write-retry';

/**
 * Subscription status types
 * - OPTED_IN: User has explicitly opted in (e.g., confirmed double opt-in)
 * - SUBSCRIBED: User is subscribed but hasn't explicitly opted in
 * - UNSUBSCRIBED: User has opted out
 */
export enum SubscriptionStatus {
  // Wire value MUST be camelCase `optedIn` — the backend `@IsIn`/`@IsEnum`
  // (sdk-subscriptions.controller.ts, update-channel-subscription.dto.ts) 400s
  // on snake_case `opted_in` (a NormalizeEnumCasing migration renamed the stored
  // value). See docs/SSOT_DRIFT_AUDIT.md B7 — the enum NAME stays OPTED_IN.
  OPTED_IN = 'optedIn',
  SUBSCRIBED = 'subscribed',
  UNSUBSCRIBED = 'unsubscribed',
}

/**
 * Channel types for subscriptions
 */
/*
 * MIRRORS the backend's SUBSCRIPTION_CHANNELS, which is five, not four.
 *
 * `viber` was added there and never here, so this SDK refused locally - with a
 * logged error and no request - a channel the backend accepts. Viber is a
 * first-class campaign channel, so a web preference centre simply could not
 * offer it, and the failure was client-side and silent to the server.
 */
export type SubscriptionChannel = 'email' | 'sms' | 'whatsapp' | 'push' | 'viber';

/** The runtime list, so validation and the type cannot drift apart. */
export const SUBSCRIPTION_CHANNELS: readonly SubscriptionChannel[] = [
  'email',
  'sms',
  'whatsapp',
  'push',
  'viber',
];

/**
 * Subscription preferences object for bulk updates
 */
export type SubscriptionPreferences = Partial<Record<SubscriptionChannel, SubscriptionStatus>>;

export class User {
  private logger: Logger;
  private network: NetworkClient;
  private identity: IdentityManager;
  private apiEndpoint: string;
  private runWrite: WriteRunner;

  constructor(
    logger: Logger,
    network: NetworkClient,
    identity: IdentityManager,
    apiEndpoint: string,
    runWrite?: WriteRunner,
  ) {
    this.logger = logger;
    this.network = network;
    this.identity = identity;
    this.apiEndpoint = apiEndpoint;
    // Standalone use (tests): send once, immediately. The SDK passes its
    // persisted, ordered outbox (outbox.ts) instead.
    this.runWrite =
      runWrite ||
      ((label, record) => {
        this.sendOnce(record).then(
          (res) => {
            if (!res.ok) this.logger.error(`${label} failed (HTTP ${res.status || 'no response'})`);
          },
          (error) => this.logger.error(`${label} failed:`, error),
        );
      });
  }

  private sendOnce(record: WriteRecord) {
    if (record.kind === 'subscription') return this.network.sendSubscriptionUpdate(this.apiEndpoint, record.payload);
    if (record.kind === 'group') return this.network.sendSubscriptionGroupUpdate(this.apiEndpoint, record.payload);
    return Promise.resolve({ ok: false, status: 0 });
  }

  /**
   * Both ids, captured NOW. The server resolves `userId` first and falls back
   * to `anonymousId`, so a visitor whose identify has not been merged yet is
   * still found. A write made while anonymous is sent with the user id once
   * that anonymous id has been identified (resolved at send time by the
   * outbox, contract item 38); a write of an earlier identity keeps its own.
   */
  private ids(): { userId?: string; anonymousId: string } {
    const userId = this.identity.getUserId();
    return { ...(userId ? { userId } : {}), anonymousId: this.identity.getAnonymousId() };
  }

  /**
   * Set subscription status for a channel
   * @param channel - The channel (email, sms, whatsapp, push, viber)
   * @param status - The subscription status (OPTED_IN, SUBSCRIBED, UNSUBSCRIBED)
   *
   * @example
   * user.setSubscription('email', SubscriptionStatus.OPTED_IN);
   * user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
   */
  setSubscription(channel: SubscriptionChannel, status: SubscriptionStatus): void {
    // An unsubscribe is a WITHDRAWAL: it is delivered even after optOut(), a
    // denied consent or wipeData() (contract item 36). Any other status stops
    // with them.
    // Validate channel
    if (!SUBSCRIPTION_CHANNELS.includes(channel)) {
      this.logger.error(
        `Invalid channel: ${channel}. Must be one of: ${SUBSCRIPTION_CHANNELS.join(', ')}`,
      );
      return;
    }

    // Validate status
    const validStatuses = Object.values(SubscriptionStatus);
    if (!validStatuses.includes(status)) {
      this.logger.error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
      return;
    }

    this.logger.debug(`Setting ${channel} subscription status to ${status}`);
    const payload = { channel, status, ...this.ids() };
    this.runWrite(`Update ${channel} subscription`, { kind: 'subscription', payload });
  }

  /**
   * Set multiple channel subscriptions at once
   * @param preferences - Object mapping channels to their subscription status
   *
   * @example
   * user.setSubscriptions({
   *   email: SubscriptionStatus.OPTED_IN,
   *   sms: SubscriptionStatus.SUBSCRIBED,
   *   push: SubscriptionStatus.UNSUBSCRIBED
   * });
   */
  setSubscriptions(preferences: SubscriptionPreferences): void {
    if (!preferences || typeof preferences !== 'object') {
      this.logger.error('setSubscriptions requires an object, e.g. { email: SubscriptionStatus.OPTED_IN }');
      return;
    }
    for (const [channel, status] of Object.entries(preferences)) {
      if (status !== undefined) {
        this.setSubscription(channel as SubscriptionChannel, status);
      }
    }
  }

  /**
   * Add user to a subscription group (list)
   * @param groupId - The subscription group/list ID
   * @param channel - Optional channel for the subscription (defaults to email)
   *
   * @example
   * user.addToSubscriptionGroup('list_abc123');
   * user.addToSubscriptionGroup('list_abc123', 'sms');
   */
  addToSubscriptionGroup(groupId: string, channel: SubscriptionChannel = 'email'): void {
    this.updateGroup(groupId, channel, 'subscribe');
  }

  /**
   * Remove user from a subscription group (list)
   * @param groupId - The subscription group/list ID
   * @param channel - Optional channel for the subscription (defaults to email)
   *
   * @example
   * user.removeFromSubscriptionGroup('list_abc123');
   * user.removeFromSubscriptionGroup('list_abc123', 'sms');
   */
  removeFromSubscriptionGroup(groupId: string, channel: SubscriptionChannel = 'email'): void {
    this.updateGroup(groupId, channel, 'unsubscribe');
  }

  private updateGroup(groupId: string, channel: SubscriptionChannel, action: 'subscribe' | 'unsubscribe'): void {
    if (typeof groupId !== 'string' || !groupId) {
      this.logger.error(`Cannot ${action} subscription group: groupId is required`);
      return;
    }
    if (!SUBSCRIPTION_CHANNELS.includes(channel)) {
      this.logger.error(
        `Invalid channel: ${channel}. Must be one of: ${SUBSCRIPTION_CHANNELS.join(', ')}`,
      );
      return;
    }

    this.logger.debug(`${action} subscription group ${groupId} for channel ${channel}`);
    const payload = { groupId, channel, action, ...this.ids() };
    this.runWrite(`Subscription group ${groupId} ${action}`, { kind: 'group', payload });
  }
}
