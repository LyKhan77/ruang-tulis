import type { JSONContent } from '@tiptap/core';
import type { DocumentRecord } from './data';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';
type Writer = (record: DocumentRecord, expectedRevision: number) => Promise<DocumentRecord>;

/** A session owns one identity. Switching is permitted only after flush resolves. */
export class SaveSession {
  private record: DocumentRecord;
  private generation = 0;
  private committedGeneration = 0;
  private running: Promise<void> | null = null;
  status: SaveStatus = 'saved';
  error = '';

  constructor(record: DocumentRecord, private writer: Writer, private notify: () => void) {
    this.record = structuredClone(record);
  }

  get snapshot(): DocumentRecord { return structuredClone(this.record); }
  get dirty(): boolean { return this.generation !== this.committedGeneration; }

  edit(patch: { title?: string; content?: JSONContent }): void {
    this.record = { ...this.record, ...structuredClone(patch) };
    this.generation += 1;
    // A conflict remains visible until an explicit retry or preservation action.
    if (this.status !== 'error') this.status = this.running ? 'saving' : 'pending';
    this.notify();
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    if (!this.dirty) return Promise.resolve();
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<void> {
    this.status = 'saving';
    this.error = '';
    this.notify();
    try {
      while (this.dirty) {
        const generation = this.generation;
        const snapshot = this.snapshot;
        const saved = await this.writer(snapshot, snapshot.revision);
        // Only server-owned metadata is merged. Never replace newer editor content.
        this.record = { ...this.record, revision: saved.revision, updatedAt: saved.updatedAt };
        this.committedGeneration = generation;
      }
      this.status = 'saved';
    } catch (error) {
      this.status = 'error';
      this.error = error instanceof Error ? error.message : 'Penyimpanan lokal gagal.';
      throw error;
    } finally {
      this.notify();
    }
  }
}
