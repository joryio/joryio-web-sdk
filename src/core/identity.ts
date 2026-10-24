/**
 * Identity Manager for user identification and attributes
 */

import { StorageManager } from './storage';
import { Logger } from '../utils/logger';
import { generateUUID } from '../utils/uuid';
import { PendingAttributes } from './pending-attributes';

const USER_ID_KEY = 'user_id';
const ANONYMOUS_ID_KEY = 'anonymous_id';
const USER_ATTRIBUTES_KEY = 'user_attributes';

export interface UserAttributes {
  [key: string]: any;
}

export interface UserIdentity {
  userId: string | null;
  anonymousId: string;
  attributes: UserAttributes;
}

export class IdentityManager {
  /**
   * Attribute writes the server has not acknowledged.
   *
   * Lives here because it is identity state, and because both the SDK facade
   * (to flush it) and the in-app sync (to send it) already hold this manager -
   * threading a new dependency through the in-app constructor would have
   * changed a signature with several callers.
   */
  readonly pending = new PendingAttributes();

  private storage: StorageManager;
  private logger: Logger;
  private userId: string | null = null;
  private anonymousId: string;
  private attributes: UserAttributes = {};

  constructor(storage: StorageManager, logger: Logger, userId?: string, anonymousId?: string) {
    this.storage = storage;
    this.logger = logger;

    // Initialize anonymous ID
    this.anonymousId = anonymousId || this.storage.get<string>(ANONYMOUS_ID_KEY) || generateUUID();
    if (!this.storage.get<string>(ANONYMOUS_ID_KEY)) {
      this.storage.set(ANONYMOUS_ID_KEY, this.anonymousId);
      this.logger.debug(`Generated new anonymous ID: ${this.anonymousId}`);
    }

    // Initialize user ID if provided or stored
    this.userId = userId || this.storage.get<string>(USER_ID_KEY) || null;
    if (this.userId) {
      this.logger.debug(`Loaded user ID: ${this.userId}`);
    }

    // Attributes are the PII trait bag (email/phone/name/custom). They are
    // NEVER persisted at rest — the server is the source of truth and
    // increment/append/remove are now server-atomic, so no local value is
    // needed for correctness. Start empty each session, kept in memory only
    // for in-session getAttribute read-back.
    this.attributes = {};

    // One-time purge: delete any attributes bag persisted by an older SDK
    // build so previously-stored PII is removed from existing installs.
    this.storage.remove(USER_ATTRIBUTES_KEY);
  }

  /**
   * Identify a user
   */
  identify(userId: string, attributes?: UserAttributes): void {
    const previousUserId = this.userId;
    this.userId = userId;
    this.storage.set(USER_ID_KEY, userId);

    if (attributes) {
      this.setAttributes(attributes);
    }

    if (previousUserId !== userId) {
      this.logger.info(`User identified: ${userId} (was: ${previousUserId || 'anonymous'})`);
    }
  }

  /**
   * Reset identity (logout)
   */
  reset(): void {
    this.logger.debug(`Resetting identity (was: ${this.userId || 'anonymous'})`);

    this.userId = null;
    this.attributes = {};
    this.anonymousId = generateUUID();

    this.storage.remove(USER_ID_KEY);
    this.storage.remove(USER_ATTRIBUTES_KEY);
    this.storage.set(ANONYMOUS_ID_KEY, this.anonymousId);

    this.logger.debug(`New anonymous ID: ${this.anonymousId}`);
  }

  /**
   * Another tab changed the stored identity (a reset() or identify() there):
   * take it over in memory. Storage already holds it.
   */
  adopt(anonymousId: string, userId: string | null): void {
    if (anonymousId !== this.anonymousId) this.attributes = {};
    this.anonymousId = anonymousId;
    this.userId = userId;
  }

  /**
   * Set user attributes (merge with existing)
   */
  setAttributes(attributes: UserAttributes): void {
    // Validate that attributes is a plain object
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
      this.logger.error('setAttributes requires a plain object');
      return;
    }

    // In-memory only — NOT persisted (PII stays off durable storage).
    this.attributes = {
      ...this.attributes,
      ...attributes,
    };
    this.logger.debug(`Updated user attributes:`, this.attributes);
  }

  /**
   * Set a single attribute
   */
  setAttribute(key: string, value: any): void {
    // In-memory only — NOT persisted (PII stays off durable storage).
    this.attributes[key] = value;
    this.logger.debug(`Set attribute: ${key} = ${value}`);
  }

  /**
   * Increment a numeric attribute
   */
  incrementAttribute(key: string, value: number = 1): void {
    const currentValue = this.attributes[key];
    const numericValue = typeof currentValue === 'number' ? currentValue : 0;
    this.setAttribute(key, numericValue + value);
    this.logger.debug(`Incremented attribute: ${key} by ${value} (now: ${this.attributes[key]})`);
  }

  /**
   * Unset (remove) an attribute
   */
  unsetAttribute(key: string): void {
    // In-memory only — NOT persisted (PII stays off durable storage).
    delete this.attributes[key];
    this.logger.debug(`Unset attribute: ${key}`);
  }

  /**
   * Add a value to an array attribute
   * If attribute doesn't exist or isn't an array, creates a new array
   */
  addToArray(key: string, value: any): void {
    const currentValue = this.attributes[key];
    let arrayValue: any[] = [];

    if (Array.isArray(currentValue)) {
      arrayValue = [...currentValue];
    } else if (currentValue !== undefined && currentValue !== null) {
      this.logger.warn(`Attribute ${key} is not an array, converting to array`);
      arrayValue = [currentValue];
    }

    // Only add if value doesn't already exist
    if (!arrayValue.includes(value)) {
      arrayValue.push(value);
      this.setAttribute(key, arrayValue);
      this.logger.debug(`Added to array: ${key} = ${value}`);
    } else {
      this.logger.debug(`Value already exists in array: ${key} = ${value}`);
    }
  }

  /**
   * Remove a value from an array attribute
   * If attribute doesn't exist or isn't an array, does nothing
   */
  removeFromArray(key: string, value: any): void {
    const currentValue = this.attributes[key];

    if (!Array.isArray(currentValue)) {
      this.logger.warn(`Attribute ${key} is not an array, cannot remove value`);
      return;
    }

    const newArray = currentValue.filter((item) => item !== value);
    if (newArray.length !== currentValue.length) {
      this.setAttribute(key, newArray);
      this.logger.debug(`Removed from array: ${key} = ${value}`);
    } else {
      this.logger.debug(`Value not found in array: ${key} = ${value}`);
    }
  }

  /**
   * Get current user identity
   */
  getIdentity(): UserIdentity {
    return {
      userId: this.userId,
      anonymousId: this.anonymousId,
      attributes: { ...this.attributes },
    };
  }

  /**
   * Get user ID
   */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Get anonymous ID
   */
  getAnonymousId(): string {
    return this.anonymousId;
  }

  /**
   * Get all attributes
   */
  getAttributes(): UserAttributes {
    return { ...this.attributes };
  }

  /**
   * Get a specific attribute
   */
  getAttribute(key: string): any {
    return this.attributes[key];
  }

  /**
   * Check if user is identified
   */
  isIdentified(): boolean {
    return this.userId !== null;
  }
}
