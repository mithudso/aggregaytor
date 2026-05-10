# Accessibility and UX reviewer context

## How to use this context

Use this file as a **practical accessibility and usability review reference** when auditing UI structure, interaction patterns, keyboard behavior, form labeling, focus management, landmarks, ARIA usage, or responsive readability. Treat **W3C WAI / WCAG / APG** as the main source for normative guidance and established widget patterns, and use **MDN** plus **web.dev** for practical implementation guidance and review heuristics ([W3C WAI](https://www.w3.org/WAI/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [WAI APG](https://www.w3.org/WAI/ARIA/apg/), [MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility), [web.dev accessibility](https://web.dev/learn/accessibility)).

**Version note:** this file uses the current official docs as accessed on **2026-05-10** and treats **WCAG 2.2** as the preferred current WCAG version because W3C explicitly encourages use of the most current version of WCAG when developing or updating accessibility policy and practice ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).

## Source scope

- **Standards and ecosystem guidance:** W3C WAI home and WCAG 2.2 ([W3C WAI](https://www.w3.org/WAI/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- **Pattern and widget behavior:** WAI ARIA Authoring Practices Guide plus specific APG practices for keyboard interfaces, accessible names/descriptions, and landmark regions ([WAI APG](https://www.w3.org/WAI/ARIA/apg/), [APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/), [APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/), [APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)).
- **Practical implementation guidance:** MDN accessibility overview plus MDN’s semantic HTML and CSS/JS accessibility practices ([MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility), [MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML), [MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).
- **Practical learning/reference support:** web.dev accessibility course ([web.dev accessibility](https://web.dev/learn/accessibility)).

## Quick review rules

1. Prefer **semantic HTML first**; MDN explicitly presents semantic HTML as a primary basis for accessibility and usability ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
2. Every interactive UI should be **operable by keyboard**; the APG keyboard guide states that all interactive elements on a web page must be operable via the keyboard ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
3. Keep **focus visible, predictable, and meaningful**; APG explicitly calls out visible focus and predictable focus movement as core keyboard-interface responsibilities ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
4. Ensure interactive elements have **accessible names**; APG states that all focusable interactive elements are required to have an accessible name ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).
5. Use **landmarks and sectioning** so assistive-technology users can understand page structure and navigate important regions ([APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)).
6. Use **ARIA to add semantics when needed**, not to replace correct semantic HTML unnecessarily; MDN frames semantic HTML as the default foundation and ARIA as help for more complex controls ([MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility), [MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
7. Preserve **expected appearance and behavior**; MDN warns that styling elements to look or behave unlike their semantic role causes confusion and usability problems, especially for disabled users ([MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).
8. Treat accessibility as also improving **general usability**; WCAG explicitly notes that following its guidance often makes content more usable for users in general ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).

## Accessibility review workflow

1. **Check semantic structure first.** Review headings, landmarks, lists, buttons, links, and form controls before looking at ARIA or scripts ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML), [APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)).
2. **Check names and labels.** Verify that interactive elements, dialogs, regions, and relevant containers have accessible names/descriptions where required or beneficial ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).
3. **Check keyboard behavior and focus.** Review tab order, visible focus, internal widget navigation, and focus movement between components ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
4. **Check form behavior and status communication.** Review labels, expectations, instructions, and whether dynamic UI changes are exposed through appropriate semantics and patterns from the standards/guides ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/), [MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility)).
5. **Check responsive readability and layout behavior.** Review text legibility, spacing, and whether content still behaves meaningfully when zoomed or restyled ([WCAG 2.2](https://www.w3.org/TR/WCAG22/), [MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).
6. **Only then evaluate ARIA-heavy components.** Use APG widget patterns and keyboard conventions to review custom composites and dialogs ([WAI APG](https://www.w3.org/WAI/ARIA/apg/), [APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

## What accessibility and UX are optimizing for

- WAI describes its mission as helping make the web accessible and usable for people with disabilities through standards and support materials ([W3C WAI](https://www.w3.org/WAI/)).
- WCAG 2.2 states that conforming to its recommendations makes content accessible to a wider range of people with disabilities and often also improves usability for users in general ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- MDN frames accessibility work as part of regular web development workflow, including tooling, semantics, CSS, JavaScript, and assistive-technology expectations ([MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility)).

## Semantic structure, labels, landmarks, and headings

### Semantic HTML as the foundation

- MDN explicitly says semantic HTML is one of the main places accessibility is broken when ignored, and that correct elements should be used for their intended purpose whenever possible ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- Semantic HTML also brings non-accessibility benefits called out by MDN, including easier development, better mobile/responsive behavior, and SEO advantages ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).

### Landmarks and structure

- APG landmark guidance says landmark roles help represent page organization programmatically and support keyboard navigation to important sections ([APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)).
- APG identifies HTML sectioning elements such as `main`, `nav`, `aside`, and top-level `header`/`footer` contexts as implied landmark roles, and notes that a `section` can become a `region` when it has an accessible name ([APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)).
- Including all perceivable content in meaningful landmark regions is described as one of the most effective ways to prevent assistive-technology users from overlooking relevant information ([APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)).

### Names and labels

- Accessible names are one of the most important author responsibilities for accessible experiences, and technical mistakes in naming can completely block assistive-technology users ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).
- APG explicitly lists naming techniques such as visible child content, `aria-label`, `aria-labelledby`, HTML `<label>`, `<legend>`, and captions for tables/figures ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).
- Accessible names primarily convey purpose/intent and distinguish one element from others on the page ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).

## Keyboard support, focus management, and interaction patterns

- APG explains that browsers do not automatically provide keyboard support for custom GUI components built with ARIA, so authors must implement keyboard behavior in code ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
- The keyboard-interface guidance explicitly covers visible focus, predictable focus movement, movement between components, movement inside composite widgets, and keyboard shortcut assignment concerns ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
- Consistent keyboard conventions are framed as essential to efficient and enjoyable keyboard use across the web ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

## Forms, instructions, and status communication

- APG explicitly covers naming form controls with `<label>` and naming fieldsets with `<legend>`, making those the default review targets for form labeling ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).
- MDN’s accessibility materials frame tooling, assistive technology, and semantic HTML as part of the baseline workflow, which means forms should be reviewed as interaction and comprehension surfaces, not just data-entry widgets ([MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility), [MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- When status or dynamic changes are part of a widget or interaction, the review should check whether the chosen APG pattern exposes the change through the intended semantics, names, descriptions, and focus behavior rather than only through visual styling ([WAI APG](https://www.w3.org/WAI/ARIA/apg/), [APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).

## ARIA usage and custom widget discipline

- APG is specifically about applying ARIA semantics to common design patterns and widgets and pairing those semantics with keyboard support ([WAI APG](https://www.w3.org/WAI/ARIA/apg/)).
- MDN’s accessibility guidance presents ARIA as useful for complex UI controls and dynamic content, while still anchoring accessibility in semantic HTML first ([MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility), [MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- The practical review rule is: if native HTML covers the use case, prefer it; if a custom widget is necessary, review it against APG patterns for role/state/property usage and keyboard behavior ([WAI APG](https://www.w3.org/WAI/ARIA/apg/), [APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

## Contrast, zoom/reflow, readability, and responsive behavior

- WCAG 2.2 is device-agnostic and covers a wide range of recommendations for making content accessible across desktops, laptops, kiosks, and mobile devices ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- MDN’s CSS/JS accessibility guidance explicitly says authors should choose sensible font sizes, line heights, and related text styling so content is logical, legible, and comfortable to read ([MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).
- web.dev presents accessibility as an evergreen learning and implementation area, reinforcing that accessible UX is not a one-off checklist but an ongoing quality discipline ([web.dev accessibility](https://web.dev/learn/accessibility)).

## Common accessibility failure modes and remediation patterns

- Using non-semantic containers where native elements exist (for example, styling a `div` like a button) is a classic failure mode called out by MDN; the direct remediation is to use the correct native element ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- Styling elements so they no longer look or behave as users expect is another failure mode; MDN warns that this creates confusion and usability issues for everyone, especially disabled users ([MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).
- Missing accessible names or incorrect accessible descriptions are high-severity failures because APG explicitly says they can completely block assistive-technology users ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).
- Custom widgets without complete keyboard behavior are a standard failure mode because browsers do not supply that behavior automatically for ARIA widgets ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

## Attributes, roles, patterns, checks, and APIs inventory

This is a **condensed accessibility-review inventory**, not an exhaustive restatement of WCAG or the full APG pattern set.

| Item | Purpose | Key attributes / requirements | Expected behavior | Typical usage | Caveats / misuse risks |
|---|---|---|---|---|---|
| Semantic HTML element choice | Convey structure and behavior through native semantics ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)) | Use the correct element for the intended job | Built-in semantics and expected interaction | Buttons, headings, lists, links, forms | Replacing native semantics with generic containers causes usability and accessibility regressions |
| `<button>` | Native interactive control with built-in keyboard behavior ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)) | Use real button markup | Tabbable and activatable with keyboard | Actions and commands | Styling a non-button to imitate a button loses built-in behavior |
| Landmark roles / sectioning elements | Expose page structure programmatically ([APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)) | Meaningful landmark assignment and top-level structure | Assistive tech can navigate important page regions | `main`, `nav`, `aside`, `header`, `footer`, named `section` | Landmarks without meaningful structure add noise |
| Accessible name | Give elements a short label for AT users ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)) | Required for all focusable interactive elements | Conveys purpose and distinguishes controls | Buttons, inputs, dialogs, regions | Missing or misleading names can block use |
| `aria-label` | Name an element with a string attribute ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)) | Explicit string label | AT exposes a direct name | Icon-only controls or no visible label cases | Easy to drift out of sync with visible UI |
| `aria-labelledby` | Name an element by referencing existing content ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)) | Reference ID(s) to naming content | Name derives from visible text/content | Dialogs, regions, complex controls | Broken IDs or weak source text break naming |
| `aria-describedby` | Attach additional descriptive content ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)) | Reference ID(s) to descriptive content | Adds supplemental explanation | Help text, instructions, warnings | Description should support, not replace, a proper name |
| `<label>` | Name form controls natively ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)) | Explicit association to control | Form field has a usable label | Inputs and form controls | Placeholder text is only a fallback naming source, not a preferred label mechanism |
| `<legend>` | Name a fieldset/group ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)) | Grouped controls inside fieldset | Group purpose is communicated | Related form controls | Missing group naming harms comprehension |
| Visible focus | Show current keyboard focus position ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)) | Focus styling and logical movement | Keyboard user can track position | All interactive UI | Invisible or erratic focus is a major usability failure |
| Keyboard navigation conventions | Provide consistent keyboard operation ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)) | Tab / Shift+Tab between components, internal widget navigation | Efficient keyboard use | Menus, listboxes, grids, dialogs, toolbars | Authors must implement this for custom ARIA widgets |
| APG widget pattern | Standardize ARIA semantics plus keyboard support ([WAI APG](https://www.w3.org/WAI/ARIA/apg/)) | Pattern-specific roles, states, and keys | Predictable accessible custom widget behavior | Dialogs, menus, accordions, tabs, grids | Partial pattern implementation is risky and confusing |

## Accessibility and UX review standards / best practices

### Semantic HTML

- Prefer native HTML semantics over generic containers whenever possible ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- Preserve meaning and expected behavior even when restyling elements ([MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).

### Keyboard access

- Ensure all interactive elements are operable by keyboard ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
- Follow common keyboard conventions so learning transfers across widgets and pages ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

### Focus visibility and order

- Keep focus visible and movement predictable ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
- Review both focus movement **between** components and **inside** composite widgets ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

### Form usability and error handling

- Use `<label>` and `<legend>` patterns for form naming before reaching for custom ARIA naming ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).
- Review forms as comprehension flows, not only as data-entry surfaces ([MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility)).

### ARIA usage discipline

- Use ARIA patterns to add semantics for complex controls, not to paper over avoidable semantic HTML problems ([WAI APG](https://www.w3.org/WAI/ARIA/apg/), [MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- When ARIA is used, review names, descriptions, focus, and keyboard support together rather than in isolation ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/), [APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

### Content structure and readability

- Use proper headings, paragraphs, and lists so structure is both visible and navigable ([MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript), [MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- Choose sensible typography and spacing for legibility and comfort ([MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).

### Responsive / zoom behavior

- Review content across device contexts and scalable layouts because WCAG 2.2 explicitly addresses web content accessibility across device types ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- Treat readability and layout robustness as accessibility concerns, not just visual polish ([WCAG 2.2](https://www.w3.org/TR/WCAG22/), [MDN CSS and JS accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript)).

### Common widget patterns

- Use APG design patterns for common custom widgets and interactions ([WAI APG](https://www.w3.org/WAI/ARIA/apg/)).
- Review dialogs, menus, grids, listboxes, radio groups, and similar components against APG keyboard and naming expectations ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/), [APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)).

## Practical defaults for future UI review and triage tasks

- Start by asking: **Can this be native HTML instead of a custom widget?** ([MDN HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML)).
- Then ask: **Can a keyboard-only user complete the flow with visible, predictable focus?** ([APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).
- Then ask: **Does every meaningful interactive or structural region have the right name, landmark, or description?** ([APG names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/), [APG landmark regions](https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/)).

## Known ambiguities / standards notes

- WCAG 2.2 is the current recommended WCAG version, but WAI also shows active work on WCAG 3 drafts; that future work does **not** replace WCAG 2.2 for present-day review baselines ([W3C WAI](https://www.w3.org/WAI/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- APG is a pattern and authoring-practice guide, not a replacement for semantic HTML or WCAG conformance requirements ([WAI APG](https://www.w3.org/WAI/ARIA/apg/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- This file is intentionally condensed. For exhaustive pattern details and criterion-by-criterion evaluation, follow the citations back to APG practices and WCAG materials ([WAI APG](https://www.w3.org/WAI/ARIA/apg/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
