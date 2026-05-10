# Security reviewer context

## How to use this context

Use this file as a **practical security review reference** when auditing code, reviewing architecture, assessing extension permissions, or triaging privacy and security risks. Treat **OWASP** as the main source for security-review framing and verification standards, **MDN** as the source for browser/web-platform security behavior, and **Chrome extension security/privacy docs** as the source for extension-specific practices and permission guidance ([OWASP Top 10](https://owasp.org/www-project-top-ten/), [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/), [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/), [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP), [Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure), [Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).

**Version note:** this file uses the current official docs as accessed on **2026-05-10**, including **OWASP Top 10 2025** as the most current released Top 10 version ([OWASP Top 10](https://owasp.org/www-project-top-ten/)).

## Source scope

- **Risk framing:** OWASP Top 10 is a broad awareness document for the most critical web application risks ([OWASP Top 10](https://owasp.org/www-project-top-ten/)).
- **Detailed secure-development guidance:** OWASP Cheat Sheet Series provides concise guidance on specific security topics ([OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)).
- **Verification structure:** OWASP ASVS provides a basis for testing technical security controls and a list of secure-development requirements ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)).
- **Web-platform behavior:** MDN covers browser security boundaries, security/privacy distinctions, same-origin policy, CORS, and CSP behavior ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
- **Extension-specific practice:** Chrome’s extension security/privacy docs cover least privilege, permission minimization, HTTPS-only transport, and user-data/privacy expectations ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure), [Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).

## Quick review rules

1. Start with **least privilege**: only grant the permissions, access, and data collection needed right now, not “future” capabilities ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy), [Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
2. Treat **security and privacy as distinct but linked**: good privacy depends on good security, and user-data handling must be reviewed from both angles ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).
3. Prefer **HTTPS**, not HTTP, for data transmission; Chrome’s extension guidance explicitly says to avoid HTTP and prefer HTTPS because of man-in-the-middle risk reduction ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
4. Review **browser boundaries** first: same-origin policy, CORS, and CSP often determine whether a risky pattern is actually exposed or partially contained ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
5. Use **ASVS-style control verification** and **OWASP Top 10 risk framing** together: one helps structure verification, the other helps prioritize common web-app risk classes ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/), [OWASP Top 10](https://owasp.org/www-project-top-ten/)).
6. Treat **CSP as a real control**, not a checkbox; MDN explicitly frames CSP as a mechanism to control resource loading and defend against XSS ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
7. In extensions, prefer **temporary or narrower permissions** such as `activeTab` over broad host access when the narrower permission fits the use case ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).
8. Minimize what an attacker could exploit if compromise occurs by reducing permissions, member roles, and exposed capabilities ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).

## Security review workflow

1. **Identify the trust boundary.** Determine whether the code crosses origin boundaries, privilege boundaries, extension boundaries, or user-data boundaries ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
2. **Classify the risk.** Use OWASP Top 10 as a first-pass awareness framework for the likely class of issue ([OWASP Top 10](https://owasp.org/www-project-top-ten/)).
3. **Verify the control.** Use ASVS thinking: what technical control should exist here, and can it be tested or verified? ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)).
4. **Check the platform behavior.** Confirm how the browser/runtime actually constrains or exposes the pattern, including SOP, CORS, and CSP behavior ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
5. **Check least privilege and privacy.** Review requested permissions, collected data, and whether the design asks for more access than it needs ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).
6. **Check secure defaults.** Determine whether the safer path is the default or whether correct behavior depends on a fragile opt-in ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/), [Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).

## Common risk classes and control areas

### Risk framing

- OWASP Top 10 is positioned as a **standard awareness document** and a broad consensus view of the most critical web application security risks ([OWASP Top 10](https://owasp.org/www-project-top-ten/)).
- OWASP ASVS is positioned as a **basis for testing technical security controls** and as a set of requirements for secure development ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)).

### Security vs privacy

