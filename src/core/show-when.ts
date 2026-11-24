/**
 * "Show when" (BACKLOG D465): the moment a Placement or Web personalization
 * campaign's content is revealed in a page view. The content is fetched as
 * before and HELD; it is revealed at its moment and then stays for that page
 * view. A route change (SPA) starts the moment again.
 *
 *   { kind: 'load' }                       the page loads (default; also: no field)
 *   { kind: 'seconds', seconds: 1..3600 }  visible seconds on the page (like `time_on_page`)
 *   { kind: 'scroll', percent: 1..100 }    share of the page scrolled (like `scroll_depth`)
 *   { kind: 'exit' }                       exit intent (like `exit_intent`): the pointer leaves through the top; touch: a fast scroll up
 *   { kind: 'event', event: '<name>' }     the event was tracked in this visit (SDK session)
 *
 * The page moments are the PageContextTracker's own progress (the same clock
 * the overlay page triggers use, reset on a route change); the visit's event
 * names are kept here, in memory and sessionStorage, per SDK session id.
 *
 * Names and wire values are the backend's (common/show-when.ts) and the same
 * on every Joryio SDK (pinned by sdk-show-when-parity.spec.ts).
 */
import { bucketHash } from '../utils/bucket-hash';
import type { PageContextTracker } from './page-context';

export const SHOW_WHEN_KINDS = ['load', 'seconds', 'scroll', 'exit', 'event'] as const;

/**
 * The just-tracked event a show-when re-check request carries
 * (`recheckEvent`): the server counts it as arrived in the audience
 * conditions, so the re-check never races the event's own write.
 */
export interface RecheckEvent {
  name: string;
  eventId: string;
  properties: Record<string, unknown>;
}

export type ShowWhenKind = (typeof SHOW_WHEN_KINDS)[number];
export type ShowWhen =
  | { kind: 'load' }
  | { kind: 'seconds'; seconds: number }
  | { kind: 'scroll'; percent: number }
  | { kind: 'exit' }
  | { kind: 'event'; event: string };

const intIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * The served value as this SDK honours it: absent = `load`; null = unknown
 * kind or invalid value - such content is never shown (never "on load").
 */
export function parseShowWhen(raw: unknown): ShowWhen | null {
  if (raw === undefined || raw === null) return { kind: 'load' };
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.kind) {
    case 'load':
    case 'exit':
      return { kind: o.kind };
    case 'seconds':
      return intIn(o.seconds, 1, 3600) ? { kind: 'seconds', seconds: o.seconds } : null;
    case 'scroll':
      return intIn(o.percent, 1, 100) ? { kind: 'scroll', percent: o.percent } : null;
    case 'event': {
      const e = typeof o.event === 'string' ? o.event.trim() : '';
      return e && e.length <= 255 ? { kind: 'event', event: e } : null;
    }
    default:
      return null;
  }
}

/** True for content that waits for a moment (valid or not): it is held, or never shown. */
export const isDeferred = (raw: unknown): boolean => parseShowWhen(raw)?.kind !== 'load';

/** Event names that make the SDK ask again (the answer's `recheckOn`): strings of 1-255 characters. */
export function eventNames(raw: unknown, max = 50): string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string' && e.length > 0 && e.length <= 255).slice(0, max) : [];
}

const MAX_EVENTS = 200;

/** The moments of this page view and the event names of this visit. One per SDK. */
export class ShowWhenMoments {
  private events = new Set<string>();
  private sid: string | null | undefined = undefined;
  private listeners = new Set<() => void>();
  private off: (() => void) | null;
  private readonly store: string;

  constructor(
    private page: Pick<PageContextTracker, 'progress' | 'onSignal'> | null,
    private sessionId: () => string | null,
    sdkKey: string,
  ) {
    this.store = `jry_show_when_${bucketHash(sdkKey).toString(36)}`;
    // Every page signal (a second of visible time, a deeper scroll, exit intent, a route change) may bring a moment.
    this.off = page ? page.onSignal(() => this.emit()) : null;
  }

  /** Has this moment come in the current page view? `load` always; null (invalid) never. */
  met(sw: ShowWhen | null): boolean {
    if (!sw) return false;
    if (sw.kind === 'load') return true;
    if (sw.kind === 'event') return this.visitEvents().has(sw.event);
    const p = this.page?.progress();
    if (!p) return false;
    return sw.kind === 'seconds' ? p.seconds >= sw.seconds : sw.kind === 'scroll' ? p.scrollPercent >= sw.percent : p.exitIntent;
  }

  /** An event was tracked: remember its name for this visit and re-check every held content. */
  noteEvent(name: string): void {
    const events = this.visitEvents();
    if (!events.has(name) && events.size < MAX_EVENTS) {
      events.add(name);
      try {
        sessionStorage.setItem(this.store, JSON.stringify({ sid: this.sid, names: Array.from(events) }));
      } catch {
        /* storage blocked: memory only, this page */
      }
    }
    this.emit();
  }

  /** Called whenever a moment may have come. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  destroy(): void {
    this.off?.();
    this.listeners.clear();
  }

  /** The event names tracked in the current SDK session (a new session starts empty). */
  private visitEvents(): Set<string> {
    const sid = this.sessionId();
    if (sid !== this.sid) {
      this.sid = sid;
      this.events = new Set();
      try {
        const raw = JSON.parse(sessionStorage.getItem(this.store) || 'null');
        if (raw && sid && raw.sid === sid) this.events = new Set(eventNames(raw.names, MAX_EVENTS));
      } catch {
        /* ignore */
      }
    }
    return this.events;
  }

  private emit(): void {
    for (const cb of Array.from(this.listeners)) {
      try {
        cb();
      } catch {
        /* a listener never breaks the others */
      }
    }
  }
}
