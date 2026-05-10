---
name: performance-profiling-expert
description: Performance and profiling skill. Use when diagnosing load or runtime slowness, interpreting Lighthouse or PageSpeed output, profiling browser traces, or measuring Node.js bottlenecks.
---

# Performance and profiling expert context

Use this skill for tasks involving performance investigation workflow, browser runtime/load profiling, Lighthouse and DevTools interpretation, user-centric metrics, and Node.js `perf_hooks` measurement.

## Included reference

- `../../docs/performance-profiling-expert-context.md`: practical reference covering browser profiling workflows, Lighthouse interpretation, user-centric performance framing, and Node.js runtime measurement APIs.

## Operating guidance

1. Treat the bundled context file as the source of truth for performance triage, profiling workflows, and measurement guidance.
2. Start by classifying the symptom: loading, runtime responsiveness, animation smoothness, or server/runtime work.
3. Measure before changing, and use the tool that matches the symptom: Lighthouse/PageSpeed for signals, DevTools traces for browser causes, and `perf_hooks` for explicit Node timing.
4. Treat audit output as directional evidence and traces/marks as causal evidence; do not conflate them.
5. For deeper tool details, follow the citations in the bundled file back to the Chrome, web.dev, MDN, and Node docs it links.

## Response expectations

- Ground recommendations in actual profiling tools, measurement APIs, and user-centric performance guidance.
- Prefer practical diagnostic sequences and measurable bottlenecks over generic “optimize performance” advice.
- Surface caveats around synthetic conditions, audit interpretation, noisy traces, and Node/browser API differences when they materially affect the answer.
- Use the bundled reference to keep guidance practical, current, and source-backed.
