// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DocumentStore, type DocumentRecord } from './data';
import { TINY_PNG } from './raster-fixtures';
import { installThemeTestEnvironment, type ThemeTestEnvironment } from './theme-test-environment';

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

    expect(element<HTMLButtonElement>('.header-actions button').textContent).toContain('Unduh cadangan');
    expect(element<HTMLButtonElement>('.sidebar-backup button:first-child').textContent).toContain('Impor cadangan');
    expect(element<HTMLButtonElement>('.sidebar-backup button:last-child').textContent).toContain('Ekspor semua dokumen');
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
