# HTML, HTML5, and CSS expert context

## How to use this context

Use this file as a **practical HTML/CSS reference and behavior guide** when generating or reviewing markup and styles. Treat **MDN HTML/CSS docs** as the primary practical reference, and use the **WHATWG HTML Living Standard** and **CSSWG drafts** as canonical spec-level sources for definitions and version-sensitive edge cases ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [WHATWG HTML Living Standard](https://html.spec.whatwg.org/multipage/), [CSSWG drafts index](https://drafts.csswg.org/)).

## Source scope

- **HTML practical reference:** MDN HTML overview, MDN element reference, and MDN structuring-content learning docs ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).
- **HTML canonical spec source:** WHATWG **HTML Living Standard**, last updated **10 May 2026** on the cited index page ([WHATWG HTML Living Standard](https://html.spec.whatwg.org/multipage/)).
- **CSS practical reference:** MDN CSS overview, MDN styling basics, MDN specificity docs, and MDN layout docs ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics), [MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- **CSS canonical spec source:** CSSWG drafts index for current module-level specification status and current-work notes ([CSSWG drafts index](https://drafts.csswg.org/)).
- These sources describe **platform behavior and recommended usage**, but they are **not a project-specific formatter or naming style guide**. Where they do not prescribe naming or file layout rules, defer to project-local conventions ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).

## Quick rules

1. Prefer **semantic HTML elements** over generic containers when the content has real structure or meaning, such as `header`, `nav`, `main`, `article`, `section`, `aside`, and `footer` ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
2. Keep the document structure explicit: use one `html` root, one `head`, one `body`, and machine-readable metadata in the head ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).
3. Use HTML for **structure and meaning**, and CSS for **presentation** ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).
4. Default to **lowercase tags** and conventional lowercase markup syntax; MDN explicitly calls lowercase the convention and recommended practice ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML)).
5. In CSS, keep selector weight low and intentional; specificity is an algorithm, not a vague rule of thumb ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
6. Choose layout tools by job: **normal flow** first, **flexbox** for one-dimensional layout, **grid** for two-dimensional layout, and **float** mainly for its original text-wrapping purpose ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
7. Build responsive layouts with modern layout tools and responsive design techniques rather than fixed assumptions about viewport size ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
8. Use selectors to express intent, not to fight the cascade; combinators do not add specificity weight, while IDs, classes/attributes/pseudo-classes, and types/pseudo-elements do ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
9. Keep metadata, styles, and linked resources in the head when they are document-wide concerns ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).
10. Treat CSSWG and WHATWG docs as canonical for behavior, but use MDN first for authoring guidance and quicker implementation decisions ([WHATWG HTML Living Standard](https://html.spec.whatwg.org/multipage/), [CSSWG drafts index](https://drafts.csswg.org/), [MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).

## HTML reference

### What HTML is for

- HTML defines the **meaning and structure** of web content, while CSS is generally used for appearance/presentation and JavaScript for behavior/functionality ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML)).
- HTML uses elements and tags to annotate content for browser interpretation, including sectioning, text, media, embedded content, lists, and interactive controls ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).

### Core document structure

- `html` is the root element; all other elements must descend from it ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- `head` contains machine-readable metadata such as title, scripts, and style sheets ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).
- `body` contains the displayed document content, and there can be only one `body` element in a document ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- The head is not displayed as page content; it is where document metadata, CSS links, favicons, and descriptive metadata live ([MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).

### Semantics and sectioning

- Sectioning elements exist to organize content into logical pieces and create broad page outlines ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- Headings and paragraphs provide foundational text structure, and semantics matter beyond mere visual formatting ([MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).
- Use meaningful elements such as `header`, `footer`, `article`, `section`, `nav`, `aside`, lists, and media elements instead of overusing `div`/`span` where a semantic choice exists ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).

### Metadata, links, and embedded resources

- `base` sets the base URL for relative URLs and only one is allowed per document ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- `link` is most commonly used to link CSS, but also defines relationships to other resources such as icons ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- `meta` represents metadata not covered by other specialized metadata elements ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- `style` embeds CSS for a document or part of a document, while linked stylesheets keep presentation externalized ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).

## CSS reference

### What CSS is for

- CSS is used to create the visual presentation of web pages, including syntax, selectors, text styling, and layout systems ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics)).
- MDN’s CSS guides cover syntax, specificity, inheritance, cascade, nesting, scoping, media/container queries, values and units, box model, display/layout systems, and animations ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).

### Cascade, inheritance, and specificity

- Specificity is an algorithm that determines which matching declaration wins when competing declarations target the same element ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
- Specificity is calculated as a three-column value: **ID - CLASS - TYPE** ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
- ID selectors add `1-0-0`, class/attribute selectors and pseudo-classes add `0-1-0`, and type selectors/pseudo-elements add `0-0-1` ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
- The universal selector `*`, `:where()`, and combinators do **not** add specificity weight, even though they still participate in matching ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).

### Box model and layout

