/**
 * google-tasks.ts — Google Tasks API integration.
 *
 * Syncs the local TaskDoc list with Google Tasks via the REST API.
 * Uses chrome.identity.getAuthToken() for authentication (configured
 * via the manifest.json oauth2 section).
 *
 * ## API Reference
 * https://developers.google.com/tasks/reference/rest
 *
 * ## Data Flow
 * - Local creates → push to Google Tasks (createGoogleTask)
 * - Local updates → push to Google Tasks (updateGoogleTask)
 * - Local deletes → delete from Google Tasks (deleteGoogleTask)
 * - Pull from Google → merge into local PouchDB (pullGoogleTasks)
 */

 
declare const chrome: any;

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const TASKLIST_KEY = 'aggregaytor_google_tasklist_id';

// ── Auth Helper ──────────────────────────────────────────────────────────────
//
// In-memory cache for the OAuth token. `chrome.identity.getAuthToken` itself
// caches under the hood, but the extension call still costs ~10–20ms of
// message-passing latency, and we hit it from: task sync (every 5 min),
// GOOGLE_TASKS_CREATE / UPDATE / DELETE, SYNC_TASK_TO_CALENDAR, Drive
// backup, and `isGoogleAuthenticated()` polls from the settings UI. Caching
// the resolved token in-process cuts this to ~0ms for the warm path.
//
// Google access tokens are valid for 60 minutes. We cache for 50 to leave
// a 10-min safety margin in case our local clock drifts, and we invalidate
// explicitly on 401 (via `invalidateGoogleAuthCache()` — called from the
// 401 retry path inside tasksApiFetch).
interface AuthCacheEntry { token: string; expiresAt: number; }
let _authCache: AuthCacheEntry | null = null;
const AUTH_CACHE_TTL_MS = 50 * 60_000; // 50 min — under the 60-min token lifetime

function invalidateGoogleAuthCache(): void {
  _authCache = null;
}

/**
 * Get a valid OAuth access token via chrome.identity.
 * Uses the scopes defined in manifest.json's oauth2 section.
 * Returns null if auth fails or is denied by the user.
 *
 * Warm path: in-process cache hit, no chrome.identity round-trip.
 */
