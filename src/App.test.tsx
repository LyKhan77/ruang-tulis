// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DocumentStore, type DocumentRecord } from './data';
import { TINY_PNG } from './raster-fixtures';
import { installThemeTestEnvironment, type ThemeTestEnvironment } from './theme-test-environment';

const wordCodec = vi.hoisted(() => ({
  importDocx: vi.fn(),
  exportDocx: vi.fn(),
}));
vi.mock('./docx', () => wordCodec);

const selectionKey = 'ruang-tulis:selected-document';
let container: HTMLDivElement;
let root: Root | undefined;
let themeEnvironment: ThemeTestEnvironment;
let restoreRangeGeometry: () => void;

// jsdom has no layout. Supply only geometry; keep native focus and selection real.
function installRangeGeometry(): () => void {
  const methods = {
    getClientRects: () => [],
    getBoundingClientRect: () => new DOMRect(),
  };
  const descriptors: Record<string, PropertyDescriptor | undefined> = {};
  for (const [name, value] of Object.entries(methods)) {
    descriptors[name] = Object.getOwnPropertyDescriptor(Range.prototype, name);
    Object.defineProperty(Range.prototype, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
      else Reflect.deleteProperty(Range.prototype, name);
    }
  };
}

beforeEach(() => {
  wordCodec.importDocx.mockReset();
  wordCodec.exportDocx.mockReset();
  themeEnvironment = installThemeTestEnvironment();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  restoreRangeGeometry = installRangeGeometry();
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  try {
    if (root) await act(async () => { root?.unmount(); });
  } finally {
    root = undefined;
    container.remove();
    window.getSelection()?.removeAllRanges();
    restoreRangeGeometry();
    vi.restoreAllMocks();
    themeEnvironment.restore();
    vi.unstubAllGlobals();
  }
});

function element<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`App element not found: ${selector}`);
  return found;
}

function queryInput(): HTMLInputElement {
  return element<HTMLInputElement>('#find-query');
}

function button(label: string): HTMLButtonElement {
  return element<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function matchCount(): string | null {
  return element('[aria-label="Cari dan ganti"] [role="status"]').textContent;
}

async function mountSeededApp(): Promise<HTMLElement> {
  root = createRoot(container);
  await act(async () => { root?.render(<App />); });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const editor = container.querySelector<HTMLElement>('[aria-label="Isi dokumen"]');
    const find = container.querySelector<HTMLButtonElement>('button[aria-label="Cari dan ganti (Ctrl/⌘ F)"]');
    if (editor?.getAttribute('contenteditable') === 'true'
      && editor.textContent?.includes('Selamat datang') && find && !find.disabled) {
      return editor;
    }
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
    });
  }
  throw new Error(`The seeded App did not become editable: ${container.textContent}`);
}

async function interact(action: () => void): Promise<void> {
  await act(async () => { action(); });
  // Tiptap focus() defers editor focus to an animation frame. Do not assert early.
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}

async function pressKey(target: EventTarget, key: string, modifiers: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  await interact(() => { target.dispatchEvent(event); });
  return event;
}

async function typeQuery(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('The native input value setter is unavailable.');
  await interact(() => {
    setter.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  });
}

async function clickButton(target: HTMLButtonElement): Promise<void> {
  expect(target.disabled).toBe(false);
  await interact(() => {
    const allowDefault = target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    // Dispatching a synthetic mouse event does not perform the browser's default focus.
    if (allowDefault) target.focus();
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    target.click();
  });
}

async function waitForApp(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      window.setTimeout(resolve, 10);
      await promise;
    });
  }
  expect(condition()).toBe(true);
}