- CSS guides explicitly cover the **box model**, containing blocks, stacking contexts, block formatting contexts, flexbox, multicolumn layout, and grid layout ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).
- Normal flow is the baseline layout model and should be understood before using positioning or alternate layout systems ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- **Flexbox** is a **one-dimensional** layout method for rows or columns ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- **Grid** is a **two-dimensional** layout system that organizes content into rows and columns ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- **Float** was widely used historically for multi-column layouts, but modern layout work should generally prefer flexbox and grid; float has largely returned to its original purpose of wrapping text around content ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- **Positioning** can take elements out of normal flow and place them relative to the document, containers, or viewport ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).

### Responsive design and modern CSS

- MDN CSS layout guidance explicitly includes building responsive designs that adapt to different devices, screen sizes, and resolutions ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- MDN CSS guides explicitly reference media queries, container queries, nesting, scoping, and animation-related topics as part of modern CSS authoring ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).
- CSSWG drafts are the canonical source for current module-level specification work and should be consulted when a feature is new, evolving, or version-sensitive ([CSSWG drafts index](https://drafts.csswg.org/)).

## Elements, properties, selectors, and at-rules inventory

This is a **high-value condensed inventory**, not an exhaustive dump of every HTML element or CSS property. For exhaustive coverage, use the linked MDN element reference and CSS docs directly.

### HTML elements

| Item | Purpose | Key attributes/values | Typical usage | Caveats |
|---|---|---|---|---|
| `html` | Root element for the whole document ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | global attributes | Wrap the entire document | All other elements must descend from it |
| `head` | Machine-readable metadata container ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | metadata children like `title`, `meta`, `link`, `style`, `script` | Define title, metadata, styles, linked resources | Not displayed as body content |
| `body` | Visible document content container ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | global attributes | Wrap page content | Only one per document |
| `title` | Document title shown in tab/title bar ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | text only | Name the page | HTML tags inside are treated as plain text |
| `meta` | Metadata not covered by specialized metadata elements ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | name/content/charset/http-equiv patterns depending use | Encoding, viewport, descriptive metadata | Use the correct metadata form for the need |
| `link` | Link current document to external resources, commonly CSS ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | `rel`, `href`, related metadata | Stylesheets, icons, resource relationships | Relationship semantics depend on `rel` |
| `style` | Embed CSS in the document ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | CSS text | Document-local style rules | Prefer linked stylesheets for reusable/document-wide styling when appropriate |
| `header`, `footer`, `nav`, `article`, `section`, `aside` | Semantic sectioning/structural elements ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)) | global attributes | Structure page regions and meaningful sections | Use based on meaning, not visual appearance alone |
| `p`, headings, lists | Text and document-structure primitives ([MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)) | global attributes | Headings, paragraphs, ordered/unordered lists | Preserve semantics rather than using generic containers for text structure |
| `img`, `audio`, `video`, `canvas`, `embed` | Media and embedded content ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML)) | element-specific media attributes | Images, sound, video, drawing surfaces, embeds | Pick the element that matches the content type and behavior |
| `details`, `datalist`, `output`, `progress` | Built-in interactive/status elements ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML)) | element-specific behavior | Disclosure widgets, suggestions, computed output, progress indication | Use built-ins when they match the interaction model |

### CSS selectors and concepts

| Item | Purpose | Key values/parameters | Typical usage | Caveats |
|---|---|---|---|---|
| Type selector | Match by element name ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics)) | element name like `p` | Apply rules by semantic element | Adds type-column specificity |
| Class selector | Match elements by class ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics)) | `.className` | Reusable styling hooks | Adds class-column specificity |
| ID selector | Match a unique id ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics)) | `#id` | High-priority targeted matching | Adds strongest standard selector weight here |
| Attribute selector | Match by attribute presence/value ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics)) | `[attr]`, `[attr=value]`, etc. | Style by state/metadata | Adds class-column specificity |
| Pseudo-class | Match element states/structural conditions ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics)) | `:hover`, `:required`, etc. | Interactive/stateful styling | Adds class-column specificity |
| Pseudo-element | Style generated/partial element fragments ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics)) | `::before`, `::placeholder`, etc. | Fragments or generated content styling | Adds type-column specificity |
| Combinators | Express structural relationships between selectors ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)) | descendant, child, sibling, column combinators | Scope selectors to relationships | Do not add specificity weight |
| Universal selector / `:where()` | Broad matching helpers ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)) | `*`, `:where(...)` | Low-specificity matching | Contribute zero specificity weight |

### CSS layout and styling features