async function getAuthToken(interactive = false): Promise<string | null> {
  // Serve from cache only when the caller didn't explicitly ask for an
  // interactive auth (clicking "Connect Google"). Interactive requests
  // must always hit chrome.identity so the user actually sees the consent
  // flow.
  if (!interactive && _authCache && _authCache.expiresAt > Date.now()) {
    return _authCache.token;
  }
  try {
    if (typeof chrome === 'undefined' || !chrome?.identity?.getAuthToken) return null;
    const token = await new Promise<string | null>((resolve) => {
      chrome.identity.getAuthToken({ interactive }, (tok: string) => {
        if (chrome.runtime.lastError) {
          console.warn('[GoogleTasks] Auth failed:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(tok || null);
        }
      });
    });
    if (token) {
      _authCache = { token, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    } else {
      _authCache = null;
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * Make an authenticated request to the Google Tasks API.
 * Retries once with a fresh token if the first attempt gets a 401.
 */
async function tasksApiFetch(
  path: string,
  opts: RequestInit = {},
  retry = true,
): Promise<any> {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated. Click "Connect Google" in settings.');

  const res = await fetch(`${TASKS_API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });

  if (res.status === 401 && retry) {
    // Token expired — revoke from chrome.identity AND invalidate our
    // in-process cache so the next getAuthToken() fetches a fresh one.
    await new Promise<void>((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
    invalidateGoogleAuthCache();
    return tasksApiFetch(path, opts, false);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Tasks API ${res.status}: ${body.slice(0, 200)}`);
  }

  // DELETE returns 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ── Task List Management ─────────────────────────────────────────────────────

/**
 * Get or create the "Aggregaytor" task list in Google Tasks.
 * Caches the list ID in chrome.storage.local.
 */
async function getOrCreateTaskList(): Promise<string> {
  // Check cache first
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    const data = await chrome.storage.local.get(TASKLIST_KEY);
    if (data[TASKLIST_KEY]) return data[TASKLIST_KEY];
  }

  // List all task lists and find ours
  const lists = await tasksApiFetch('/users/@me/lists');
  const existing = lists?.items?.find((l: any) => l.title === 'Aggregaytor');
  if (existing) {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      await chrome.storage.local.set({ [TASKLIST_KEY]: existing.id });
    }
    return existing.id;
  }

  // Create a new task list
  const created = await tasksApiFetch('/users/@me/lists', {
    method: 'POST',
    body: JSON.stringify({ title: 'Aggregaytor' }),
  });
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    await chrome.storage.local.set({ [TASKLIST_KEY]: created.id });
  }
  return created.id;
}

// ── CRUD Operations ──────────────────────────────────────────────────────────

/**
 * Create a task in Google Tasks.
 * @returns The created Google Task object with `id`, `title`, etc.
 */
/**
 * Convert a local due date to the RFC 3339 timestamp the API expects.
 * (Google stores only the date portion and discards the time.)
 * Returns null for anything unparseable, so a corrupt local `dueAt` drops the
 * field instead of throwing a RangeError out of the whole sync.
 */
function toGoogleDue(dueAt: string): string | null {
  const ms = new Date(dueAt).getTime();
  if (!Number.isFinite(ms)) {
    console.warn('[GoogleTasks] Ignoring unparseable due date:', dueAt);
    return null;
  }
  return new Date(ms).toISOString();
}

export async function createGoogleTask(opts: {
  title: string;
  notes?: string;
  dueAt?: string;
}): Promise<any> {
  const listId = await getOrCreateTaskList();
  const body: any = { title: opts.title };
  if (opts.notes) body.notes = opts.notes;
  if (opts.dueAt) {
    const due = toGoogleDue(opts.dueAt);
    if (due) body.due = due;
  }
  return tasksApiFetch(`/lists/${encodeURIComponent(listId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Update a task in Google Tasks.
 * @param googleTaskId The Google Tasks API task ID (not our local _id)
 */
export async function updateGoogleTask(
  googleTaskId: string,
  updates: { title?: string; notes?: string; dueAt?: string; completed?: boolean },
): Promise<any> {
  const listId = await getOrCreateTaskList();
  const body: any = {};
  if (updates.title !== undefined) body.title = updates.title;
  if (updates.notes !== undefined) body.notes = updates.notes;
  if (updates.dueAt !== undefined) {
    const due = toGoogleDue(updates.dueAt);
    if (due) body.due = due;
  }
  if (updates.completed !== undefined) {
    body.status = updates.completed ? 'completed' : 'needsAction';
    if (updates.completed) body.completed = new Date().toISOString();
    else body.completed = null;
  }
  return tasksApiFetch(`/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(googleTaskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Delete a task from Google Tasks.
 */
export async function deleteGoogleTask(googleTaskId: string): Promise<void> {
  const listId = await getOrCreateTaskList();
  await tasksApiFetch(`/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(googleTaskId)}`, {
    method: 'DELETE',
  });
}

/** Hard cap on pagination so a repeating pageToken can't loop forever. */
const MAX_TASK_PAGES = 20;

/**
 * Fetch the whole "Aggregaytor" list, following `nextPageToken`.
 *
 * `complete` reports whether the page cap was hit. It matters because
 * `syncGoogleTasks()` deletes every local task whose Google id is missing from
 * this list — acting on a truncated list would delete tasks that still exist
 * remotely. `showHidden` is required as well: Google hides older completed
 * tasks by default, and those would otherwise read as remote deletions.
 */
async function fetchAllGoogleTasks(): Promise<{ items: any[]; complete: boolean }> {
  const listId = await getOrCreateTaskList();
  const items: any[] = [];
  let pageToken = '';

  for (let page = 0; page < MAX_TASK_PAGES; page++) {
    const query = `?maxResults=100&showCompleted=true&showHidden=true`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const data = await tasksApiFetch(`/lists/${encodeURIComponent(listId)}/tasks${query}`);
    if (Array.isArray(data?.items)) items.push(...data.items);
    pageToken = data?.nextPageToken || '';
    if (!pageToken) return { items, complete: true };
  }

  console.warn(`[GoogleTasks] Stopped after ${MAX_TASK_PAGES} pages; remote list is larger than expected.`);
  return { items, complete: false };
}

/**
 * Pull all tasks from the "Aggregaytor" list in Google Tasks.
 * Returns the raw Google Tasks API objects.
 */
export async function pullGoogleTasks(): Promise<any[]> {
  return (await fetchAllGoogleTasks()).items;
}

/**
 * Bidirectional sync between local PouchDB tasks and Google Tasks.
 *
 * Pull (Google → Local):
 *   - New remote tasks → create locally with googleTaskId linked
 *   - Changed remote tasks → update local if remote is newer
 *   - Deleted remote tasks → delete local copy
 *
 * Push (Local → Google):
 *   - New local tasks (no googleTaskId) → create on Google, store ID
 *   - Changed local tasks (updatedAt > lastSyncedAt) → push updates
 *
 * @returns Summary of sync operations performed.
 */
export async function syncGoogleTasks(): Promise<{
  pulled: number; pushed: number; deleted: number;
}> {
  const { getAllTasks, updateTask, createTask, deleteTask } = await import('./tasks.js');

  // Fetch both sides
  const { items: remoteTasks, complete: remoteListComplete } = await fetchAllGoogleTasks();
  const localTasks = await getAllTasks();

  // Build lookup maps
  const localByGoogleId = new Map<string, any>();
  const localWithoutGoogle: any[] = [];
  for (const t of localTasks) {
    if (t.googleTaskId) localByGoogleId.set(t.googleTaskId, t);
    else localWithoutGoogle.push(t);
  }

  const remoteIds = new Set<string>();
  let pulled = 0;
  let pushed = 0;
  let deleted = 0;
  const now = new Date().toISOString();

  // ── Pull: Google → Local ──────────────────────────────────────────────
  for (const remote of remoteTasks) {
    if (!remote.id) continue;
    remoteIds.add(remote.id);
    const local = localByGoogleId.get(remote.id);

    const remoteUpdated = remote.updated || remote.completed || '';
    const isCompleted = remote.status === 'completed';

    if (!local) {
      // New remote task → create locally
      await createTask({
        title: remote.title || '(untitled)',
        notes: remote.notes || '',
        dueAt: remote.due || undefined,
        priority: 'medium',
        completed: isCompleted,
        completedAt: isCompleted ? (remote.completed || now) : undefined,
        googleTaskId: remote.id,
        lastSyncedAt: now,
      } as any);
      pulled++;
    } else {
      // Existing — update local if remote is newer
      const localUpdated = local.updatedAt || '';
      if (remoteUpdated > localUpdated) {
        await updateTask(local._id, {
          title: remote.title || local.title,
          notes: remote.notes ?? local.notes,
          dueAt: remote.due || local.dueAt,
          completed: isCompleted,
          completedAt: isCompleted ? (remote.completed || now) : '',
          lastSyncedAt: now,
        });
        pulled++;
      }
    }
  }

  // ── Delete local tasks whose Google counterpart was removed ──────────
  // Only safe when we saw the ENTIRE remote list; on a truncated pull an
  // absent id means "not fetched", not "deleted remotely".
  if (remoteListComplete) {
    for (const [googleId, local] of localByGoogleId) {
      if (!remoteIds.has(googleId)) {
        await deleteTask(local._id);
        deleted++;
      }
    }
  }

  // ── Push: Local → Google ──────────────────────────────────────────────
  // New local tasks (no googleTaskId) → create on Google
  for (const local of localWithoutGoogle) {
    try {
      const gTask = await createGoogleTask({
        title: local.title,
        notes: local.notes,
        dueAt: local.dueAt,
      });
      if (gTask?.id) {
        await updateTask(local._id, { googleTaskId: gTask.id, lastSyncedAt: now });
      }
      pushed++;
    } catch (err) {
      // Skip and retry on the next sync, but never silently: an always-failing
      // push is otherwise invisible. Error text comes from tasksApiFetch and
      // never contains the access token.
      console.warn('[GoogleTasks] Push (create) failed for task', local._id, err);
    }
  }

  // Dirty local tasks (updated since last sync) → push updates
  for (const [googleId, local] of localByGoogleId) {
    if (!remoteIds.has(googleId)) continue; // already handled (deleted)
    const lastSync = local.lastSyncedAt || '';
    if (local.updatedAt > lastSync) {
      try {
        await updateGoogleTask(googleId, {
          title: local.title,
          notes: local.notes,
          dueAt: local.dueAt,
          completed: local.completed,
        });
        await updateTask(local._id, { lastSyncedAt: now });
        pushed++;
      } catch (err) {
        console.warn('[GoogleTasks] Push (update) failed for task', local._id, err);
      }
    }
  }

  return { pulled, pushed, deleted };
}

/**
 * Authenticate interactively — shows the Google OAuth consent popup.
 * Call this when the user clicks "Connect Google" in settings.
 * @returns The access token, or null if denied.
 */
export async function authenticateGoogle(): Promise<string | null> {
  return getAuthToken(true);
}

/**
 * Check if the user is already authenticated (non-interactive).
 * @returns true if we have a valid cached token.
 */
export async function isGoogleAuthenticated(): Promise<boolean> {
  const token = await getAuthToken(false);
  return !!token;
}
