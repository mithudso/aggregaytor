import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { destroyDB, getDB } from '../src/db.js';
import { exportAllData, importAllData } from '../src/export-import.js';

describe('Dexie store compatibility', () => {
  beforeEach(async () => {
    await destroyDB().catch(() => {});
  });

  afterEach(async () => {
    await destroyDB().catch(() => {});
  });

  it('supports allDocs and compound find queries used by the store', async () => {
    const db = await getDB();
    await db.bulkDocs([
      {
        _id: 'msg:1',
        docType: 'message',
        contactId: 'contact-1',
        threadId: 'thread-1',
        platform: 'sniffies',
        timestamp: '2026-01-01T00:00:00.000Z',
        direction: 'in',
        read: false,
      },
      {
        _id: 'msg:2',
        docType: 'message',
        contactId: 'contact-1',
        threadId: 'thread-1',
        platform: 'sniffies',
        timestamp: '2026-01-01T00:01:00.000Z',
        direction: 'out',
        read: true,
      },
      {
        _id: 'contact:1',
        docType: 'contact',
        platform: 'sniffies',
      },
    ]);

    const range = await db.allDocs({ startkey: 'msg:', endkey: 'msg:\uffff', include_docs: true });
    expect(range.rows).toHaveLength(2);

    const found = await db.find({
      selector: { docType: 'message', contactId: 'contact-1' },
      sort: [{ docType: 'asc' }, { contactId: 'asc' }],
    });
    expect(found.docs.map(doc => doc._id)).toEqual(['msg:1', 'msg:2']);

    const unread = await db.find({
      selector: { docType: 'message', read: false, direction: 'in' },
      fields: ['_id'],
    });
    expect(unread.docs).toEqual([{ _id: 'msg:1' }]);
  });

  it('round-trips export/import through the Dexie backend', async () => {
    const db = await getDB();
    await db.put({
      _id: 'meta:contact-1',
      docType: 'thread_meta',
      contactId: 'contact-1',
      archived: true,
    });

    const json = await exportAllData();
    await destroyDB();

    const result = await importAllData(json);
    expect(result.imported).toBe(1);

    const reopened = await getDB();
    const doc = await reopened.get('meta:contact-1');
    expect(doc.archived).toBe(true);
  });
});
