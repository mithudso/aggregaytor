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

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const TASKLIST_KEY = 'aggregaytor_google_tasklist_id';

// ── Auth Helper ──────────────────────────────────────────────────────────────

/**
 * Get a valid OAuth access token via chrome.identity.
 * Uses the scopes defined in manifest.json's oauth2 section.
 * Returns null if auth fails or is denied by the user.
 */
async function getAuthToken(interactive = false): Promise<string | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome?.identity?.getAuthToken) return null;
    return new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive }, (token: string) => {
        if (chrome.runtime.lastError) {
          console.warn('[GoogleTasks] Auth failed:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(token || null);
        }
      });
    });
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
    // Token expired — revoke and get a fresh one
    await new Promise<void>((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
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
export async function createGoogleTask(opts: {
  title: string;
  notes?: string;
  dueAt?: string;
}): Promise<any> {
  const listId = await getOrCreateTaskList();
  const body: any = { title: opts.title };
  if (opts.notes) body.notes = opts.notes;
  // Google Tasks API uses RFC 3339 date (date only, no time for due)
  if (opts.dueAt) body.due = new Date(opts.dueAt).toISOString();
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
  if (updates.dueAt !== undefined) body.due = new Date(updates.dueAt).toISOString();
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

/**
 * Pull all tasks from the "Aggregaytor" list in Google Tasks.
 * Returns the raw Google Tasks API objects.
 */
export async function pullGoogleTasks(): Promise<any[]> {
  const listId = await getOrCreateTaskList();
  const data = await tasksApiFetch(`/lists/${encodeURIComponent(listId)}/tasks?maxResults=100&showCompleted=true`);
  return data?.items || [];
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
