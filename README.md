# Aggregaytor

**Unified message inbox for dating and social platforms.** Aggregates conversations from Sniffies, Grindr, DoubleList, Adam4Adam, and Gmail into a single Chrome extension side panel with AI-powered auto-respond, preference learning, and contact intelligence.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Setup & Installation](#setup--installation)
- [Development](#development)
- [Building](#building)
- [Loading the Extension](#loading-the-extension)
- [Usage Guide](#usage-guide)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Debug Tools](#debug-tools)
- [Documentation](#documentation)

---

## Features

### Core
- **Unified Inbox** — All messages from all platforms in one side panel
- **Real-time Capture** — Intercepts fetch/XHR/WebSocket traffic to capture messages as they arrive
- **Click-to-Navigate** — Click a thread to open that conversation on the platform
- **Contact Dossiers** — Auto-generated intelligence profiles with conversation history, preferences, and behavioral patterns
- **Search** — Full-text search across all messages and per-conversation search
- **Favorites & Sorting** — Star contacts, sort by recent/distance/interest/commitment/unread

### AI-Powered
- **7 LLM Providers** — Gemini, OpenAI, Anthropic, Groq, Perplexity, Mistral, Copilot with automatic rate-limit cycling
- **Smart Auto-Respond** — Context-aware responses with escalation tiers:
  - **Low risk** (greetings, small talk) — auto-sends after delay
  - **Medium risk** (time/location suggestions) — queued as draft for review
  - **High risk** (addresses, specific meetup plans) — requires manual approval
- **14 Personality Presets** — From "Chill" to "Dominant" with custom instructions
- **Writing Style Learning** — Derives your voice from conversation history
- **Preference Prediction** — ML logistic regression learns your type from like/dislike feedback
- **Sentiment Analysis** — Tracks interest, engagement, and commitment scores per contact

### Platform Support
| Platform | DMs | Global Chat | Auto-Respond | Avatar Sync |
|----------|-----|-------------|--------------|-------------|
| Sniffies | Yes | Yes (dedicated thread) | Yes | Yes (map + API) |
| Grindr | Yes | — | Yes | Yes |
| DoubleList | Yes | — | Yes | — |
| Adam4Adam | Yes | — | Yes | — |
| Gmail | Yes | — | — | — |

---

## Architecture

```
                    Chrome Extension (MV3)
                    =====================

  MAIN World                ISOLATED World           Service Worker
  (page context)            (extension context)      (background)
  ┌──────────────┐         ┌──────────────┐         ┌──────────────────────┐
  │ sniffies.ts  │ ──────> │ sniffies-    │ ──────> │ service-worker.ts    │
  │ grindr.ts    │ Custom  │ bridge.ts    │ chrome  │                      │
  │ doublelist.ts│ Events  │ grindr-      │ .runtime│ ┌──────────────────┐ │
  │ adam4adam.ts  │         │ bridge.ts    │ .send   │ │ Dexie store      │ │
  │ gmail.ts     │         │ etc.         │ Message │ │ messages/contacts│ │
  └──────┬───────┘         └──────────────┘         │ │ threads/dossiers │ │
         │                                          │ └──────────────────┘ │
  ┌──────┴───────┐                                  │ ┌──────────────────┐ │
  │ Adapters     │                                  │ │ LLM Engine       │ │
  │ (fetch/XHR/  │                                  │ │ 7 providers      │ │
  │  WebSocket   │                                  │ │ rate cycling     │ │
  │  intercept)  │                                  │ │ response cache   │ │
  └──────────────┘                                  │ └──────────────────┘ │
                                                    └──────────┬───────────┘
                                                               │
                                                    ┌──────────┴───────────┐
                                                    │ Side Panel (panel.js)│
                                                    │ Thread list, chat    │
                                                    │ view, settings, AI   │
                                                    └──────────────────────┘
```

### Data Flow

1. **Adapters** run in MAIN world (page's JS context) and monkey-patch `fetch`, `XMLHttpRequest`, and `WebSocket` to intercept network traffic
2. **Bridge scripts** run in ISOLATED world (extension context) and relay messages from MAIN world to the service worker via `chrome.runtime.sendMessage`
3. **Service worker** processes incoming messages, stores them in Dexie/IndexedDB, triggers auto-respond, manages LLM requests
4. **Side panel** queries the service worker for data and renders the UI

### Why Two Worlds?

Chrome MV3 content scripts run in an ISOLATED world by default (separate JS context from the page). To intercept the page's network calls, we need code in the MAIN world. But MAIN world code can't use `chrome.*` APIs. So we use a bridge pattern:

- **MAIN world script** → patches network, emits `CustomEvent`s
- **ISOLATED world bridge** → listens for events, forwards via `chrome.runtime`

---

## Project Structure

```
aggregaytor/
├── packages/                         # Shared library packages
│   ├── adapter-core/                 # Base adapter framework
│   │   ├── src/
│   │   │   ├── base-adapter.ts       # Abstract base class for all adapters
│   │   │   ├── network-interceptor.ts # Fetch/XHR/WebSocket monkey-patching
│   │   │   ├── payload-walker.ts     # Recursive API response traversal
│   │   │   ├── self-id-tracker.ts    # Detect authenticated user's own ID
│   │   │   ├── logger.ts            # Configurable log levels
│   │   │   └── types.ts             # UnifiedMessage, UnifiedContact, Platform
│   │   └── tsup.config.ts
│   ├── context-engine/               # Deduplication and similarity matching
│   │   ├── src/
│   │   │   ├── dedup.ts             # Message deduplication
│   │   │   ├── minhash.ts           # MinHash for text similarity
│   │   │   ├── lsh.ts              # Locality-Sensitive Hashing
│   │   │   └── search.ts           # Full-text search
│   │   └── tsup.config.ts
│   └── store/                        # Dexie-backed data layer
│       ├── src/
│       │   ├── db.ts                # Database init, indexes, destroy
│       │   ├── messages.ts          # Message CRUD + dedup
│       │   ├── contacts.ts          # Contact upsert with merge
│       │   ├── threads.ts           # Thread summaries (joins messages + contacts)
│       │   ├── thread-meta.ts       # User metadata (notes, favorites, settings)
│       │   ├── dossier.ts           # AI-generated contact profiles
│       │   ├── sentiment.ts         # Interest/engagement/commitment scoring
│       │   ├── preference-ml.ts     # Online SGD logistic regression
│       │   ├── auto-respond.ts      # Auto-response drafts and queue
│       │   ├── pictures.ts          # Picture library metadata
│       │   ├── block-rules.ts       # Auto-block/archive rules
│       │   ├── reminders.ts         # Contact reminders
│       │   ├── calendar.ts          # Availability calendar
│       │   └── types.ts             # All persisted document interfaces
│       └── tsup.config.ts
│
├── adapters/                         # Platform-specific adapters
│   ├── sniffies/                     # Sniffies (most complex)
│   │   └── src/
│   │       ├── sniffies-adapter.ts   # Fetch/WS interception + message parsing
│   │       ├── ws-parser.ts          # WebSocket frame parsing (raw JSON + Socket.IO)
│   │       └── profile-resolver.ts   # 6-priority profile ID extraction
│   ├── grindr/                       # Grindr web
│   ├── doublelist/                   # DoubleList
│   ├── adam4adam/                     # Adam4Adam
│   └── gmail/                        # Gmail
│
├── extensions/
│   └── aggregaytor/                  # Chrome extension (MV3)
│       ├── manifest.json             # Extension manifest
│       ├── background/
│       │   ├── service-worker.ts     # Message routing, auto-respond, scraping
│       │   ├── llm.ts               # Multi-provider LLM engine
│       │   └── debug-bridge.ts       # MCP debug interface
│       ├── content/
│       │   ├── sniffies.ts          # MAIN world: adapter + debug logger
│       │   ├── sniffies-bridge.ts   # ISOLATED world: event relay + DOM scraping
│       │   ├── grindr.ts / grindr-bridge.ts
│       │   ├── doublelist.ts / doublelist-bridge.ts
│       │   ├── adam4adam.ts / adam4adam-bridge.ts
│       │   └── gmail.ts / gmail-bridge.ts
│       ├── sidepanel/
│       │   ├── panel.html           # Side panel markup
│       │   ├── panel.js             # UI logic (~1800 lines)
│       │   └── panel.css            # Styles
│       ├── popup/
│       │   ├── popup.html           # Extension popup
│       │   └── popup.js
│       ├── icons/                   # Extension icons (16/48/128px)
│       └── vite.config.ts          # Build config with IIFE plugin
│
├── tools/
│   └── debug-server/                # MCP debug server
│
├── pnpm-workspace.yaml             # Workspace package paths
├── tsconfig.base.json              # Shared TypeScript config
├── vitest.config.ts                # Test configuration
└── package.json                    # Root scripts (build, test, lint)
```

---

## Setup & Installation

### Prerequisites

- **Node.js** >= 18
- **pnpm** >= 8 (`npm install -g pnpm`)
- **Chrome** (or Chromium-based browser)

### Clone & Install

```bash
git clone git@github.com:mithudso/aggregaytor.git
cd aggregaytor
pnpm install
```

### Build Everything

```bash
pnpm run build
```

This builds all packages in dependency order:
1. `packages/context-engine` and `packages/adapter-core`
2. All `adapters/*`
3. `packages/store`
4. `extensions/aggregaytor` (Vite bundles everything into `dist/`)

---

## Development

### Watch Mode

For iterative development on a specific package:

```bash
cd packages/adapter-core
pnpm run build --watch
```

For the extension (rebuilds on file changes):

```bash
cd extensions/aggregaytor
npx vite build --watch
```

### Testing

```bash
pnpm run test          # Run all tests
pnpm run lint          # Lint all code
```

### Clean Build

```bash
pnpm run clean         # Remove all dist/ directories
pnpm run build         # Fresh build
```

---

## Building

The build system uses **tsup** for library packages and **Vite** for the Chrome extension.

### Library Packages (tsup)

Each package in `packages/` and `adapters/` builds with tsup:
- **ESM** output (`dist/index.js`)
- **CJS** output (`dist/index.cjs`)
- **Type declarations** (`dist/index.d.ts`)
- **Source maps** for debugging

### Chrome Extension (Vite)

The extension build (`extensions/aggregaytor/vite.config.ts`) has special handling:

- **Service worker** — bundled as a single ES module
- **Content scripts (MAIN world)** — built as separate **IIFE** bundles (not ES modules, because MAIN world scripts can't use `import` due to CSP)
- **Content scripts (ISOLATED world)** — built as standard ES modules
- **Static assets** — HTML, CSS, icons copied to `dist/`

The output goes to `extensions/aggregaytor/dist/`.

---

## Loading the Extension

1. Build the project: `pnpm run build`
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extensions/aggregaytor/dist` folder
6. The extension icon appears in the toolbar

### After Code Changes

1. Run `pnpm run build`
2. Go to `chrome://extensions`
3. Click the **reload** icon on the Aggregaytor card
4. Refresh any open platform tabs

---

## Usage Guide

### First Launch

1. Click the extension icon to open the **side panel**
2. Open any supported platform in a browser tab (e.g., `sniffies.com`)
3. Messages are automatically captured as you browse and chat
4. The side panel shows a unified inbox of all conversations

### Inbox

- **Thread list** — Shows all conversations sorted by most recent
- **Platform chips** — Filter by platform (Sniffies, Grindr, etc.)
- **Sort dropdown** — Sort by: Recent, Distance, Interest, Commitment, Unread, Name
- **Star** — Click the star icon to favorite a contact
- **Search** — Type in the search bar to find messages across all platforms

### Conversation View

Click a thread to open the conversation:

- **Messages** — Shows the full chat history
- **Navigate** — Automatically opens the conversation on the platform tab
- **Profile Info** — Shows contact details, avatar, dossier
- **Toolbar** — Resync messages, view photos, search within chat, archive, clear

### AI Features

Open **Settings** (gear icon) → **AI** tab:

1. **API Keys** — Enter keys for your LLM providers (at least one required)
2. **Personality** — Choose from 14 presets or write custom instructions
3. **Auto-Respond** — Toggle per-thread or globally
   - Low-risk responses auto-send
   - Medium/high-risk responses appear as drafts for your review

### Auto-Respond Tiers

| Tier | What It Catches | What Happens |
|------|----------------|--------------|
| Low | Greetings, small talk, compliments | Auto-sends after short delay |
| Medium | Time suggestions ("tonight?"), area mentions | Draft notification — you approve/edit |
| High | Addresses, "come over", phone numbers | Prominent notification — must approve |

### Photo Sync

- Click **Sync Photos** in a conversation to scrape the contact's avatar
- The extension pulls photos from map markers, API responses, and profile pages
- Photos appear in the inbox thread list and conversation header

### Block Rules

Settings → **Rules** tab:
- Create rules to auto-archive contacts based on patterns
- Conditions: ignored count, keywords, days without response
- Actions: block, archive, or hide

---

## Configuration

### LLM Providers

Configure in Settings → AI tab. Supported providers:

| Provider | Models | Best For |
|----------|--------|----------|
| Gemini | gemini-2.0-flash, gemini-1.5-pro | High RPM, large context |
| OpenAI | gpt-4o, gpt-4o-mini | Quality responses |
| Anthropic | claude-sonnet-4-20250514, claude-3-haiku | Best quality, prompt caching |
| Groq | llama-3.3-70b, mixtral-8x7b | Fastest inference |
| Perplexity | llama-3.1-sonar-large | Web-grounded responses |
| Mistral | mistral-large, mistral-small | Good balance |
| Copilot | Built-in | Free, no key needed |

The engine automatically cycles between providers when rate limits are hit.

### Model Routing

Tasks are routed to different model tiers:

| Task | Tier | Models Used |
|------|------|-------------|
| Suggestions, Auto-respond | Premium | Best available model |
| Dossier, Summary | Standard | Mid-tier models |
| Nickname, Greeting | Economy | Cheapest/fastest model |

### Storage

All data is stored **locally** in IndexedDB through Dexie, with optional OPFS snapshots for supplemental local backups. Nothing leaves your browser except LLM API calls (which send conversation context to generate responses).

Clear all data: Settings → Data → Clear All Data

---

## How It Works

### Message Capture (Sniffies Example)

1. **Content script injection** — At `document_start`, the ISOLATED bridge injects the MAIN world script
2. **Network patching** — The adapter patches `window.fetch`, `XMLHttpRequest.prototype`, and `WebSocket` constructor + prototype
3. **Traffic interception** — Every API response is checked:
   - `shouldInterceptUrl()` — is this a Sniffies URL?
   - `parseApiResponse()` — walk the JSON payload, find message-like objects
   - Route based on URL: `/chat-data` → DMs, `/post-authentication?timeThreshold` → Global Chat
4. **WebSocket** — Presence events (userJoined/userAwake) are filtered; `newGlobalMsg` events route to Global Chat
5. **Normalization** — Messages are converted to `UnifiedMessage` format with platform, threadId, contactId, body, timestamp, direction
6. **Deduplication** — `seenMessageIds` Set prevents re-emitting captured messages
7. **Storage** — Messages flow through the bridge → service worker → Dexie/IndexedDB

### Self-ID Detection

A critical challenge: when parsing API responses, we need to identify which user is "you" vs "them". The adapter:
- Seeds from window globals (`__sniffies_user_id`, etc.)
- Detects from API payloads (`isMe: true`, `selfId`, `myProfileId`)
- Uses a 6-priority profile ID extraction that skips self-IDs

### Global Chat Routing

Sniffies has two types of messages:
- **DMs** — Private conversations, fetched from `/api/v2/post-authentication/chat-data`
- **Global Chat** — Broadcast posts ("HMU", "Hosting now"), fetched from `/api/post-authentication?timeThreshold=...`
- **WebSocket** — `newGlobalMsg` events are real-time global chat updates

All global messages route to a dedicated "Global Chat" thread.

---

## Troubleshooting

### Extension Not Capturing Messages

1. Check that the platform tab is open and loaded
2. Open DevTools on the platform tab → Console → look for `[Aggregaytor:` log lines
3. Verify content scripts are injected: `chrome://extensions` → Aggregaytor → inspect views

### Messages Not Appearing in Side Panel

1. Open side panel → check if platform chip is active
2. Try Settings → Data → Clear All Data, then reload
3. Check service worker logs: `chrome://extensions` → Aggregaytor → "service worker" link

### Auto-Respond Not Working

1. Verify at least one LLM API key is configured (Settings → AI)
2. Check that auto-respond is enabled (toggle in thread or global)
3. Check service worker console for LLM errors

### Sniffies-Specific Debug

Check WebSocket capture:
```javascript
JSON.parse(localStorage.__aggregaytor_ws_debug || '[]').slice(-20)
```

Check message routing:
```javascript
JSON.parse(localStorage.__aggregaytor_fetch_debug || '[]').forEach(f =>
  console.log(f.isGlobal ? 'GLOBAL' : 'DM', f.contactId, f.body?.slice(0,50))
)
```

---

## Debug Tools

### MCP Debug Server

The `tools/debug-server/` package provides an MCP server for debugging the extension with Claude Code:

```bash
cd tools/debug-server
pnpm run build
```

See `tools/debug-server/README.md` for setup.

### localStorage Debug Keys

The Sniffies adapter writes debug data to localStorage (survives page reload, works without DevTools open):

| Key | Contents |
|-----|----------|
| `__aggregaytor_ws_debug` | Last 150 WebSocket frames with event names and routing |
| `__aggregaytor_fetch_debug` | Last 200 captured messages with source URL and routing |

### Service Worker Console

Access via `chrome://extensions` → Aggregaytor → click "service worker" link under "Inspect views".

---

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — primary technical entry point: code map, message dispatch, storage, caching invariants
- [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) — prerequisites, dev workflow, adding a platform adapter, conventions, troubleshooting
- [docs/INSTALLATION.md](./docs/INSTALLATION.md) — install, load unpacked, verify, upgrade, uninstall
- [docs/TESTING.md](./docs/TESTING.md) — test suites, running/writing tests, coverage posture, known gaps
- [docs/SECURITY.md](./docs/SECURITY.md) — security model and hardening notes
- [docs/COMPONENTS.md](./docs/COMPONENTS.md) — component-level codebase overview
- [docs/requirements.md](./docs/requirements.md) — functional/non-functional requirements and dependencies
- [docs/onboarding.md](./docs/onboarding.md) — new-contributor walkthrough
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute

## License

See [LICENSE](./LICENSE) file.
