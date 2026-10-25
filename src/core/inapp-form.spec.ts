import * as vm from 'vm';
import { InAppMessagingManager } from './inapp';
import { installFetch } from './test-harness';

/**
 * A form built in the dashboard's drag & drop editor, submitted from inside the
 * in-app message (2026-10-24).
 *
 * The editor's Signup form block (frontend landingPageBlocks.ts, `jry-form`) is
 *
 *   <form data-jry-form="1" novalidate>
 *     <input type="email" name="email" required>
 *     <input type="text" name="first_name">
 *     <label><input type="checkbox" name="marketing" value="yes"> ...</label>
 *     <button type="submit">Sign up</button>
 *   </form>
 *
 * and the frontend test asserts the block still has that shape. Here the
 * message runtime (the srcdoc bootstrap) runs against a DOM holding exactly
 * those controls: it must intercept the submit, serialize the values, hand
 * them to the host bridge with the message's own campaign id, and show the
 * server's answer; the host bridge must post them to /v1/in-app/form-submit.
 * jsdom is not a dependency of this package, so the DOM is the few calls the
 * bootstrap makes.
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = { getUserId: () => null, getAnonymousId: () => 'anon-1', getAttributes: () => ({}) } as any;
const session = { getSessionId: () => 's-1' } as any;

type Ctl = { tagName: string; name: string; type: string; value: string; checked?: boolean; disabled?: boolean };

/** The Signup form block's controls, as the browser exposes them. */
function blockForm(values: { email: string; first_name: string; marketing: boolean }) {
  const controls: Ctl[] = [
    { tagName: 'INPUT', name: 'email', type: 'email', value: values.email },
    { tagName: 'INPUT', name: 'first_name', type: 'text', value: values.first_name },
    { tagName: 'INPUT', name: 'marketing', type: 'checkbox', value: 'yes', checked: values.marketing },
  ];
  const button: any = { tagName: 'BUTTON', type: 'submit', disabled: false };
  const attrs: Record<string, string> = { 'data-jry-form': '1', novalidate: '' };
  const appended: any[] = [];
  const form: any = {
    tagName: 'FORM',
    hasAttribute: (k: string) => k in attrs,
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    setAttribute: (k: string, v: string) => {
      attrs[k] = String(v);
    },
    removeAttribute: (k: string) => {
      delete attrs[k];
    },
    querySelectorAll: (sel: string) => (sel === 'input,select,textarea' ? controls : [...controls, button]),
    querySelector: (sel: string) => {
      if (sel === '[data-jry-message]') return appended.find((e) => e.attrs['data-jry-message'] !== undefined) || null;
      if (sel.startsWith('button[type="submit"]')) return button;
      return null;
    },
    appendChild: (el: any) => {
      appended.push(el);
      return el;
    },
  };
  return { form, button, appended };
}

