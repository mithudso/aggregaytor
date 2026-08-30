# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** via GitHub Security
Advisories on this repository:

https://github.com/mithudso/aggregaytor/security/advisories/new

Do **not** open a public issue for security problems. This extension handles
private message data and stored credentials/auth tokens for connected
platforms, so responsible disclosure matters.

What to include:

- A description of the vulnerability and its impact.
- Reproduction steps or a proof of concept.
- The extension version (`extensions/aggregaytor/manifest.json`) and browser version.

## Scope notes

Areas of particular interest:

- MAIN-world / ISOLATED-world boundary leaks (anything newly readable by host pages via `window.*`).
- Message-dispatch handlers in `extensions/aggregaytor/background/service-worker.ts` reachable from content scripts.
- Storage of auth material and LLM provider keys.
- Content Security Policy or permission escalations in `manifest.json`.