async function chooseWordFile(file: File): Promise<void> {
  const input = element<HTMLInputElement>('input[aria-label="Pilih dokumen Word (.docx)"]');
  await interact(() => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function expectQueryFocused(input: HTMLInputElement, editor: HTMLElement, originalText: string): void {
  expect(document.activeElement).toBe(input);
  expect(editor.textContent).toBe(originalText);
  expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  expect(container.querySelectorAll('[aria-label="Cari dan ganti"]')).toHaveLength(1);
}

describe('App backup copy', () => {
  it('keeps default app copy free of JSON terminology while retaining backup controls', async () => {
    await mountSeededApp();

    for (const selector of ['.workspace-header', '.sidebar', '.status-bar', '.local-disclosure']) {
      expect(element(selector).textContent).not.toMatch(/json/i);
    }

    expect(button('Unduh cadangan').textContent).toContain('Unduh cadangan');
    expect(button('Impor cadangan').textContent).toContain('Impor cadangan');
    expect(button('Cadangkan semua dokumen').textContent).toContain('Cadangkan semua dokumen');
    expect(element('.status-bar').textContent).toContain('Penyimpanan lokal');
    expect(element('.local-disclosure').textContent).toContain('Ekspor cadangan untuk melindungi dokumen.');

    const input = element<HTMLInputElement>('input[type="file"][accept=".json,application/json"]');
    expect(input.getAttribute('aria-label')).toBe('Pilih cadangan dokumen');
    expect(input.getAttribute('aria-label')).not.toMatch(/json/i);
  });
});

describe('App display theme', () => {
  async function chooseTheme(value: string) {
    await interact(() => {
      const select = element<HTMLSelectElement>('select[aria-label="Tema tampilan"]');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('exposes a labeled keyboard-accessible preference and preserves editor content and document selection', async () => {
    themeEnvironment.setSystemDark(true);
    const editor = await mountSeededApp();
    const originalMarkup = editor.innerHTML;
    const selectedDocument = localStorage.getItem(selectionKey);
    const title = element<HTMLInputElement>('#document-title').value;
    const store = new DocumentStore();
    try {
      const before = await store.list();
      const select = element<HTMLSelectElement>('select[aria-label="Tema tampilan"]');
      expect(select.closest('label')?.textContent).toContain('Tema');
      expect(Array.from(select.options, (option) => [option.value, option.text])).toEqual([
        ['light', 'Terang'], ['dark', 'Gelap'], ['system', 'Ikuti sistem'],
      ]);
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('dark');
      select.focus();
      expect(document.activeElement).toBe(select);
      await chooseTheme('light');
      expect(select.value).toBe('light');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(localStorage.getItem('ruang-tulis:theme')).toBe('light');
      await interact(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: 'ruang-tulis:theme', newValue: 'dark', storageArea: localStorage }));
      });
      expect(select.value).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
      await interact(() => { window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })); });
      expect(select.value).toBe('system');
      expect(editor.innerHTML).toBe(originalMarkup);
      expect(element<HTMLInputElement>('#document-title').value).toBe(title);
      expect(localStorage.getItem(selectionKey)).toBe(selectedDocument);
      expect(await store.list()).toEqual(before);
      expect(editor.getAttribute('contenteditable')).toBe('true');
      const print = vi.spyOn(window, 'print').mockImplementation(() => {});
      await clickButton(element<HTMLButtonElement>('.header-actions button:last-child'));
      expect(print).toHaveBeenCalledOnce();
      expect(select.value).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(localStorage.getItem('ruang-tulis:theme')).toBe('light');
    } finally {
      await store.close();
    }
  });

  it('retains an explicit preference across an App remount', async () => {
    await mountSeededApp();
    await chooseTheme('dark');
    await act(async () => { root?.unmount(); });
    root = undefined;
    await mountSeededApp();
    expect(element<HTMLSelectElement>('select[aria-label="Tema tampilan"]').value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('stays available before the database finishes loading', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(DocumentStore.prototype, 'seedIfEmpty').mockImplementation(() => pending);
    root = createRoot(container);
    await act(async () => { root?.render(<App />); });
    try {
      expect(container.textContent).toContain('Membuka penyimpanan');
      await chooseTheme('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(element<HTMLButtonElement>('.header-actions button').disabled).toBe(true);
    } finally {
      await act(async () => { root?.unmount(); });
      root = undefined;
      release();
    }
  });

  it('keeps database errors visible while reporting a session-only theme choice', async () => {
    vi.spyOn(DocumentStore.prototype, 'seedIfEmpty').mockRejectedValue(new Error('Database blocked'));
    root = createRoot(container);
    await act(async () => { root?.render(<App />); });
    const deadline = Date.now() + 3_000;
    while (!container.querySelector('[role="alert"]') && Date.now() < deadline) {
      await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
    }
    const error = element('[role="alert"]').textContent;
    expect(error).toContain('Database blocked');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    await chooseTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(element<HTMLSelectElement>('select[aria-label="Tema tampilan"]').value).toBe('dark');
    expect(element('[aria-label="Pemberitahuan tema"]').textContent).toMatch(/hanya.*sesi ini/i);
    expect(element('[role="alert"]').textContent).toBe(error);
  });
});

describe('App search focus', () => {
  it('keeps focus in the query through Enter navigation and subsequent query edits', async () => {
    const editor = await mountSeededApp();
    const originalText = editor.textContent!;
    const shortcut = await pressKey(document, 'f', { ctrlKey: true });
    expect(shortcut.defaultPrevented).toBe(true);
    const input = queryInput();
    expectQueryFocused(input, editor, originalText);

    // The Indonesian seed contains two occurrences, including capitalized "Dokumen".
    await typeQuery(input, 'dokumen');
    expect(input.value).toBe('dokumen');
    expect(matchCount()).toBe('2 hasil');
    expectQueryFocused(input, editor, originalText);

    const enter = await pressKey(input, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    // The count exposes the selected editor match without relying on native DOM selection.
    expect(matchCount()).toBe('1 dari 2 hasil');
    expectQueryFocused(input, editor, originalText);

    // Do not refocus the input: typing after navigation must not alter the document.
    await typeQuery(input, 'dok');
    expect(input.value).toBe('dok');
    expect(matchCount()).toBe('2 hasil');
    expectQueryFocused(input, editor, originalText);

    await pressKey(input, 'Enter');
    expect(matchCount()).toBe('1 dari 2 hasil');
    expectQueryFocused(input, editor, originalText);
    await pressKey(input, 'Enter', { shiftKey: true });
    expect(matchCount()).toBe('2 dari 2 hasil');
    expectQueryFocused(input, editor, originalText);
  });

  it('focuses the query from the toolbar and retains it through next and previous buttons', async () => {
    const editor = await mountSeededApp();
    const originalText = editor.textContent!;
    await interact(() => { editor.focus(); });
    expect(document.activeElement).toBe(editor);
    await clickButton(button('Cari dan ganti (Ctrl/⌘ F)'));
    const input = queryInput();
    expectQueryFocused(input, editor, originalText);
    await typeQuery(input, 'dokumen');
    expect(matchCount()).toBe('2 hasil');
    expectQueryFocused(input, editor, originalText);

    await clickButton(button('Hasil berikutnya'));
    expect(matchCount()).toBe('1 dari 2 hasil');
    expectQueryFocused(input, editor, originalText);
    await clickButton(button('Hasil sebelumnya'));
    expect(matchCount()).toBe('2 dari 2 hasil');
    expectQueryFocused(input, editor, originalText);
    await clickButton(button('Hasil berikutnya'));
    expect(matchCount()).toBe('1 dari 2 hasil');
    expectQueryFocused(input, editor, originalText);
  });

  it('refocuses and selects the existing query on every Ctrl+F while the panel is open', async () => {
    const editor = await mountSeededApp();
    const originalText = editor.textContent!;
    await pressKey(document, 'f', { ctrlKey: true });
    const input = queryInput();
    await typeQuery(input, 'dokumen');
    expect(matchCount()).toBe('2 hasil');
    expectQueryFocused(input, editor, originalText);

    for (const target of [editor, document, editor]) {
      await interact(() => {
        input.setSelectionRange(input.value.length, input.value.length);
        editor.focus();
      });
      expect(document.activeElement).toBe(editor);
      expect(input.selectionStart).toBe(input.value.length);
      expect(input.selectionEnd).toBe(input.value.length);

      const shortcut = await pressKey(target, 'f', { ctrlKey: true });
      expect(shortcut.defaultPrevented).toBe(true);
      expect(queryInput()).toBe(input);
      expect(input.value).toBe('dokumen');
      expectQueryFocused(input, editor, originalText);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
      expect(matchCount()).toBe('2 hasil');
    }
  });
});

describe('App image import preflight', () => {
  it('rejects a browser image-decode failure before importing any backup records', async () => {
    const editor = await mountSeededApp();
    const originalText = editor.textContent;
    const store = new DocumentStore();
    try {
      const originalRecords = await store.list();
      expect(originalRecords).toHaveLength(1);
      // This spy delegates to the real store; unchanged persisted records are also asserted.
      const importDocuments = vi.spyOn(DocumentStore.prototype, 'importDocuments');
      vi.stubGlobal('Image', function ImageWithDecodeFailure() {
        const image = document.createElement('img');
        Object.defineProperty(image, 'src', {
          configurable: true,
          set: () => { queueMicrotask(() => image.dispatchEvent(new Event('error'))); },
        });
        return image;
      });

      const timestamp = '2026-01-01T00:00:00.000Z';
      const imageRecord: DocumentRecord = {
        id: 'image-backup',
        title: 'Cadangan bergambar',
        schemaVersion: 1,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Dokumen dari cadangan.' }] },
            { type: 'image', attrs: { src: TINY_PNG, alt: 'Gambar kecil' } },
          ],
        },
      };
      // Even a valid text-only record preceding the failed image must not be committed.
      const backup = JSON.stringify({
        format: 'document-editor',
        version: 1,
        documents: [
          { ...imageRecord, id: 'text-backup', title: 'Cadangan teks', content: {
            type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Catatan cadangan.' }] }],
          } },
          imageRecord,
        ],
      });
      const file = new File([backup], 'cadangan.json', { type: 'application/json' });
      // jsdom File may not implement Blob.text(); parsing still runs in the real App.
      Object.defineProperty(file, 'text', { value: async () => backup });
      const input = element<HTMLInputElement>('input[aria-label="Pilih cadangan dokumen"]');
      await interact(() => {
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const deadline = Date.now() + 3_000;
      while (!container.querySelector('[role="alert"]') && Date.now() < deadline) {
        await act(async () => {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
        });
      }
      expect(element('[role="alert"]').textContent).toContain('Berkas gambar tidak dapat dibaca. Cadangan belum diimpor.');
      expect(importDocuments).not.toHaveBeenCalled();
      expect(await store.list()).toEqual(originalRecords);
      expect(editor.textContent).toBe(originalText);
      expect(editor.getAttribute('contenteditable')).toBe('true');
    } finally {
      await store.close();
    }
  });
});

describe('App Word document exchange', () => {
  const wordMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const wordFile = () => new File(['Word fixture'], 'catatan.docx', { type: wordMime });

  it('offers DOCX as the main file exchange while keeping recovery backups separate', async () => {
    await mountSeededApp();
    expect(button('Unduh Word (.docx)').disabled).toBe(false);
    expect(button('Impor Word (.docx)').disabled).toBe(false);
    const input = element<HTMLInputElement>('input[aria-label="Pilih dokumen Word (.docx)"]');
    expect(input.accept).toBe(`.docx,${wordMime}`);
    expect(element<HTMLInputElement>('input[aria-label="Pilih cadangan dokumen"]').accept).toBe('.json,application/json');
    expect(element('.workspace-header').textContent).not.toMatch(/json/i);
    expect(element('.sidebar').textContent).not.toMatch(/json/i);
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    await clickButton(button('Impor Word (.docx)'));
    expect(click).toHaveBeenCalledOnce();
  });

  it('downloads the current unsaved snapshot as a DOCX file without requiring a database write', async () => {
    await mountSeededApp();
    const result = {
      blob: new Blob(['DOCX fixture'], { type: wordMime }),
      filename: 'Catatan.docx',
      warnings: ['Tata letak kompleks dapat disederhanakan.'],
    };
    wordCodec.exportDocx.mockResolvedValue(result);
    const createObjectURL = vi.fn(() => 'blob:word-download');
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const save = vi.spyOn(DocumentStore.prototype, 'save');
    await typeQuery(element<HTMLInputElement>('#document-title'), 'Catatan belum tersimpan');
    await clickButton(button('Unduh Word (.docx)'));
    await waitForApp(() => createObjectURL.mock.calls.length === 1);
    const snapshot = wordCodec.exportDocx.mock.calls[0][0] as DocumentRecord;
    expect(snapshot.title).toBe('Catatan belum tersimpan');
    expect(snapshot.content.type).toBe('doc');
    expect(save).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledWith(result.blob);
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('Catatan.docx');
    expect(link.href).toBe('blob:word-download');
    expect(element('.notice-message').textContent).toContain('Tata letak kompleks dapat disederhanakan.');
  });

  it('holds the operation lock during Word conversion and restores editing after an export failure', async () => {
    const editor = await mountSeededApp();
    const original = editor.innerHTML;
    const pending = Promise.withResolvers<{ blob: Blob; filename: string; warnings: string[] }>();
    wordCodec.exportDocx.mockReturnValue(pending.promise);
    await clickButton(button('Unduh Word (.docx)'));
    await waitForApp(() => wordCodec.exportDocx.mock.calls.length === 1);
    expect(editor.getAttribute('contenteditable')).toBe('false');
    expect(element<HTMLButtonElement>('.new-document').disabled).toBe(true);
    expect(button('Impor Word (.docx)').disabled).toBe(true);
    await act(async () => { pending.reject(new Error('Ekspor Word tidak dapat diselesaikan.')); });
    await waitForApp(() => editor.getAttribute('contenteditable') === 'true');
    expect(editor.innerHTML).toBe(original);
    expect(element('[role="alert"]').textContent).toContain('Ekspor Word tidak dapat diselesaikan.');
  });

  it('imports a converted DOCX as a new document without replacing an existing record', async () => {
    await mountSeededApp();
    const store = new DocumentStore();
    try {
      const original = await store.list();
      const content: DocumentRecord['content'] = {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Judul dari Word' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Catatan dari Word', marks: [{ type: 'bold' }] }] },
        ],
      };
      wordCodec.importDocx.mockResolvedValue({
        title: 'Catatan Word', content, warnings: ['Periksa hasil konversi sebelum melanjutkan.'],
      });
      const file = wordFile();
      await chooseWordFile(file);
      await waitForApp(() => element<HTMLInputElement>('#document-title').value === 'Catatan Word');
      expect(wordCodec.importDocx).toHaveBeenCalledWith(file);
      const records = await store.list();
      expect(records).toHaveLength(2);
      expect(records.find(record => record.id === original[0].id)).toEqual(original[0]);
      expect(records.find(record => record.title === 'Catatan Word')?.content).toEqual(content);
      expect(element('[aria-label="Isi dokumen"] strong').textContent).toBe('Catatan dari Word');
      expect(element('.notice-message').textContent).toContain('Dokumen lama tidak ditimpa.');
      expect(element('.notice-message').textContent).toContain('Periksa hasil konversi sebelum melanjutkan.');
    } finally {
      await store.close();
    }
  });

  it('keeps the active document and database intact when a Word import is rejected', async () => {
    const editor = await mountSeededApp();
    const originalText = editor.innerHTML;
    const store = new DocumentStore();
    try {
      const original = await store.list();
      const create = vi.spyOn(DocumentStore.prototype, 'create');
      wordCodec.importDocx.mockRejectedValue(new Error('Paket DOCX tidak valid.'));
      await chooseWordFile(wordFile());
      await waitForApp(() => !!container.querySelector('[role="alert"]'));
      expect(element('[role="alert"]').textContent).toContain('Paket DOCX tidak valid.');
      expect(create).not.toHaveBeenCalled();
      expect(await store.list()).toEqual(original);
      expect(editor.innerHTML).toBe(originalText);
      expect(editor.getAttribute('contenteditable')).toBe('true');
      expect(element<HTMLInputElement>('input[aria-label="Pilih dokumen Word (.docx)"]').value).toBe('');
    } finally {
      await store.close();
    }
  });

  it('cancels Word import before conversion if the active document cannot be flushed', async () => {
    await mountSeededApp();
    vi.spyOn(DocumentStore.prototype, 'save').mockRejectedValue(new Error('Kuota penyimpanan habis.'));
    await typeQuery(element<HTMLInputElement>('#document-title'), 'Perubahan lokal');
    await chooseWordFile(wordFile());
    await waitForApp(() => !!container.querySelector('.save-error'));
    expect(wordCodec.importDocx).not.toHaveBeenCalled();
    expect(element<HTMLInputElement>('#document-title').value).toBe('Perubahan lokal');
    expect(element('.save-error').textContent).toContain('Isi belum tersimpan.');
    expect(button('Unduh Word (.docx)').disabled).toBe(false);
  });
});
