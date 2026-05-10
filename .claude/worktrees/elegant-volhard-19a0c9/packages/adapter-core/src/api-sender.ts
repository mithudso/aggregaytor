/**
 * api-sender.ts — API replay for sending messages.
 *
 * Captures auth headers from intercepted API calls, then replays
 * the send-message endpoint with the captured credentials.
 * Falls back to DOM injection if API replay fails.
 */

const LOG = '[Aggregaytor:APISender]';

interface CapturedAuth {
  headers: Record<string, string>;
  capturedAt: number;
}

const authCache = new Map<string, CapturedAuth>();
const AUTH_TTL_MS = 30 * 60_000; // 30 minutes

/**
 * Capture auth headers from an intercepted request for later replay.
 */
export function captureAuthHeaders(platform: string, headers: Record<string, string>): void {
  const authHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (lk === 'authorization' || lk === 'x-auth-token' || lk === 'x-api-key' ||
        lk === 'cookie' || lk === 'x-csrf-token' || lk === 'x-session-id' ||
        lk.startsWith('x-grindr') || lk.startsWith('x-sniffies')) {
      authHeaders[key] = value;
    }
  }
  if (Object.keys(authHeaders).length) {
    authCache.set(platform, { headers: authHeaders, capturedAt: Date.now() });
    console.log(`${LOG} Captured auth for ${platform}: ${Object.keys(authHeaders).join(', ')}`);
  }
}

/**
 * Get cached auth headers for a platform.
 */
export function getCapturedAuth(platform: string): Record<string, string> | null {
  const cached = authCache.get(platform);
  if (!cached) return null;
  if (Date.now() - cached.capturedAt > AUTH_TTL_MS) {
    authCache.delete(platform);
    return null;
  }
  return cached.headers;
}

/**
 * Send a message via API replay.
 * Returns true if successful, false if the caller should fall back to DOM.
 */
export async function sendViaApi(
  platform: string,
  contactId: string,
  text: string,
): Promise<boolean> {
  const auth = getCapturedAuth(platform);
  if (!auth) {
    console.log(`${LOG} No captured auth for ${platform}, falling back to DOM`);
    return false;
  }

  try {
    switch (platform) {
      case 'sniffies':
        return await sendSniffiesApi(contactId, text, auth);
      case 'grindr':
        return await sendGrindrApi(contactId, text, auth);
      default:
        return false;
    }
  } catch (err) {
    console.warn(`${LOG} API send failed for ${platform}:`, err);
    return false;
  }
}

async function sendSniffiesApi(contactId: string, text: string, auth: Record<string, string>): Promise<boolean> {
  const profileId = contactId.replace('sniffies:', '');
  // Sniffies sends messages via POST to conversation endpoint
  const res = await fetch(`https://sniffies.com/api/conversations/${profileId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...auth,
    },
    body: JSON.stringify({ body: text, type: 'text' }),
  });
  if (res.ok) {
    console.log(`${LOG} Sniffies API send success`);
    return true;
  }
  console.warn(`${LOG} Sniffies API send failed: ${res.status}`);
  return false;
}

async function sendGrindrApi(contactId: string, text: string, auth: Record<string, string>): Promise<boolean> {
  const conversationId = contactId.replace('grindr:', '');
  const res = await fetch(`https://web.grindr.com/v4/chat/conversation/${conversationId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...auth,
    },
    body: JSON.stringify({ body: text, type: 'text' }),
  });
  if (res.ok) {
    console.log(`${LOG} Grindr API send success`);
    return true;
  }
  console.warn(`${LOG} Grindr API send failed: ${res.status}`);
  return false;
}
