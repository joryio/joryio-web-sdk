/**
 * The visual editor bundle - `joryio-editor.min.js` on the SDK host, next to
 * `joryio.min.js` (BACKLOG D444 Phase 4 follow-up).
 *
 * Loaded by the core's EditorGate (src/core/editor-gate.ts) only in a tab the
 * Joryio dashboard opened for the point-and-click editor, and only after the
 * server vouched for the editor token. It registers one global and does
 * nothing else on its own: no request, no listener, until the gate calls
 * `start` with the verified dashboard origin.
 */
import { VisualEditor } from './visual-editor';
import { EDITOR_API_VERSION, EDITOR_GLOBAL, type EditorBundleApi } from '../core/editor-gate';

const api: EditorBundleApi = {
  version: EDITOR_API_VERSION,
  start({ dashboardOrigin, opener, logger, onStop }) {
    const editor = new VisualEditor(dashboardOrigin, opener, logger, onStop);
    editor.start();
    return { stop: () => editor.stop() };
  },
};

if (typeof window !== 'undefined' && !(window as any)[EDITOR_GLOBAL]) {
  (window as any)[EDITOR_GLOBAL] = api;
}

export { api as editorApi };
