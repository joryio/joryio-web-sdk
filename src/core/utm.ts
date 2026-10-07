/**
 * UTM Parameter Manager for tracking campaign attribution
 * Supports first-touch, last-touch, and session-level attribution
 */

import { StorageManager } from './storage';
import { Logger } from '../utils/logger';

const FIRST_TOUCH_KEY = 'first_touch_utm';
const LAST_TOUCH_KEY = 'last_touch_utm';
const SESSION_UTM_KEY = 'session_utm';
const SESSION_REFERRER_KEY = 'session_referrer';
const SESSION_LANDING_PAGE_KEY = 'session_landing_page';

export interface UTMParameters {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  referrer?: string;
  landing_page?: string;
  captured_at?: number;
}

export interface UTMData {
  current: UTMParameters | null;      // Current session UTM
  firstTouch: UTMParameters | null;   // First ever UTM (lifetime attribution)
  lastTouch: UTMParameters | null;    // Most recent UTM (last touch attribution)
}

export class UTMManager {
  private storage: StorageManager;
  private logger: Logger;
  private resetSessionOnNewCampaign: boolean;
  // Whether the current URL's UTM differs from the STORED session UTM. Computed
  // BEFORE captureUTMParameters() overwrites SESSION_UTM_KEY, otherwise the
  // comparison always sees the just-written value and returns false.
  private newCampaignDetected: boolean = false;

  constructor(
    storage: StorageManager,
    logger: Logger,
    resetSessionOnNewCampaign: boolean = false,
  ) {
    this.storage = storage;
    this.logger = logger;
    this.resetSessionOnNewCampaign = resetSessionOnNewCampaign;

    // Compare the incoming URL against the previously stored session UTM BEFORE
    // capturing (which overwrites it), so hasNewCampaign() reflects the real
    // transition. Only relevant when the reset gate is on.
    if (this.resetSessionOnNewCampaign) {
      this.newCampaignDetected = this.detectNewCampaign();
    }

    // Capture UTM parameters on initialization
    this.captureUTMParameters();
  }

