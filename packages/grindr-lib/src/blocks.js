import { GrindrError } from './errors.js';

const HIDE_BASE = '/api/v1/me/hides';
const BLOCK_BASE = '/api/v3/me/blocks';
const HIDE_LIST = '/api/v1/hides';
const BLOCK_LIST = '/api/v4/blocks?page=1';

/**
 * Block / hide client. Hide and block are mutually exclusive server-side states —
 * this never chains a block after a hide (a trailing block undoes the hide).
 * @param {ReturnType<import('./auth.js').createAuth>} auth
 */
export function createBlocks(auth) {
  /** POST a hide. @returns {Promise<true>} */
  const hide = async (id) => { await auth.request(`${HIDE_BASE}/${auth.encId(id)}`, { method: 'POST' }); return true; };
  /** POST a real block. @returns {Promise<true>} */
  const block = async (id) => { await auth.request(`${BLOCK_BASE}/${auth.encId(id)}`, { method: 'POST' }); return true; };
  /**
   * Reverse a block. `kind:'hide'` throws — DELETE /api/v1/me/hides returns 501,
   * there is no un-hide via that verb. Any kind other than 'block'/'hide' is
   * rejected rather than silently treated as a block.
   * @param {string} id
   * @param {'block'|'hide'} [kind]
   * @returns {Promise<true>}
   */
  const unblock = async (id, kind = 'block') => {
    if (kind === 'hide') throw new GrindrError('no un-hide: DELETE /api/v1/me/hides returns 501', { status: 501, code: 'no-unhide', path: HIDE_BASE });
    if (kind !== 'block') throw new GrindrError(`unblock: unknown kind ${JSON.stringify(String(kind))}`, { status: 0, code: 'bad-kind', path: BLOCK_BASE });
    await auth.request(`${BLOCK_BASE}/${auth.encId(id)}`, { method: 'DELETE' });
    return true;
  };
  /** GET the full (unpaginated) hides list. Mirrors listBlocks' leniency: any
   * shape without a `hides` array (`{}`, null, or a bare array) is read as "no
   * hides" rather than thrown, so a benign empty response can't abort the
   * reconcile/drain that consumes it. @returns {Promise<Array>} */
  const listHides = async () => {
    const d = await auth.request(HIDE_LIST);
    if (Array.isArray(d && d.hides)) return d.hides;
    if (Array.isArray(d)) return d;
    return [];
  };
  /**
   * Walk the paginated blocks list. Stops on an empty page OR a page that adds no
   * new ids (a server that ignores ?page would otherwise duplicate page 1 up to
   * maxPages times). The returned array carries a non-enumerable `complete` flag:
   * false means the walk hit the page cap and the list may be truncated.
   * @returns {Promise<Array>}
   */
  const listBlocks = async ({ maxPages = 20 } = {}) => {
    const cap = Number.isFinite(maxPages) && maxPages >= 1 ? Math.floor(maxPages) : 20;
    const out = [];
    const seen = new Set();
    let complete = false;
    for (let page = 1; page <= cap; page += 1) {
      const d = await auth.request(BLOCK_LIST.replace(/page=\d+/, `page=${page}`));
      const rows = Array.isArray(d && d.blocks) ? d.blocks : [];
      if (!rows.length) { complete = true; break; }
      let added = 0;
      for (const r of rows) {
        const key = r && r.profileId != null ? String(r.profileId) : `#${page}:${added}`;
        if (seen.has(key)) continue;
        seen.add(key); out.push(r); added += 1;
      }
      if (!added) { complete = true; break; }   // server ignored ?page — stop, don't duplicate
    }
    Object.defineProperty(out, 'complete', { value: complete, enumerable: false });
    return out;
  };
  return { hide, block, unblock, listHides, listBlocks };
}
