import { DEFAULT_API_ENDPOINT, normalizeApiEndpoint } from './config';

/**
 * The API base is built the same way on web, iOS and Android: scheme added,
 * trailing slash removed, "/api" appended when the host carries no path.
 * The built-in default itself used to be a bare host and 404ed on production.
 */
describe('normalizeApiEndpoint', () => {
  it('the default carries the /api prefix', () => {
    expect(DEFAULT_API_ENDPOINT).toBe('https://api-eu1.joryio.com/api');
    expect(normalizeApiEndpoint(undefined)).toBe(DEFAULT_API_ENDPOINT);
    expect(normalizeApiEndpoint('')).toBe(DEFAULT_API_ENDPOINT);
  });

  it('a bare host gets https and /api', () => {
    expect(normalizeApiEndpoint('api-eu1.joryio.com')).toBe('https://api-eu1.joryio.com/api');
    expect(normalizeApiEndpoint('https://api-eu1.joryio.com')).toBe('https://api-eu1.joryio.com/api');
    expect(normalizeApiEndpoint('https://api-eu1.joryio.com/')).toBe('https://api-eu1.joryio.com/api');
  });

  it('a full base is kept, minus the trailing slash, and http is preserved for local backends', () => {
    expect(normalizeApiEndpoint('https://api-eu1.joryio.com/api')).toBe('https://api-eu1.joryio.com/api');
    expect(normalizeApiEndpoint('https://api-eu1.joryio.com/api/')).toBe('https://api-eu1.joryio.com/api');
    expect(normalizeApiEndpoint('http://localhost:3000/api')).toBe('http://localhost:3000/api');
    expect(normalizeApiEndpoint('http://localhost:3000')).toBe('http://localhost:3000/api');
  });
});
