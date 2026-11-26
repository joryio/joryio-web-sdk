/**
 * @jest-environment jsdom
 */
import { liquidField } from './liquid-field';

/**
 * 1.4.0-beta.9 test: closing a pill's fallback popover removed it, the removal
 * moved focus, and the popover's focusout removed it AGAIN mid-removal -
 * Chromium throws "Failed to execute 'remove' on 'Element'" into the host page.
 * jsdom fires no blur on removal, so these tests make removal behave like
 * Chromium: blur/focusout fire synchronously, and re-entering the removal of
 * the node being removed throws.
 */
const words = { title: 'Fallback for {name}', help: 'help', bad: 'bad', done: 'Done' };
const restore: Array<() => void> = [];
afterEach(() => {
  restore.splice(0).forEach((r) => r());
  document.body.textContent = '';
});

/** Removing a node that holds focus fires blur on it and focusout (bubbling) first; a removal re-entered meanwhile throws. */
function chromiumRemoval(): void {
  const removing = new Set<Node>();
  const blurInside = (n: Node) => {
    const active = document.activeElement;
    if (!active || !n.contains(active)) return;
    active.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
    active.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  };
  const guard = (n: Node) => {
    if (removing.has(n)) throw new DOMException("Failed to execute 'remove' on 'Element': the node is being removed", 'NotFoundError');
  };
  const elRemove = Element.prototype.remove;
  const removeChild = Node.prototype.removeChild;
  Element.prototype.remove = function (this: Element) {
    guard(this);
    removing.add(this);
    try {
      blurInside(this);
      elRemove.call(this);
    } finally {
      removing.delete(this);
    }
  };
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    guard(child);
    removing.add(child);
    try {
      blurInside(child);
      return removeChild.call(this, child) as T;
    } finally {
      removing.delete(child);
    }
  };
  restore.push(() => {
    Element.prototype.remove = elRemove;
    Node.prototype.removeChild = removeChild;
  });
}

function field(onChange: (v: string) => void = () => undefined) {
  const f = liquidField({ label: 'Text', rawNote: 'raw', root: null, onChange, fallback: words });
  document.body.appendChild(f.el);
  return f;
}
const popover = (root: ParentNode) => root.querySelectorAll('[data-j="fallback-pop"]');

describe('the pill fallback popover is removed once, never twice', () => {
  it('closePop() while the popover input has focus: no error, the popover is gone', () => {
    chromiumRemoval();
    const f = field();
    f.set('Hi {{ user.firstName }}');
    expect(f.openPill('user.firstName')).toBe(true);
    const input = f.el.querySelector('[data-j="fallback"]') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(() => f.closePop()).not.toThrow();
    expect(popover(f.el)).toHaveLength(0);
    expect(f.closePop()).toBe(false);
  });

  it('Enter / Escape in the popover input: no error', () => {
    chromiumRemoval();
    const f = field();
    f.set('Hi {{ user.firstName }}');
    f.openPill('user.firstName');
    const input = f.el.querySelector('[data-j="fallback"]') as HTMLInputElement;
    input.focus();
    expect(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))).not.toThrow();
    expect(popover(f.el)).toHaveLength(0);
  });

  it('set() while the popover is open and focused: no error, one field drawn', () => {
    chromiumRemoval();
    const f = field();
    f.set('Hi {{ user.firstName }}');
    f.openPill('user.firstName');
    (f.el.querySelector('[data-j="fallback"]') as HTMLInputElement).focus();
    expect(() => f.set('Bye {{ user.lastName }}')).not.toThrow();
    expect(popover(f.el)).toHaveLength(0);
    expect(f.el.querySelectorAll('[data-j="text"]')).toHaveLength(1);
  });

  it('set() while the text box (with hand-typed Liquid) has focus: its blur does not redraw a second field', () => {
    chromiumRemoval();
    const f = field();
    f.set('Hi {{ user.firstName }}');
    const ce = f.el.querySelector('[data-j="text"]') as HTMLElement;
    ce.appendChild(document.createTextNode(' {{ user.email }}')); // typed by hand: becomes a pill on blur
    ce.tabIndex = 0;
    ce.focus();
    expect(document.activeElement).toBe(ce);
    expect(() => f.set('Other {{ user.lastName }}')).not.toThrow();
    expect(f.el.querySelectorAll('[data-j="text"]')).toHaveLength(1);
    expect(f.el.textContent).toContain('lastName');
  });
});
