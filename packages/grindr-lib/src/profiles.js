/**
 * Profile / cascade / views client.
 * @param {ReturnType<import('./auth.js').createAuth>} auth
 */
export function createProfiles(auth) {
  /** GET a single profile. */
  const getProfile = async (id) => auth.request(`/api/v7/profiles/${auth.encId(id)}`);
  /** Record a profile view. */
  const recordView = async (id) => auth.request(`/api/v4/views/${auth.encId(id)}`, { method: 'POST' });
  /**
   * Fetch a cascade page. `params` is serialized to a query string; null/undefined
   * values are omitted rather than sent as the literal "null"/"undefined".
   */
  const getCascade = (params = {}) => {
    const q = Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return auth.request(q ? `/api/v4/cascade/?${q}` : '/api/v4/cascade/');
  };
  return { getProfile, getCascade, recordView };
}
