// Opt-in rate limiter mirroring the userscript's profile-fetch posture
// (MAX_REQUESTS_PER_MIN = 6, COOLDOWN_MS = 10 min). Sniffies throttles/blocks
// abusive clients, so callers issuing many profile fetches should route them
// through here: calls are serialized behind a minimum interval and a rolling
// per-minute cap, and a caller-reported server rejection opens a cooldown gate.

/**
 * @param {{maxPerMinute?:number, minIntervalMs?:number, cooldownMs?:number}} [opts]
 * @returns {{run:(fn:()=>Promise<any>)=>Promise<any>, reportRejection:()=>void,
 *            cooldownRemainingMs:()=>number, pending:()=>number}}
 */
export function createLimiter({ maxPerMinute = 6, minIntervalMs = 1_000, cooldownMs = 600_000 } = {}) {
  let chain = Promise.resolve();
  let lastAt = 0;
  let size = 0;
  let cooldownUntil = 0;
  const stamps = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function gate() {
    let now = Date.now();
    if (now < cooldownUntil) await sleep(cooldownUntil - now);
    now = Date.now();
    while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
    if (stamps.length >= maxPerMinute) {
      const wait = 60_000 - (now - stamps[0]);
      if (wait > 0) await sleep(wait);
    }
    now = Date.now();
    const since = now - lastAt;
    if (since < minIntervalMs) await sleep(minIntervalMs - since);
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

  /** Call when the server signals throttling (429/403): pauses the queue for cooldownMs. */
  const reportRejection = () => { cooldownUntil = Date.now() + cooldownMs; };

  return {
    run,
    reportRejection,
    cooldownRemainingMs: () => Math.max(0, cooldownUntil - Date.now()),
    pending: () => size,
  };
}
