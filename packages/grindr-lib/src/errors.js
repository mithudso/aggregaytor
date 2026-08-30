// Typed errors for the Grindr interaction library. Never place a token in a
// message — callers surface these to logs/UIs.

/**
 * Best-effort extraction of a `urn:gr:err:*` code from an error body. Works for
 * an already-parsed object, an array, or a JSON string, and always falls through
 * to a text scan so a valid-JSON body in an unexpected shape still yields a code.
 * @param {any} body parsed object or raw JSON string
 * @returns {string} the code, or '' when none is present
 */
export function parseErrorCode(body) {
  try {
    const o = typeof body === 'string' ? JSON.parse(body) : body;
    const c = o && o.code;
    if (typeof c === 'string' && c.startsWith('urn:gr:err:')) return c;
  } catch (_e) { /* fall through to the text scan */ }
  try {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    const m = String(s || '').match(/urn:gr:err:[a-z0-9_.-]+/i);
    return m ? m[0] : '';
  } catch (_e) {
    return '';
  }
}

/** An HTTP or protocol failure from a Grindr call. */
export class GrindrError extends Error {
  /**
   * @param {string} message human-readable summary (no secrets)
   * @param {{status?:number, code?:string, path?:string, cause?:any}} [meta]
   */
  constructor(message, { status = 0, code = '', path = '', cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'GrindrError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/** Raised when a request is attempted before credentials are set. */
export class GrindrAuthError extends GrindrError {
  constructor(message = 'Grindr credentials are not set') {
    super(message, { status: 0, code: 'no-auth' });
    this.name = 'GrindrAuthError';
  }
}
