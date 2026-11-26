/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes?joryio_editor=frame"}
 */
import { editorFrame, EDITOR_FRAME_FLAG, EDITOR_GLOBAL } from './editor-gate';

/**
 * The editor's Mobile view (1.4.0-beta.8) is a same-origin frame of the page
 * with `?joryio_editor=frame`; the SDK there is inert. Only inside a running
 * editor: a frame elsewhere, or the top window, is a normal page.
 */
describe('editorFrame', () => {
  const setParent = (p: any) => Object.defineProperty(window, 'parent', { configurable: true, value: p });
  afterEach(() => setParent(window));

  it('pins the flag value', () => {
    expect(EDITOR_FRAME_FLAG).toBe('frame');
  });

  it('is false in the top window (no parent)', () => {
    setParent(window);
    expect(editorFrame()).toBe(false);
  });

  it('is true in a frame whose parent runs the editor', () => {
    setParent({ [EDITOR_GLOBAL]: { version: 1 } });
    expect(editorFrame()).toBe(true);
  });

  it('is false when the parent has no editor, or is on another origin (reading it throws)', () => {
    setParent({});
    expect(editorFrame()).toBe(false);
    setParent(
      new Proxy(
        {},
        {
          get() {
            throw new DOMException('Blocked a frame with origin', 'SecurityError');
          },
        },
      ),
    );
    expect(editorFrame()).toBe(false);
  });
});
