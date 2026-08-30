// Private-album share client. A 403 on an album op means the album is not yours
// (deleted/invalid) — the caller should retire it rather than retry.

function uuid4() {
  try { if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID(); } catch (_e) {}
  const b = new Uint8Array(16);
  let filled = false;
  try { if (globalThis.crypto && globalThis.crypto.getRandomValues) { globalThis.crypto.getRandomValues(b); filled = true; } } catch (_e) {}
  if (!filled) for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/**
 * @param {ReturnType<import('./auth.js').createAuth>} auth
 */
export function createAlbums(auth) {
  /** @returns {Promise<string[]>} profile ids that already hold the album */
  const getShares = async (albumId) => {
    const d = await auth.request(`/api/v1/albums/${auth.encId(albumId)}/shares`);
    return Array.isArray(d && d.profileIds) ? d.profileIds : [];
  };
  /** Share an album with a profile. */
  const share = async (albumId, profileId, shareId) =>
    auth.request(`/api/v1/albums/${auth.encId(albumId)}/shares`, { method: 'POST', body: { profiles: [{ profileId: String(profileId), shareId: shareId || uuid4() }] } });
  /** Revoke a share (PUT unshares, fresh uuid). */
  const unshare = async (albumId, profileId, shareId) =>
    auth.request(`/api/v1/albums/${auth.encId(albumId)}/unshares`, { method: 'PUT', body: { profiles: [{ profileId: String(profileId), shareId: shareId || uuid4() }] } });
  /** Query whether a profile has/was-shared an album (a query despite the POST). */
  const queryShare = (profileId) =>
    auth.request('/api/v2/albums/shares', { method: 'POST', body: { profileId: String(profileId) } });
  return { getShares, share, unshare, queryShare };
}