| Item | Purpose | Key values/parameters | Typical usage | Caveats |
|---|---|---|---|---|
| `display` | Controls layout participation and formatting context ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)) | normal flow and alternate display values | Choose layout behavior | Understand normal flow first |
| `float` | Float content, especially for text wrap ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)) | float values | Wrap images/content in text | Not the preferred modern primary layout system |
| `position` | Offset elements relative to normal flow/container/viewport ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)) | static/relative/absolute/fixed/sticky and offsets | Overlays, anchored UI, viewport-fixed elements | Takes elements out of normal flow in several modes |
| Flexbox | One-dimensional layout system ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)) | row/column-oriented flex properties | Toolbars, rows, columns, component internals | One-dimensional by design |
| Grid | Two-dimensional layout system ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)) | row/column track-based properties | Page and component grids | Best when both axes matter |
| Media queries | Adapt styles to device/viewport characteristics ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)) | media features/conditions | Responsive design | Keep conditions intentional and maintainable |
| Container queries | Adapt styles to container conditions ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)) | containment/query conditions | Component-level responsiveness | More local than viewport-based strategies |
| Animations / transitions / transforms | Motion and visual state changes ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)) | animation, transition, transform properties | Interactive polish and state transitions | Use intentionally; avoid adding motion without purpose |

## Coding standards and best practices from the docs

### Semantic HTML usage

- Use elements for their **meaning**, not just for their default appearance ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).
- Prefer sectioning and text-structure elements over generic wrappers when semantics exist ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).

### Accessibility-minded markup

- Favor semantic elements because they carry useful meaning for browsers and other software that use and render the page ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- Use headings, paragraphs, lists, and structural sections to express the page’s actual content hierarchy rather than only visual groupings ([MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).

### Document structure

- Keep metadata in `head` and content in `body` ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- Use `title`, `meta`, `link`, and related metadata elements for document-level concerns instead of mixing them into visible content ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).

### Form authoring

- Use built-in HTML form-related and state-related elements when they match the interaction you need; the platform already defines semantics for controls like `datalist`, `output`, and `progress` ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML)).
- Prefer styling hooks that do not destroy the underlying semantic control structure ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).

### Separation of structure and presentation

- HTML defines structure/meaning; CSS defines presentation ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).
- Keep reusable styling in CSS rather than encoding presentation in markup whenever the docs’ division of responsibilities applies ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).

### CSS organization

- Organize CSS around clear selectors, predictable cascade behavior, and modern layout primitives rather than hacks that depend on accidental specificity wins ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
- Prefer low-complexity selectors and clear structural relationships over escalating selector weight unnecessarily ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).

### Selector strategy

- Understand exactly what contributes to specificity and what does not ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
- Prefer selectors that communicate structural or reusable intent, such as type, class, attribute, and state selectors, instead of relying on IDs for routine styling ([MDN Styling basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics), [MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).

### Layout strategy

- Start with normal flow, then introduce flexbox, grid, float, or positioning only where the layout problem actually calls for them ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- Use flexbox for one-axis component layout and grid for two-axis layout problems ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).

### Responsive design

- Build layouts that adapt to different devices, sizes, and resolutions using modern layout techniques and query mechanisms ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- Consider media and container queries part of modern CSS authoring, not edge extras ([MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).

### Maintainability

- Use semantic HTML and deliberate CSS structure so the browser, tooling, and future maintainers can understand intent directly from the code ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).
- Be explicit about the role of selectors and layout systems to reduce future cascade and override fights ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).

### Performance guidance

- The docs in scope emphasize choosing the right layout mechanism and responsive strategy rather than forcing older hacks into modern layout problems ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- Keeping CSS specificity manageable and document structure semantic improves long-term maintainability and reduces brittle styling interactions ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity), [MDN Structuring content](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content)).

## Practical defaults for future coding tasks

- Start new pages with a clear semantic skeleton: `html > head + body`, then meaningful sectioning/content elements inside the body ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).
- Use classes for reusable styling hooks, keep specificity low, and only escalate when there is a concrete cascade reason ([MDN Specificity](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Specificity)).
- Reach for flexbox first for internal component alignment and grid first for page/content grids that need both rows and columns ([MDN CSS layout](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout)).
- Keep presentation in CSS and structure in HTML unless you have a narrow, document-local reason to embed styles directly in the document ([MDN HTML](https://developer.mozilla.org/en-US/docs/Web/HTML), [MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements)).

## Known ambiguities / spec-vs-reference notes

- **HTML source of truth:** the WHATWG HTML Living Standard is the canonical spec, and the cited index states it was last updated **10 May 2026** ([WHATWG HTML Living Standard](https://html.spec.whatwg.org/multipage/)).
- **CSS source of truth:** CSS behavior is spread across many module drafts; the CSSWG drafts index is the right canonical starting point for current spec status, but MDN is usually the faster author reference ([CSSWG drafts index](https://drafts.csswg.org/), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).
- **MDN is the practical reference**, but not every MDN overview page is exhaustive. Use MDN element and guide pages for authoring guidance, and fall back to WHATWG/CSSWG docs when behavior, definitions, or current-work status are unclear ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS), [WHATWG HTML Living Standard](https://html.spec.whatwg.org/multipage/), [CSSWG drafts index](https://drafts.csswg.org/)).
- This file is intentionally condensed. For exhaustive element/property coverage, use the MDN HTML element reference and CSS documentation directly ([MDN HTML elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements), [MDN CSS](https://developer.mozilla.org/en-US/docs/Web/CSS)).
