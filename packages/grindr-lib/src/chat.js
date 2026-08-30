// Chat HTTP surface + conversation-id helpers. NOTE: sending a message produces
// no HTTP request (it goes over the WebSocket) — see compose.greet. The only HTTP
// trace of activity is the typing indicator.

/**
 * Build a conversation id. Grindr ids are SORTED ascending-numeric, not
 * `<me>:<them>`. Non-numeric input falls back to a stable lexical order so the
 * result is always commutative (the same pair yields the same id either way).
 * @returns {string} `"{lo}:{hi}"`
 */
export function conversationId(a, b) {
  const x = String(a), y = String(b);
  const nx = Number(x), ny = Number(y);
  const xFirst = (Number.isFinite(nx) && Number.isFinite(ny)) ? (nx <= ny) : (x <= y);
  return xFirst ? `${x}:${y}` : `${y}:${x}`;
}

/**
 * Derive your own id by intersecting two different conversations you are part of
 * (a single sorted id names a pair but identifies neither party). Returns '' when
 * the two share zero OR more than one id — an ambiguous intersection is not a
 * confident answer, and this value is used as your own account id.
 * @returns {string} the single shared id, or ''
 */
export function deriveOwnId(convA, convB) {
  const b = new Set(String(convB).split(':'));
  const shared = [...new Set(String(convA).split(':'))].filter((id) => b.has(id));
  return shared.length === 1 ? shared[0] : '';
}

/**
 * @param {ReturnType<import('./auth.js').createAuth>} auth
 */
export function createChat(auth) {
  /**
   * Fetch message history. A 403 `urn:gr:err:unauthorized_action` means the
   * profile is blocked/hidden — fail fast, don't poll.
   */
  const getHistory = async (convId, limit = 20) =>
    auth.request(`/api/v4/chat/conversation/${auth.encId(convId)}/message?limit=${encodeURIComponent(limit)}`);
  /** Announce typing (also the only HTTP proof the composer took input). */
  const sendTyping = (convId, status = 'Typing') =>
    auth.request('/api/v4/chatstatus/typing', { method: 'POST', body: { conversationId: String(convId), status } });
  return { getHistory, sendTyping };
}
