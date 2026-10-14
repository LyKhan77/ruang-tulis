import { describe, expect, it } from 'vitest';
import { SaveSession } from './save-session';
import type { DocumentRecord } from './data';

const record = (): DocumentRecord => ({ id: 'a', title: 'Awal', content: { type: 'doc', content: [{ type: 'paragraph' }] }, schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 0 });

describe('SaveSession', () => {
  it('serializes writes and saves edits made during an in-flight save', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: { title: string; revision: number }[] = [];
    const session = new SaveSession(record(), async (snapshot, revision) => {
      calls.push({ title: snapshot.title, revision });
      if (calls.length === 1) await gate;
      return { ...snapshot, revision: revision + 1 };
    }, () => {});
    session.edit({ title: 'Pertama' });
    const first = session.flush();
    session.edit({ title: 'Terbaru' });
    const second = session.flush();
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual([{ title: 'Pertama', revision: 0 }, { title: 'Terbaru', revision: 1 }]);
    expect(session.snapshot.title).toBe('Terbaru');
    expect(session.snapshot.revision).toBe(2);
    expect(session.dirty).toBe(false);
  });

  it('retains unsaved content and revision when a save fails, then retries', async () => {
    let fail = true;
    const session = new SaveSession(record(), async (snapshot, revision) => {
      if (fail) throw new Error('Konflik');
      return { ...snapshot, revision: revision + 1 };
    }, () => {});
    session.edit({ title: 'Belum tersimpan' });
    await expect(session.flush()).rejects.toThrow('Konflik');
    expect(session.dirty).toBe(true);
    expect(session.snapshot.title).toBe('Belum tersimpan');
    expect(session.snapshot.revision).toBe(0);
    expect(session.status).toBe('error');
    fail = false;
    await session.flush();
    expect(session.status).toBe('saved');
  });

  it('uses the committed revision when a later queued save fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const revisions: number[] = [];
    const session = new SaveSession(record(), async (snapshot, revision) => {
      revisions.push(revision);
      if (revisions.length === 1) await gate;
      if (revisions.length === 2) throw new Error('Disk penuh');
      return { ...snapshot, revision: revision + 1 };
    }, () => {});
    session.edit({ title: 'Versi pertama' });
    const saving = session.flush();
    session.edit({ title: 'Versi terbaru' });
    release();
    await expect(saving).rejects.toThrow('Disk penuh');
    expect(session.snapshot.revision).toBe(1);
    expect(session.snapshot.title).toBe('Versi terbaru');
    expect(session.dirty).toBe(true);
    await session.flush();
    expect(revisions).toEqual([0, 1, 1]);
    expect(session.snapshot.revision).toBe(2);
    expect(session.dirty).toBe(false);
  });

  it('keeps document identity bound to the session', async () => {
    const ids: string[] = [];
    const session = new SaveSession(record(), async (snapshot, revision) => {
      ids.push(snapshot.id);
      return { ...snapshot, revision: revision + 1 };
    }, () => {});
    session.edit({ title: 'Dokumen A' });
    await session.flush();
    expect(ids).toEqual(['a']);
  });
});
