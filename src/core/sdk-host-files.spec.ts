/**
 * @jest-environment jsdom
 */
import { SDK_VERSION } from './config';
import { coreFolderOf, sdkHostFileUrls } from './sdk-host-files';

const MAJOR = SDK_VERSION.split('.')[0];
const host = (folder: string, file: string) => `https://sdk.joryio.com/web/${folder}/${file}`;

describe('lazily loaded files come from the core\'s own folder', () => {
  it('reads the folder of a joryio.min.js loaded over https only', () => {
    expect(coreFolderOf('https://sdk.joryio.com/web/1.4.0-beta.4/joryio.min.js')).toBe('https://sdk.joryio.com/web/1.4.0-beta.4/');
    expect(coreFolderOf('https://cdn.jsdelivr.net/npm/@joryio/web-sdk@1.4.0-beta.4/dist/joryio.min.js?x=1#y')).toBe('https://cdn.jsdelivr.net/npm/@joryio/web-sdk@1.4.0-beta.4/dist/');
    expect(coreFolderOf('https://shop.example/static/joryio.umd.js')).toBe('https://shop.example/static/');
    expect(coreFolderOf('http://sdk.joryio.com/web/1/joryio.min.js')).toBeNull();
    expect(coreFolderOf('https://shop.example/static/app.bundle.js')).toBeNull(); // bundled into the site
    expect(coreFolderOf('https://shop.example/static/not-joryio.min.js')).toBeNull();
    expect(coreFolderOf('')).toBeNull();
    expect(coreFolderOf(null)).toBeNull();
    expect(coreFolderOf('not a url')).toBeNull();
  });

  it('a beta core on the SDK host loads the beta\'s side files first, then the version, then the channel', () => {
    const own = 'https://sdk.joryio.com/web/1.4.0-beta.4/';
    expect(sdkHostFileUrls('joryio-editor.min.js', undefined, own)).toEqual([
      host('1.4.0-beta.4', 'joryio-editor.min.js'),
      host(SDK_VERSION, 'joryio-editor.min.js'),
      host(MAJOR, 'joryio-editor.min.js'),
    ]);
  });

  it('a core from the exact version folder: no duplicate', () => {
    expect(sdkHostFileUrls('joryio-cards-ui.min.js', undefined, `https://sdk.joryio.com/web/${SDK_VERSION}/`)).toEqual([
      host(SDK_VERSION, 'joryio-cards-ui.min.js'),
      host(MAJOR, 'joryio-cards-ui.min.js'),
    ]);
  });

  it('a core from the major channel keeps the immutable exact version first (the channel moves)', () => {
    expect(sdkHostFileUrls('joryio-cards-ui.min.js', undefined, `https://sdk.joryio.com/web/${MAJOR}/`)).toEqual([
      host(SDK_VERSION, 'joryio-cards-ui.min.js'),
      host(MAJOR, 'joryio-cards-ui.min.js'),
    ]);
  });

  it('a beta build (SDK_VERSION stamped 1.4.0-beta.6): its own folder on the SDK host, never the major channel', () => {
    // npm beta bundled into a site or served from a CDN: the beta's folder only (web/1/ holds the previous final).
    expect(sdkHostFileUrls('joryio-cards-ui.min.js', undefined, null, '1.4.0-beta.6')).toEqual([host('1.4.0-beta.6', 'joryio-cards-ui.min.js')]);
    expect(sdkHostFileUrls('joryio-editor.min.js', undefined, 'https://cdn.jsdelivr.net/npm/@joryio/web-sdk@1.4.0-beta.6/dist/', '1.4.0-beta.6')).toEqual([
      'https://cdn.jsdelivr.net/npm/@joryio/web-sdk@1.4.0-beta.6/dist/joryio-editor.min.js',
      host('1.4.0-beta.6', 'joryio-editor.min.js'),
    ]);
    expect(sdkHostFileUrls('joryio-editor.min.js', undefined, host('1.4.0-beta.6', ''), '1.4.0-beta.6')).toEqual([host('1.4.0-beta.6', 'joryio-editor.min.js')]);
    // A final keeps the channel as the last resort.
    expect(sdkHostFileUrls('joryio-editor.min.js', undefined, null, '1.4.0')).toEqual([host('1.4.0', 'joryio-editor.min.js'), host('1', 'joryio-editor.min.js')]);
  });

  it('bundled (no own folder): the SDK host as before; an init option replaces everything', () => {
    expect(sdkHostFileUrls('joryio-editor.min.js', undefined, null)).toEqual([host(SDK_VERSION, 'joryio-editor.min.js'), host(MAJOR, 'joryio-editor.min.js')]);
    expect(sdkHostFileUrls('joryio-editor.min.js', 'https://cdn.shop.example/e.js', 'https://sdk.joryio.com/web/1.4.0-beta.4/')).toEqual(['https://cdn.shop.example/e.js']);
  });

  it('the folder is read from the script tag that ran the core (document.currentScript), or the page\'s joryio.min.js tag', () => {
    const load = () => {
      let mod: typeof import('./sdk-host-files') | undefined;
      jest.isolateModules(() => {
        mod = require('./sdk-host-files');
      });
      return mod!;
    };
    const s = document.createElement('script');
    s.src = 'https://sdk.joryio.com/web/1.4.0-beta.4/joryio.min.js';
    const spy = jest.spyOn(document, 'currentScript', 'get').mockReturnValue(s);
    try {
      expect(load().sdkHostFileUrls('joryio-editor.min.js')[0]).toBe(host('1.4.0-beta.4', 'joryio-editor.min.js'));
      // currentScript is the site's own bundle: not a core tag, the SDK host as before.
      const app = document.createElement('script');
      app.src = 'https://shop.example/app.js';
      spy.mockReturnValue(app);
      expect(load().sdkHostFileUrls('joryio-editor.min.js')[0]).toBe(host(SDK_VERSION, 'joryio-editor.min.js'));
      // No currentScript (read later, or a module): the page's core tag.
      spy.mockReturnValue(null);
      document.head.appendChild(s);
      expect(load().sdkHostFileUrls('joryio-editor.min.js')[0]).toBe(host('1.4.0-beta.4', 'joryio-editor.min.js'));
    } finally {
      spy.mockRestore();
      s.remove();
    }
  });
});