- MDN explicitly distinguishes **security** from **privacy**: security protects systems and data against unauthorized access, while privacy is about user control over how data is collected, stored, and used ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).
- Good security is required for meaningful privacy because data can still be stolen if the system is insecure ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).

### Browser/platform boundaries

- The **same-origin policy** is a foundational security mechanism restricting how documents or scripts from one origin interact with resources from another origin ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).
- CORS is part of the controlled relaxation of that model and must therefore be reviewed as an explicit trust decision, not a default convenience ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).

### CSP and resource loading

- CSP should be delivered via the **`Content-Security-Policy`** response header and should be set on all responses to all requests, not only the main document ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
- CSP can also be expressed via `<meta http-equiv>`, but MDN notes that this option does **not support all CSP features** ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
- CSP is primarily used to control resource loading and protect against **cross-site scripting (XSS)** ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).

### Extension permissions and privacy

- Chrome’s privacy guidance says users are less likely to install extensions that ask for excessive permissions and that permission requests should be limited to what is critical for implementation ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).
- Chrome’s security guidance says extensions should list only the APIs and sites they depend on, because reducing privileges reduces what an attacker can exploit ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
- Chrome explicitly recommends considering **less invasive permission options**, and the privacy doc highlights **`activeTab`** as a temporary alternative for many uses of broad host permissions like `<all_urls>` ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).

## Controls, APIs, patterns, and review checks inventory

This is a **condensed security-review inventory**, not an exhaustive restatement of OWASP, MDN, or Chrome documentation.

| Control / pattern | Purpose | Key configuration points | Mitigates | Common review pattern | Caveats / failure modes |
|---|---|---|---|---|---|
| OWASP Top 10 | Risk-awareness framework for major web-app security classes ([OWASP Top 10](https://owasp.org/www-project-top-ten/)) | current release/version | Helps classify likely high-risk issue areas | Use early in review to frame threat category | Awareness framework, not a complete verification checklist |
| OWASP ASVS | Verification basis for technical security controls ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)) | control requirements and rigor level | Gaps in implemented controls | Use to turn concerns into verifiable control checks | Needs project-specific application, not copy-paste compliance theater |
| OWASP Cheat Sheet Series | Topic-specific secure-development guidance ([OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)) | choose the relevant cheat sheet topic | Common secure-coding and review gaps | Use when a risk class needs practical implementation guidance | Broad collection; pick relevant topics instead of treating it as one flat standard |
| Same-origin policy | Restrict cross-origin interaction by default ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)) | origin boundaries | Unauthorized cross-origin access | Check whether a feature depends on relaxing origin isolation | Misunderstanding origin boundaries can create false confidence |
| CORS | Controlled cross-origin access mechanism ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)) | origin allowances and access policy | Some cross-origin misuse and accidental exposure | Review every relaxed cross-origin path as an explicit trust grant | Easy to over-open if treated as convenience config |
| `Content-Security-Policy` header | Enforce browser resource-loading restrictions ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)) | directives such as `default-src`, `img-src`, etc. | XSS and risky resource-loading patterns | Check whether CSP exists and whether directives are meaningfully restrictive | Meta-delivered CSP supports fewer features than header-based CSP |
| `default-src` | Baseline resource policy in CSP ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)) | allowed sources | Overbroad default resource loading | Review whether the fallback is restrictive enough | Specific directives can override it |
| `img-src` and similar directives | Resource-type-specific CSP control ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)) | allowed sources by type | Overbroad loading for specific resource classes | Review type-by-type exposure, not only global default | Incomplete directive coverage can leave unintended gaps |
| HTTPS-only transport | Protect data in transit with built-in transport security ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)) | use HTTPS instead of HTTP | Man-in-the-middle and tampering risk | Flag any HTTP request or transport dependency | HTTP should be assumed interceptable or modifiable |
| Manifest `permissions` minimization | Limit extension privilege surface ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure), [Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)) | only required APIs/sites | Excess privilege and data interception paths | Compare requested permissions to actual features | “Future-proofing” permission requests is explicitly discouraged |
| `activeTab` | Temporary tab-scoped access alternative for some host-permission use cases ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)) | invoked by user, ends on tab exit/navigation | Broad persistent host access | Prefer it when the extension only needs temporary active-tab access | Not a universal replacement for all host-permission needs |
| Data minimization / privacy review | Limit collected/transmitted user data and justify it clearly ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)) | what data is collected, shared, stored, deleted | Privacy abuse and unnecessary exposure | Review whether every collected field is necessary | Privacy claims are meaningless if security controls are weak |
| Developer-account protection | Protect extension publishing accounts ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)) | 2FA/security-key use and proper member roles | Malicious extension takeover via account compromise | Review release/admin process security, not just app code | Secure code is insufficient if the publishing account is weak |

