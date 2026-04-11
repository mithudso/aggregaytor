/**
 * ws-parser.ts — Socket.IO frame parsing for Sniffies WebSocket messages.
 *
 * Sniffies uses Socket.IO which prefixes frames with "42".
 * Extracted from sniffiesplus parseWsPayloadText() (lines 4139-4163).
 */

export function parseSocketIOFrame(text: string): unknown | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) return null;

  let parsed: unknown = null;
  try {
    if (trimmed.startsWith('42')) {
      const socketPayload = JSON.parse(trimmed.slice(2));
      if (Array.isArray(socketPayload)) {
        parsed = socketPayload.length > 1 ? socketPayload[1] : socketPayload[0];
      } else {
        parsed = socketPayload;
      }
    } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      parsed = JSON.parse(trimmed);
    }
  } catch {
    // invalid JSON, ignore
  }

  // Handle double-encoded JSON strings
  if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // not double-encoded, keep as-is
    }
  }

  return parsed && typeof parsed === 'object' ? parsed : null;
}