  /**
   * Capture UTM parameters from current URL
   */
  private captureUTMParameters(): void {
    if (typeof window === 'undefined') {
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const utm: UTMParameters = {};
    let hasUTM = false;

    // Capture all 5 standard UTM parameters
    const utmParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

    for (const param of utmParams) {
      const value = urlParams.get(param);
      if (value) {
        utm[param] = value;
        hasUTM = true;
      }
    }

    // Capture referrer (if present)
    if (document.referrer) {
      utm.referrer = document.referrer;
    }

    // Capture landing page
    utm.landing_page = window.location.href;
    utm.captured_at = Date.now();

    // If no UTM parameters found, check if we should still track referrer
    if (!hasUTM) {
      // Only track referrer/landing page for session if this is a new session
      const existingSession = this.storage.get<UTMParameters>(SESSION_UTM_KEY);
      if (!existingSession) {
        this.storage.set(SESSION_UTM_KEY, utm);
        this.storage.set(SESSION_REFERRER_KEY, utm.referrer || null);
        this.storage.set(SESSION_LANDING_PAGE_KEY, utm.landing_page);
        this.logger.debug('Captured session referrer and landing page');
      }
      return;
    }

    this.logger.debug('Captured UTM parameters:', utm);

    // Store as current session UTM
    this.storage.set(SESSION_UTM_KEY, utm);
    this.storage.set(SESSION_REFERRER_KEY, utm.referrer || null);
    this.storage.set(SESSION_LANDING_PAGE_KEY, utm.landing_page);

    // Store as first touch if not already set (lifetime attribution)
    const firstTouch = this.storage.get<UTMParameters>(FIRST_TOUCH_KEY);
    if (!firstTouch) {
      this.storage.set(FIRST_TOUCH_KEY, utm);
      this.logger.debug('Set first touch UTM:', utm);
    }

    // Always update last touch (most recent attribution)
    this.storage.set(LAST_TOUCH_KEY, utm);
    this.logger.debug('Updated last touch UTM:', utm);
  }

  /**
   * Get all UTM data (current, first touch, last touch)
   */
  getUTMData(): UTMData {
    return {
      current: this.storage.get<UTMParameters>(SESSION_UTM_KEY) || null,
      firstTouch: this.storage.get<UTMParameters>(FIRST_TOUCH_KEY) || null,
      lastTouch: this.storage.get<UTMParameters>(LAST_TOUCH_KEY) || null,
    };
  }

  /**
   * Get current session UTM parameters
   */
  getCurrentUTM(): UTMParameters | null {
    return this.storage.get<UTMParameters>(SESSION_UTM_KEY) || null;
  }

  /**
   * Get first touch UTM parameters (lifetime attribution)
   */
  getFirstTouchUTM(): UTMParameters | null {
    return this.storage.get<UTMParameters>(FIRST_TOUCH_KEY) || null;
  }

  /**
   * Get last touch UTM parameters (most recent attribution)
   */
  getLastTouchUTM(): UTMParameters | null {
    return this.storage.get<UTMParameters>(LAST_TOUCH_KEY) || null;
  }

  /**
   * Get session referrer
   */
  getSessionReferrer(): string | null {
    return this.storage.get<string>(SESSION_REFERRER_KEY) || null;
  }

  /**
   * Get session landing page
   */
  getSessionLandingPage(): string | null {
    return this.storage.get<string>(SESSION_LANDING_PAGE_KEY) || null;
  }

  /**
   * Whether a new campaign was detected on the current URL, compared against
   * the session UTM as it was BEFORE this page's capture overwrote it. The
   * comparison is done in the constructor / updateUTM() (pre-capture); this
   * getter just returns the captured result so the answer isn't clobbered.
   */
  hasNewCampaign(): boolean {
    return this.newCampaignDetected;
  }

  /**
   * Compare the current URL's UTM parameters against the STORED session UTM.
   * Returns true if the URL carries campaign params that differ from session.
   * MUST be called before captureUTMParameters() overwrites SESSION_UTM_KEY.
   */
  private detectNewCampaign(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const currentSessionUTM = this.getCurrentUTM();

    // If no session UTM exists, check if URL has any UTM params
    if (!currentSessionUTM) {
      return urlParams.has('utm_source') ||
             urlParams.has('utm_medium') ||
             urlParams.has('utm_campaign');
    }

    // Check if any UTM parameter has changed
    const utmParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

    for (const param of utmParams) {
      const urlValue = urlParams.get(param);
      const sessionValue = currentSessionUTM[param];

      if (urlValue && urlValue !== sessionValue) {
        return true;
      }
    }

    return false;
  }

  /**
   * Manually update UTM parameters (for SPAs that change URL without reload).
   * Re-runs the new-campaign detection against the stored session UTM BEFORE
   * capturing overwrites it, so a subsequent hasNewCampaign() is accurate.
   */
  updateUTM(): void {
    if (this.resetSessionOnNewCampaign) {
      this.newCampaignDetected = this.detectNewCampaign();
    }
    this.captureUTMParameters();
  }

  /**
   * Clear session UTM (keeps first/last touch for attribution)
   */
  clearSessionUTM(): void {
    this.storage.remove(SESSION_UTM_KEY);
    this.storage.remove(SESSION_REFERRER_KEY);
    this.storage.remove(SESSION_LANDING_PAGE_KEY);
    this.logger.debug('Cleared session UTM');
  }

  /**
   * Clear all UTM data (including first/last touch)
   */
  clearAllUTM(): void {
    this.storage.remove(SESSION_UTM_KEY);
    this.storage.remove(FIRST_TOUCH_KEY);
    this.storage.remove(LAST_TOUCH_KEY);
    this.storage.remove(SESSION_REFERRER_KEY);
    this.storage.remove(SESSION_LANDING_PAGE_KEY);
    this.logger.debug('Cleared all UTM data');
  }

  /**
   * Reset UTM tracking (used on user logout)
   */
  reset(): void {
    this.clearAllUTM();
  }

  /**
   * Get UTM parameters formatted for event properties
   */
  getUTMProperties(): Record<string, any> {
    const current = this.getCurrentUTM();
    const firstTouch = this.getFirstTouchUTM();
    const lastTouch = this.getLastTouchUTM();

    const properties: Record<string, any> = {};

    // Add current session UTM
    if (current) {
      if (current.utm_source) properties.utm_source = current.utm_source;
      if (current.utm_medium) properties.utm_medium = current.utm_medium;
      if (current.utm_campaign) properties.utm_campaign = current.utm_campaign;
      if (current.utm_content) properties.utm_content = current.utm_content;
      if (current.utm_term) properties.utm_term = current.utm_term;
      if (current.referrer) properties.referrer = current.referrer;
      if (current.landing_page) properties.landing_page = current.landing_page;
    }

    // Add first touch attribution
    if (firstTouch) {
      if (firstTouch.utm_source) properties.first_touch_utm_source = firstTouch.utm_source;
      if (firstTouch.utm_medium) properties.first_touch_utm_medium = firstTouch.utm_medium;
      if (firstTouch.utm_campaign) properties.first_touch_utm_campaign = firstTouch.utm_campaign;
      if (firstTouch.utm_content) properties.first_touch_utm_content = firstTouch.utm_content;
      if (firstTouch.utm_term) properties.first_touch_utm_term = firstTouch.utm_term;
      if (firstTouch.referrer) properties.first_touch_referrer = firstTouch.referrer;
      if (firstTouch.landing_page) properties.first_touch_landing_page = firstTouch.landing_page;
      if (firstTouch.captured_at) properties.first_touch_captured_at = new Date(firstTouch.captured_at).toISOString();
    }

    // Add last touch attribution
    if (lastTouch && lastTouch !== current) {
      if (lastTouch.utm_source) properties.last_touch_utm_source = lastTouch.utm_source;
      if (lastTouch.utm_medium) properties.last_touch_utm_medium = lastTouch.utm_medium;
      if (lastTouch.utm_campaign) properties.last_touch_utm_campaign = lastTouch.utm_campaign;
      if (lastTouch.utm_content) properties.last_touch_utm_content = lastTouch.utm_content;
      if (lastTouch.utm_term) properties.last_touch_utm_term = lastTouch.utm_term;
      if (lastTouch.referrer) properties.last_touch_referrer = lastTouch.referrer;
      if (lastTouch.landing_page) properties.last_touch_landing_page = lastTouch.landing_page;
      if (lastTouch.captured_at) properties.last_touch_captured_at = new Date(lastTouch.captured_at).toISOString();
    }

    return properties;
  }
}
