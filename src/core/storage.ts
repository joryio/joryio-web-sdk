/**
 * Storage Manager for localStorage with fallback to in-memory storage
 */

import { Logger } from '../utils/logger';
import { bucketHash } from '../utils/bucket-hash';

interface StorageItem<T = any> {
  value: T;
  expiresAt: number | null;
}

export class StorageManager {
  private prefix: string;
  private memoryStore: Map<string, StorageItem> = new Map();
  private isLocalStorageAvailable: boolean;
  private logger: Logger;

  /**
   * Namespaces this workspace's localStorage so two SDK keys on one origin do
   * not share a deviceId, session or consent state.
   *
   * Was the Java String.hashCode recurrence (`hash * 31 + char`), the last
   * inline copy of it in the repo after every bucketing site moved to the
   * shared util. Measured on real-format keys (`jry_live_<32 random>`) that
   * recurrence was only ~2x worse than ideal here rather than dangerous - the
   * shared `jry_live_` prefix is the part it weights LEAST, and the random tail
   * dominates - and a single origin carries one or two SDK keys, so collisions
   * were never a practical risk.
   *
   * It was replaced anyway, and the reason is timing rather than risk: the
   * prefix is baked into every stored key, so changing it orphans every
   * browser's deviceId, session and consent. That costs nothing today and can
   * never be done again once real visitors hold state. Taking the free move now
   * leaves ONE hash in the codebase with no exception to remember.
   */
  private static hashKey(key: string): string {
    return bucketHash(key).toString(36);
  }

  constructor(sdkKey: string, logger: Logger) {
    this.prefix = `jry_${StorageManager.hashKey(sdkKey)}_`;
    this.logger = logger;
    this.isLocalStorageAvailable = this.checkLocalStorageAvailable();

    if (!this.isLocalStorageAvailable) {
      this.logger.warn('LocalStorage not available, using in-memory storage');
    }
  }

  private checkLocalStorageAvailable(): boolean {
    try {
      const testKey = '__jry_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** The localStorage key one SDK key is stored under (to read `storage` events of other tabs). */
  storageKeyFor(key: string): string {
    return this.getKey(key);
  }

  set<T>(key: string, value: T, expiresInDays?: number): void {
    const item: StorageItem<T> = {
      value,
      expiresAt: expiresInDays
        ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000
        : null,
    };

    if (this.isLocalStorageAvailable) {
      try {
        localStorage.setItem(this.getKey(key), JSON.stringify(item));
        this.memoryStore.delete(key);
      } catch (e) {
        this.logger.error('Failed to write to localStorage:', e);
        // Fallback to memory - and the OLD stored value goes, or get() would
        // keep preferring it (a stale event queue re-sent on the next page).
        try {
          localStorage.removeItem(this.getKey(key));
        } catch {
          // nothing more to do
        }
        this.memoryStore.set(key, item);
      }
    } else {
      this.memoryStore.set(key, item);
    }
  }

  get<T>(key: string): T | null {
    let item: StorageItem<T> | null = null;

    if (this.isLocalStorageAvailable) {
      try {
        const stored = localStorage.getItem(this.getKey(key));
        if (stored) {
          item = JSON.parse(stored);
        }
      } catch (e) {
        this.logger.error('Failed to read from localStorage:', e);
        try { localStorage.removeItem(this.getKey(key)); } catch {}
      }
    }

    // Fallback to memory store
    if (!item) {
      item = this.memoryStore.get(key) as StorageItem<T> || null;
    }

    // Check expiration
    if (item && item.expiresAt && item.expiresAt < Date.now()) {
      this.remove(key);
      return null;
    }

    return item?.value ?? null;
  }

  remove(key: string): void {
    if (this.isLocalStorageAvailable) {
      try {
        localStorage.removeItem(this.getKey(key));
      } catch (e) {
        this.logger.error('Failed to remove from localStorage:', e);
      }
    }
    this.memoryStore.delete(key);
  }

  clear(): void {
    if (this.isLocalStorageAvailable) {
      try {
        // Remove only keys with our prefix
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(this.prefix)) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach((key) => localStorage.removeItem(key));
      } catch (e) {
        this.logger.error('Failed to clear localStorage:', e);
      }
    }
    this.memoryStore.clear();
  }
}
