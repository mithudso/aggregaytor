/**
 * dom-observer.ts — DOM-based message extraction using MutationObserver.
 *
 * For server-rendered sites (DoubleList, Adam4Adam) where DOM is the
 * primary data source rather than API interception.
 */

import type { DOMExtractorOptions } from './types.js';

export function createDOMExtractor(
  target: Document,
  opts: DOMExtractorOptions,
): () => void {
  // v0.57.52: TDZ fix. The previous version returned early on !root BEFORE
  // reaching `let cleanup = null`, so when the bodyObserver callback fired
  // later and called attachObserver(found), the assignment to `cleanup`
  // hit "Cannot access 'cleanup' before initialization" (the binding
  // existed in the closure scope but was uninitialized — let's TDZ).
  // Hoisted both `cleanup` and `attachObserver` above the early return.
  let cleanup: (() => void) | null = null;

  function attachObserver(element: Element) {
    const observer = new MutationObserver((mutations) => {
      const newElements: Element[] = [];
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          if (el.matches(opts.messageSelector)) {
            newElements.push(el);
          }
          const descendants = el.querySelectorAll(opts.messageSelector);
          for (const desc of descendants) {
            newElements.push(desc);
          }
        }
      }
      if (newElements.length) {
        opts.onNewElements(newElements);
      }
    });
    observer.observe(element, {
      childList: true,
      subtree: opts.subtree ?? true,
    });
    cleanup = () => observer.disconnect();
  }

  const root = target.querySelector(opts.rootSelector);
  if (!root) {
    // Root not found yet — watch for it to appear, then attach.
    const bodyObserver = new MutationObserver((_mutations, observer) => {
      const found = target.querySelector(opts.rootSelector);
      if (found) {
        observer.disconnect();
        attachObserver(found);
      }
    });
    bodyObserver.observe(target.body || target.documentElement, {
      childList: true,
      subtree: true,
    });
    // Cleanup handles BOTH the body-observer-only case (attachObserver
    // never fired) AND the case where attachObserver ran later and set
    // `cleanup` to its observer's disconnect.
    return () => { bodyObserver.disconnect(); cleanup?.(); };
  }

  attachObserver(root);
  return () => cleanup?.();
}
