/**
 * The point-and-click editor's door in the core bundle (BACKLOG D444 Phase 4,
 * docs/PLACEMENTS_WEBSITE_LAYER.md 3).
 *
 * The visual editor itself (highlight, panel, selector computation) is a
 * separate file, `joryio-editor.min.js`, served from the same SDK host next to
 * `joryio.min.js`, so the ~every-visitor bundle carries only this handshake:
 *
 *  1. only when the tab was opened with `?joryio_editor=1` AND by another
 *     window (`window.opener`) AND page edits are not switched off in the
 *     site's code (`pageEdits: false`), post `joryio:editor-ready` to the
 *     opener (no secret in it);
 *  2. accept `joryio:editor-token` only from that opener window, and check
 *     the token with `POST /v1/in-app/editor/verify`, which answers the
 *     dashboard origin it was minted for (bound to this site's origin and
 *     this SDK key's workspace; refused when page edits are off);
 *  3. only then load the editor bundle and hand it the verified dashboard
 *     origin and the opener. Nothing is loaded for any other visitor.
 */
import type { Logger } from '../utils/logger';
import { sdkIdentityHeaders } from './config';
import { loadSdkScript, sdkHostFileUrls } from './sdk-host-files';

export const EDITOR_QUERY_FLAG = 'joryio_editor';
export const EDITOR_MESSAGES = {
  READY: 'joryio:editor-ready',
  TOKEN: 'joryio:editor-token',
  ACTIVE: 'joryio:editor-active',
  PICK: 'joryio:editor-pick',
  CLOSE: 'joryio:editor-close',
  CLOSED: 'joryio:editor-closed',
} as const;

/** The global the editor bundle registers itself under, and the contract version between the two files. */
export const EDITOR_GLOBAL = '__joryioEditor';
export const EDITOR_API_VERSION = 1;
/** The file next to joryio.min.js on the SDK host. */
export const EDITOR_BUNDLE_FILE = 'joryio-editor.min.js';

export interface EditorBundleApi {
  version: number;
  start(ctx: { dashboardOrigin: string; opener: Window; logger: Logger; onStop: () => void }): { stop(): void };
}

/**
 * Where the editor bundle is loaded from: the exact SDK version's folder on
 * the SDK host, then the major channel (see sdkHostFileUrls).
 * `editorScriptUrl` (init) replaces both, for a self-hosted SDK.
 */
export function editorBundleUrls(override?: string): string[] {
  return sdkHostFileUrls(EDITOR_BUNDLE_FILE, override);
}

/** True when this tab was opened by the dashboard's editor (the flag and an opener). */
export function editorRequested(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.opener && new URLSearchParams(window.location.search).get(EDITOR_QUERY_FLAG) === '1';
  } catch {
    return false;
  }
}

/** The flag's value on the editor's own Mobile view (a frame of the page at phone width, 1.4.0-beta.8). */
export const EDITOR_FRAME_FLAG = 'frame';

/**
 * True in the editor's Mobile view: a same-origin frame of the page, opened
 * with `?joryio_editor=frame` by the editor running in its parent tab. The
 * SDK there is inert (no page view, no in-app message, no page edit): the
 * frame is a preview the editor draws on, not a visit. A frame on another
 * origin, or one whose parent is not a running editor, is a normal page.
 */
export function editorFrame(): boolean {
  try {
    if (typeof window === 'undefined' || window.parent === window) return false;
    if (new URLSearchParams(window.location.search).get(EDITOR_QUERY_FLAG) !== EDITOR_FRAME_FLAG) return false;
    // Reading the parent's global throws across origins.
    return !!(window.parent as any)[EDITOR_GLOBAL];
  } catch {
    return false;
  }
}

function loadScript(src: string): Promise<void> {
  return loadSdkScript(src, 'data-joryio-editor');
}

export class EditorGate {
  private opener: Window | null = null;
  private dashboardOrigin: string | null = null;
  private verifying = false;
  private session: { stop(): void } | null = null;
  private off: (() => void) | null = null;

  constructor(
    private apiEndpoint: string,
    private sdkKey: string,
    private logger: Logger,
    private options: { scriptUrl?: string; load?: (src: string) => Promise<void> } = {},
  ) {}

  /** Step 1. Does nothing unless the dashboard's editor opened this tab. */
  start(): void {
    if (!editorRequested() || this.opener) return;
    this.opener = window.opener as Window;
    const onMessage = (e: MessageEvent) => void this.onMessage(e);
    window.addEventListener('message', onMessage);
    this.off = () => window.removeEventListener('message', onMessage);
    try {
      // No secret in it, so any target origin: the dashboard checks it came from the tab it opened.
      this.opener.postMessage({ type: EDITOR_MESSAGES.READY }, '*');
    } catch {
      /* the opener went away */
    }
  }

  isActive(): boolean {
    return !!this.session;
  }

  stop(): void {
    const session = this.session;
    this.session = null;
    session?.stop();
    this.off?.();
    this.off = null;
    this.dashboardOrigin = null;
    this.opener = null;
  }

  private async onMessage(e: MessageEvent): Promise<void> {
    const data = e.data as { type?: string; token?: string } | null;
    if (!data || typeof data.type !== 'string' || this.dashboardOrigin) return;
    if (data.type !== EDITOR_MESSAGES.TOKEN || e.source !== this.opener || typeof data.token !== 'string' || this.verifying) return;
    this.verifying = true;
    try {
      const res = await fetch(`${this.apiEndpoint}/v1/in-app/editor/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SDK-Key': this.sdkKey, ...sdkIdentityHeaders() },
        body: JSON.stringify({ token: data.token }),
      });
      const answer = res.ok ? await res.json() : null;
      // The token says which dashboard may talk to this tab; the message must have come from it.
      if (!answer?.valid || typeof answer.dashboardOrigin !== 'string' || answer.dashboardOrigin !== e.origin) {
        this.logger.warn('Joryio editor: the editor token was not accepted for this site');
        return;
      }
      this.dashboardOrigin = answer.dashboardOrigin;
      // The message listener of the handshake is done; the editor installs its own.
      this.off?.();
      this.off = null;
      await this.loadAndStart(answer.dashboardOrigin);
    } catch (error) {
      this.logger.debug('Joryio editor verification failed', error);
    } finally {
      this.verifying = false;
    }
  }

  /** Step 3: the bundle, only now. */
  private async loadAndStart(dashboardOrigin: string): Promise<void> {
    const load = this.options.load ?? loadScript;
    let api: EditorBundleApi | undefined = (window as any)[EDITOR_GLOBAL];
    for (const src of api ? [] : editorBundleUrls(this.options.scriptUrl)) {
      try {
        await load(src);
        api = (window as any)[EDITOR_GLOBAL];
        if (api) break;
      } catch (error) {
        this.logger.debug('Joryio editor bundle failed to load', error);
      }
    }
    if (!api || api.version !== EDITOR_API_VERSION || typeof api.start !== 'function' || !this.opener) {
      this.logger.warn('Joryio editor: the editor could not be loaded (check that your Content-Security-Policy allows sdk.joryio.com)');
      return;
    }
    this.session = api.start({ dashboardOrigin, opener: this.opener, logger: this.logger, onStop: () => this.stop() });
  }
}
