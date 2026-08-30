// Opt-in rate limiter. Grindr force-logs-out on bursts of writes, so callers that
// issue many block/hide/album calls should route them through here: it serializes
// calls behind a minimum interval and a rolling hourly cap.

const HOUR_MS = 3_600_000;

/**
 * @param {{minIntervalMs?:number, maxPerHour?:number}} [opts]
 * @returns {{run:(fn:()=>Promise<any>)=>Promise<any>, pending:()=>number}}
 */
export function createLimiter({ minIntervalMs = 500, maxPerHour = 500 } = {}) {
  // Normalize once: an invalid/zero/negative cap must not silently disable
  // limiting, so it falls back to the default cap (not Infinity, which would
  // remove the hourly limit entirely and permit the very bursts this guards).
  const cap = Number.isFinite(maxPerHour) && maxPerHour >= 1 ? Math.floor(maxPerHour) : 500;
  const minMs = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 0;

  let chain = Promise.resolve();
  let lastAt = 0;
  let size = 0;
  const stamps = [];
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && typeof t.unref === 'function') t.unref(); });

  async function gate() {
    let now = Date.now();
    while (stamps.length && now - stamps[0] > HOUR_MS) stamps.shift();
    if (stamps.length && stamps.length >= cap) {
      const wait = HOUR_MS - (now - stamps[0]);
      if (wait > 0) await sleep(wait);
    }
    now = Date.now();
    const since = now - lastAt;
    if (since < minMs) await sleep(minMs - since);
    lastAt = Date.now();
    stamps.push(lastAt);
  }

  function run(fn) {
    size += 1;
    const p = chain.then(async () => {
      try { await gate(); return await fn(); }
      finally { size -= 1; }
    });
    chain = p.catch(() => {});
    return p;
  }

  return { run, pending: () => size };
}
