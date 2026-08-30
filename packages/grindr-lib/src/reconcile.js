import { isPlausibleProfileId } from './dom.js';

/**
 * Pull every profileId out of a hides/blocks payload. Parsed structurally where
 * possible; a whole-number regex fallback runs ONLY when JSON parsing failed —
 * a well-formed but empty list must return empty, or an envelope number
 * (totalCount, a timestamp) would be mistaken for a profileId.
 * @param {string|object} text parsed value or JSON string
 * @returns {Set<string>}
 */
export function idsFromListPayload(text) {
  const out = new Set();
  let parsed = false;
  try {
    const seen = (v, d) => {
      if (!v || typeof v !== 'object' || d > 4) return;
      if (Array.isArray(v)) { for (const x of v) seen(x, d + 1); return; }
      const pid = v.profileId != null ? String(v.profileId) : '';
      if (isPlausibleProfileId(pid)) out.add(pid);
      for (const k of Object.keys(v)) { const x = v[k]; if (x && typeof x === 'object') seen(x, d + 1); }
    };
    seen(typeof text === 'string' ? JSON.parse(text) : text, 0);
    parsed = true;
  } catch (_e) {}
  if (!parsed && !out.size && typeof text === 'string') {
    for (const mm of text.matchAll(/(?:^|[^0-9])([0-9]{5,10})(?![0-9])/g)) {
      if (isPlausibleProfileId(mm[1])) out.add(mm[1]);
    }
  }
  return out;
}

/**
 * Classify local ids against Grindr's own lists. `needsUpgrade` is the set of
 * hide-only ids that are not real blocks (a hide never removes anyone from the
 * cascade, so those are the ones worth upgrading to a block).
 * @param {{blocks:{listHides:()=>Promise<Array>, listBlocks:(o?:any)=>Promise<Array>}}} client
 * @param {{maxPages?:number}} [opts]
 * @returns {Promise<{hideIds:Set<string>, blockIds:Set<string>, needsUpgrade:Set<string>}>}
 */
export async function reconcileTiers(client, { maxPages = 20 } = {}) {
  const hides = await client.blocks.listHides();
  const blocks = await client.blocks.listBlocks({ maxPages });
  // Guard each row: a null/undefined entry or a non-array list must not throw and
  // abort the whole reconcile (it drives the drain backlog).
  const toIdSet = (rows) => new Set(
    (Array.isArray(rows) ? rows : [])
      .map((r) => (r && r.profileId != null ? String(r.profileId) : ''))
      .filter(isPlausibleProfileId),
  );
  const hideIds = toIdSet(hides);
  const blockIds = toIdSet(blocks);
  const needsUpgrade = new Set([...hideIds].filter((id) => !blockIds.has(id)));
  return { hideIds, blockIds, needsUpgrade };
}