/** Run the srcdoc's bootstrap the way the iframe would, against `form`. */
function runBootstrap(srcdoc: string, host: Record<string, any>) {
  const script = srcdoc.match(/<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/)![1];
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const document: any = {
    readyState: 'complete',
    documentElement: { className: '', scrollWidth: 320, scrollHeight: 200 },
    body: { scrollWidth: 320, scrollHeight: 200 },
    addEventListener: (type: string, fn: (e: any) => void) => {
      (listeners[type] ||= []).push(fn);
    },
    createElement: (tag: string) => {
      const attrs: Record<string, string> = {};
      return { tagName: tag.toUpperCase(), attrs, textContent: '', className: '', setAttribute: (k: string, v: string) => (attrs[k] = v) };
    },
  };
  const window: any = { innerWidth: 320, addEventListener() {} };
  window.parent = { innerWidth: 1280, __joryioInApp: host };
  vm.runInNewContext(script, { window, document });
  return {
    bridge: window.joryioBridge,
    submit(form: any) {
      const ev = { target: form, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const fn of listeners.submit || []) fn(ev);
      return ev;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('in-app message forms (drag & drop Signup form block)', () => {
  const make = () => new InAppMessagingManager('https://api.example', 'jry_sdk_test', identity, session, logger);

  it('the bootstrap intercepts form[data-jry-form], posts the values through the bridge, and shows the answer', async () => {
    const srcdoc = (make() as any).buildSrcdoc('camp-1', '<form data-jry-form="1"></form>', '', 'modal') as string;
    const submitForm = jest.fn(() => Promise.resolve({ ok: true, message: 'Thanks for joining!' }));
    const rt = runBootstrap(srcdoc, { submitForm, setSize() {}, logClick() {} });
    const { form, button, appended } = blockForm({ email: 'ada@example.com', first_name: 'Ada', marketing: true });

    const ev = rt.submit(form);
    expect(ev.defaultPrevented).toBe(true); // never a real navigation (the CSP says form-action 'none')
    expect(submitForm).toHaveBeenCalledWith('camp-1', { email: 'ada@example.com', first_name: 'Ada', marketing: ['yes'] });
    expect(button.disabled).toBe(true); // no double submit while in flight
    await flush();
    const msg = appended.find((e) => e.attrs['data-jry-message'] !== undefined);
    expect(msg.textContent).toBe('Thanks for joining!');
    expect(msg.className).toBe('jry-form-success');
  });

  it('an unchecked consent box is not sent, and a refusal shows the error and re-enables the form', async () => {
    const srcdoc = (make() as any).buildSrcdoc('camp-1', '', '', 'modal') as string;
    const submitForm = jest.fn(() => Promise.resolve({ ok: false, errors: ['email is required'] }));
    const rt = runBootstrap(srcdoc, { submitForm, setSize() {} });
    const { form, button, appended } = blockForm({ email: '', first_name: '', marketing: false });

    rt.submit(form);
    expect(submitForm).toHaveBeenCalledWith('camp-1', { email: '', first_name: '' });
    await flush();
    expect(appended[0].textContent).toBe('email is required');
    expect(appended[0].className).toBe('jry-form-error');
    expect(button.disabled).toBe(false);
    expect(form.getAttribute('data-jry-busy')).toBeNull();
  });

  it('a form without data-jry-form is left to the browser', () => {
    const srcdoc = (make() as any).buildSrcdoc('camp-1', '', '', 'modal') as string;
    const submitForm = jest.fn();
    const rt = runBootstrap(srcdoc, { submitForm, setSize() {} });
    const { form } = blockForm({ email: 'a@b.co', first_name: '', marketing: false });
    form.removeAttribute('data-jry-form');
    const ev = rt.submit(form);
    expect(ev.defaultPrevented).toBe(false);
    expect(submitForm).not.toHaveBeenCalled();
  });

  it('the host bridge posts a displayed message\'s values to /v1/in-app/form-submit with the SDK identity', async () => {
    (globalThis as any).window = {};
    try {
      const m = make();
      (m as any).installHostBridge();
      (m as any).runtime = { canSend: () => true, requestTimeoutMs: 5000 };
      const calls = installFetch(() => ({ status: 200, body: { ok: true, message: 'Thanks for joining!' } }));
      (m as any).displayedMessages.set('journey:canvas-1:node-7', { campaign: { id: 'journey:canvas-1:node-7', variantId: 'node-7' } });
      const res = await (globalThis as any).window.__joryioInApp.submitForm('journey:canvas-1:node-7', { email: 'ada@example.com', marketing: ['yes'] });

      expect(res).toEqual({ ok: true, message: 'Thanks for joining!' });
      const post = calls.find((c) => c.path === '/v1/in-app/form-submit')!;
      expect(post.init.method).toBe('POST');
      expect(post.body).toMatchObject({
        campaignId: 'journey:canvas-1:node-7',
        variantId: 'node-7',
        anonymousId: 'anon-1',
        values: { email: 'ada@example.com', marketing: ['yes'] },
      });
      // A message that is not on screen cannot submit.
      const closed = await (globalThis as any).window.__joryioInApp.submitForm('camp-gone', { email: 'x' });
      expect(closed.ok).toBe(false);
    } finally {
      delete (globalThis as any).window;
      delete (globalThis as any).fetch;
    }
  });
});
