import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SniffiesAdapter } from '../src/sniffies-adapter.js';

/**
 * Tests for forceRefreshConversation() — the method that fires a chat-data
 * fetch when the user opens a Sniffies profile, so the side panel shows
 * history even when Sniffies' own UI leaves the chat blank.
 *
 * We skip init() (which needs a real window) and only exercise the single
 * public method, stubbing global fetch.
 */
describe('SniffiesAdapter.forceRefreshConversation', () => {
  let adapter: SniffiesAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let origFetch: typeof fetch | undefined;

  beforeEach(() => {
    adapter = new SniffiesAdapter({ platform: 'sniffies' });
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    if (origFetch) globalThis.fetch = origFetch;
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it('GETs the chat-data endpoint for a valid profile ID', async () => {
    await adapter.forceRefreshConversation('abcdef123456');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://sniffies.com/api/v2/post-authentication/chat-data');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.headers.Accept).toBe('application/json');
  });

  it('no-ops when the profile ID is not a valid hex string', async () => {
    await adapter.forceRefreshConversation('not-hex');
    await adapter.forceRefreshConversation('');
    await adapter.forceRefreshConversation('short');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('debounces rapid calls for the same profile', async () => {
    await adapter.forceRefreshConversation('abcdef123456');
    await adapter.forceRefreshConversation('abcdef123456');
    await adapter.forceRefreshConversation('abcdef123456');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not debounce across different profiles', async () => {
    await adapter.forceRefreshConversation('abcdef123456');
    await adapter.forceRefreshConversation('fedcba654321');
    await adapter.forceRefreshConversation('0123456789ab');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('normalizes uppercase / whitespace profile IDs before dedup', async () => {
    await adapter.forceRefreshConversation('ABCDEF123456');
    await adapter.forceRefreshConversation('  abcdef123456  ');
    // Same canonical ID — debounce kicks in on the second call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows fetch errors so the caller never throws', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    await expect(adapter.forceRefreshConversation('abcdef123456')).resolves.toBeUndefined();
  });
});
