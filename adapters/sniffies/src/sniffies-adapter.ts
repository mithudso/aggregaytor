/**
 * sniffies-adapter.ts — Sniffies platform adapter.
 *
 * Intercepts Sniffies API responses and WebSocket messages,
 * normalizing them into UnifiedMessage format.
 */

import {
  BaseAdapter,
  walkPayload,
  extractTimestamp,
  extractDirection,
  extractMessageText,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage } from '@aggregaytor/adapter-core';
import { parseSocketIOFrame } from './ws-parser.js';
import { findLikelyProfileId, normalizeProfileId, extractProfileIdFromUrl } from './profile-resolver.js';

export class SniffiesAdapter extends BaseAdapter {
  readonly platform: Platform = 'sniffies';
  private storageTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    // Seed self-IDs from window globals
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);

    // Set up network interception
    this.setupNetworkInterception(window as Window & typeof globalThis);

    // Periodic localStorage scan as fallback
    this.storageTimer = setInterval(() => this.scanStorage(), 60_000);
    this.scanStorage();
  }

  async destroy(): Promise<void> {
    if (this.storageTimer) {
      clearInterval(this.storageTimer);
      this.storageTimer = null;
    }
    await super.destroy();
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    return s.includes('sniffies') && s.includes('/api/');
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];
    const contextId = this.getContextProfileId();

    walkPayload(payload, contextId, {
      onObject: (obj, ctx, _depth) => {
        // Detect self IDs from payload
        this.selfIds.detectFromPayload(obj);

        // Look for message-like objects
        const body = extractMessageText(obj);
        if (!body) return;

        const timestamp = extractTimestamp(obj);
        if (!timestamp) return;

        const profileId = findLikelyProfileId(obj, ctx || '');
        if (!profileId) return;

        const direction = extractDirection(obj, this.selfIds.ids) || 'in';
        const msgId = String(obj.id || obj._id || obj.messageId || `${profileId}:${timestamp}`);

        messages.push({
          id: `sniffies:${msgId}`,
          platform: 'sniffies',
          threadId: `sniffies:${profileId}`,
          contactId: `sniffies:${profileId}`,
          direction,
          body,
          timestamp,
          read: direction === 'out',
          metadata: {
            profileId,
            url,
          },
        });
      },
    });

    return messages;
  }

  protected parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[] {
    const text = typeof data === 'string' ? data : '';
    if (!text) return [];

    const parsed = parseSocketIOFrame(text);
    if (!parsed) return [];

    return this.parseApiResponse('[ws]', parsed);
  }

  private getContextProfileId(): string | null {
    try {
      return extractProfileIdFromUrl(window.location.href) || null;
    } catch {
      return null;
    }
  }

  private scanStorage(): void {
    try {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        if (!/chat|message|inbox|conversation/i.test(key)) continue;
        try {
          const raw = localStorage.getItem(key);
          if (!raw || raw.length > 8_000_000) continue;
          const data = JSON.parse(raw);
          if (data && typeof data === 'object') {
            const messages = this.parseApiResponse(`[storage:${key}]`, data);
            if (messages.length) {
              this.emit({ type: 'messages', payload: messages });
            }
          }
        } catch {
          // not JSON or too large, skip
        }
      }
    } catch {
      // localStorage not available
    }
  }
}
