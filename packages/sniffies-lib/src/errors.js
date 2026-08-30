// Typed errors for the Sniffies interaction library. Never place a cookie or
// session value in a message — callers surface these to logs/UIs.

/** An HTTP or protocol failure from a Sniffies call. */
export class SniffiesError extends Error {
  /**
   * @param {string} message human-readable summary (no secrets)
   * @param {{status?:number, path?:string, base?:string}} [meta]
   */
  constructor(message, { status = 0, path = '', base = '' } = {}) {
    super(message);
    this.name = 'SniffiesError';
    this.status = status;
    this.path = path;
    this.base = base;
  }
}

/** Raised when every candidate API base failed for a request. */
export class SniffiesAllBasesError extends SniffiesError {
  /**
   * @param {string} path
   * @param {Array<{base:string, error:Error}>} attempts
   */
  constructor(path, attempts = []) {
    super(`All API bases failed for ${path}`, { status: 0, path });
    this.name = 'SniffiesAllBasesError';
    this.attempts = attempts;
  }
}

/** Raised when a request is aborted by the fetch timeout. */
export class SniffiesTimeoutError extends SniffiesError {
  constructor(path, ms) {
    super(`Request timed out after ${ms}ms: ${path}`, { status: 0, path });
    this.name = 'SniffiesTimeoutError';
    this.timeoutMs = ms;
  }
}
