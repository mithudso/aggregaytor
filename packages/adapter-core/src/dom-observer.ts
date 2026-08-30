/**
 * dom-observer.ts — DOM-based message extraction using MutationObserver.
 *
 * For server-rendered sites (DoubleList, Adam4Adam) where DOM is the
 * primary data source rather than API interception.
 */

import type { DOMExtractorOptions } from './types.js';

/**
 * Watch a container for newly-inserted message elements.
 *
 * If `opts.rootSelector` does not match yet (common on SPAs that render the
 * chat pane lazily), a temporary observer on `<body>` waits for it to appear
 * and then attaches the real observer.
 *
 * @param target - The document to observe.
 * @param opts   - Selectors and the new-element callback.
 * @returns A cleanup function that disconnects every observer this created.
 */
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

  /**
   * Attach the real message-watching MutationObserver to `element` and store
   * its disconnect in `cleanup`. Disconnects any previously-attached observer
   * first so a late second attach never orphans the first.
   *
   * @param element - The resolved root container to observe for message nodes.
   */
  function attachObserver(element: Element) {
    // Defensive: never orphan a previously-attached observer by overwriting
    // `cleanup` with a second one.
    cleanup?.();
    const observer = new MutationObserver((mutations) => {
      // A Set, not an array: within one mutation batch an added node can match
      // `messageSelector` itself *and* be a descendant of another added node,
      // and the same element can be reported by more than one mutation record.
      // Emitting it twice makes downstream extraction parse it twice.
      const newElements = new Set<Element>();
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          if (el.matches(opts.messageSelector)) {
            newElements.add(el);
          }
          const descendants = el.querySelectorAll(opts.messageSelector);
          for (const desc of descendants) {
            newElements.add(desc);
          }
        }
      }
      if (newElements.size) {
        opts.onNewElements([...newElements]);
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
    // At document-start there may be neither <body> nor <html> yet; observing
    // `null` throws, which would take down the adapter's whole init().
    const bodyTarget = target.body || target.documentElement;
    if (!bodyTarget) return () => {};
    bodyObserver.observe(bodyTarget, {
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