## Security review standards and best practices

### Least privilege

- Ask for only the APIs and sites the feature actually depends on ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
- Do not request permissions “for the future”; Chrome’s privacy guidance explicitly warns against future-proofing permission requests ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).

### Secrets handling

- Treat privileged accounts and privileged channels as part of the security boundary; Chrome explicitly calls out developer-account protection as critical because compromise can push malicious code to all users ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
- ASVS frames technical controls as verifiable requirements, so secret-handling review should be tied to explicit controls rather than informal assumptions ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)).

### Data minimization and privacy

- Review what data is collected, who it is shared with, how it is used, and whether users have control over it, because MDN explicitly includes these in the privacy definition ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).
- Extension data collection and transmission must be justified by real functionality and limited to critical information ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).

### Validation and sanitization

- Use OWASP risk framing and cheat-sheet guidance to treat validation and sanitization as control questions, not just style questions ([OWASP Top 10](https://owasp.org/www-project-top-ten/), [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)).
- Review any user-controlled input path together with the rendering/consumption context and applicable browser controls like CSP ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP), [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).

### Output encoding

- Review rendered output paths in the context of XSS risk and CSP coverage, because CSP is explicitly documented as an XSS-mitigation control for resource-loading policy ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).

### Authentication and session handling

- Use ASVS as the basis for verifying authentication/session controls rather than treating them as implicit or “handled elsewhere” ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)).
- Review any path that crosses identity, privilege, or user-data boundaries as a security-control path, not just a business-logic path ([OWASP Top 10](https://owasp.org/www-project-top-ten/), [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)).

### Dependency and supply-chain awareness

- Chrome’s guidance on protecting developer accounts and using correct member roles is a concrete supply-chain and release-path control for extensions ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
- Security review should include who can ship or update code, not only what the code currently does ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).

### Extension-specific security and privacy practices

- Prefer narrower or temporary permissions where possible, including `activeTab` in place of broad host permissions when it fits the use case ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)).
- Restrict cross-origin fetching to domains explicitly permitted by the manifest and review those permissions as part of the attack surface ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
- Remember that extensions are attractive attack targets specifically because they have browser privileges ([Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).

## Practical defaults for future code review and triage tasks

- Start by asking: **what is the privilege boundary, what data is at risk, and what control should exist here?** ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/), [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)).
- When reviewing web code, check **SOP/CORS/CSP** before assuming a path is safe or unsafe ([MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
- When reviewing extension code, check **manifest permissions, host access, and data handling** before digging into implementation details ([Chrome user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy), [Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).

## Known ambiguities / scope notes

- OWASP Top 10 is an **awareness document**, not a complete or exhaustive test procedure ([OWASP Top 10](https://owasp.org/www-project-top-ten/)).
- ASVS is a **verification standard**, but it still needs project-specific interpretation and control mapping ([OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)).
- CSP can be delivered via headers or `<meta http-equiv>`, but MDN explicitly notes that meta-based CSP does not support all features ([MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)).
- This file is intentionally condensed. For topic-specific implementation depth, follow the relevant OWASP Cheat Sheet from the series and the linked MDN/Chrome docs ([OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/), [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security), [Chrome stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)).
