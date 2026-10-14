import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { createDocumentId, DocumentStore, emptyContent, isSafeLink, MAX_BACKUP_BYTES, MAX_IMAGE_BYTES, parseBackup, serializeBackup, type DocumentRecord } from './data';
import { createExtensions, documentStats, findMatches, headingOutline, replaceAllMatches, replaceMatch } from './editor';
import { SaveSession } from './save-session';
import { decodeLocalRaster, decodeDocumentImages } from './image-preflight';
import { useTheme } from './theme';
import { exportDocx, importDocx } from './docx';

const selectionKey = 'ruang-tulis:selected-document';
const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const imageCapabilityProbe = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSFgAAAHEASFiX4r9AAAAAElFTkSuQmCC';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    file: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
    plus: 'M12 5v14 M5 12h14', search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    trash: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
    download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5', upload: 'M12 16V4 M7 9l5-5 5 5 M4 16v5h16v-5',
    print: 'M6 8V3h12v5 M6 17H3V9h18v8h-3 M6 14h12v7H6z M17 11h1',
    undo: 'M8 5L3 10l5 5 M3 10h11a6 6 0 0 1 0 12', redo: 'M16 5l5 5-5 5 M21 10H10a6 6 0 0 0 0 12',
    link: 'M10 14l4-4 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    image: 'M3 3h18v18H3z M3 17l6-6 5 5 3-3 4 4 M15 7h.01', table: 'M3 4h18v16H3z M3 9h18 M3 14h18 M9 4v16 M15 4v16',
    left: 'M4 5h16 M4 10h10 M4 15h16 M4 20h10', center: 'M4 5h16 M7 10h10 M4 15h16 M7 20h10', right: 'M4 5h16 M10 10h10 M4 15h16 M10 20h10',
    indent: 'M10 5h10 M10 10h10 M10 15h10 M10 20h10 M3 8l4 4-4 4', outdent: 'M10 5h10 M10 10h10 M10 15h10 M10 20h10 M7 8l-4 4 4 4',
    check: 'M5 12l4 4L19 6', chevron: 'M8 5l7 7-7 7', close: 'M6 6l12 12 M18 6L6 18', menu: 'M4 6h16 M4 12h16 M4 18h16',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.file} /></svg>;
}

function ToolButton({ label, children, active, disabled, onClick }: { label: string; children: ReactNode; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={`tool-button${active ? ' active' : ''}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>;
}

function Toolbar({ editor, disabled, onImage, onFind, onError }: { editor: Editor; disabled: boolean; onImage: () => void; onFind: () => void; onError: (message: string) => void }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [tableOpen, setTableOpen] = useState(false);
  const inList = editor.isActive('listItem');
  const headingLevel = [1, 2, 3].find((level) => editor.isActive('heading', { level }));
  const applyLink = () => {
    if (!isSafeLink(href.trim())) { onError('Tautan harus memakai http://, https://, atau mailto:.'); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim(), target: '_blank', rel: 'noopener noreferrer nofollow' }).run();
    setLinkOpen(false);
  };
  return <div className="toolbar-area no-print">
    <div className="toolbar" role="toolbar" aria-label="Format dokumen">
      <div className="tool-group">
        <ToolButton label="Urungkan (Ctrl/⌘ Z)" disabled={disabled || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Icon name="undo" /></ToolButton>
        <ToolButton label="Ulangi (Ctrl/⌘ Shift Z)" disabled={disabled || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Icon name="redo" /></ToolButton>
      </div>
      <div className="tool-group"><select aria-label="Gaya paragraf" disabled={disabled} value={headingLevel || 'paragraph'} onChange={(event) => {
        if (event.target.value === 'paragraph') editor.chain().focus().setParagraph().run();
        else editor.chain().focus().setHeading({ level: Number(event.target.value) as 1 | 2 | 3 }).run();
      }}><option value="paragraph">Teks normal</option><option value="1">Judul 1</option><option value="2">Judul 2</option><option value="3">Judul 3</option></select></div>
      <div className="tool-group">
        <ToolButton label="Tebal (Ctrl/⌘ B)" active={editor.isActive('bold')} disabled={disabled || !editor.can().toggleBold()} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></ToolButton>
        <ToolButton label="Miring (Ctrl/⌘ I)" active={editor.isActive('italic')} disabled={disabled || !editor.can().toggleItalic()} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></ToolButton>
        <ToolButton label="Garis bawah (Ctrl/⌘ U)" active={editor.isActive('underline')} disabled={disabled || !editor.can().toggleUnderline()} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></ToolButton>
        <ToolButton label="Coret" active={editor.isActive('strike')} disabled={disabled || !editor.can().toggleStrike()} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></ToolButton>
      </div>
      <div className="tool-group">
        <ToolButton label="Daftar poin" active={editor.isActive('bulletList')} disabled={disabled || !editor.can().toggleBulletList()} onClick={() => editor.chain().focus().toggleBulletList().run()}><span className="list-symbol">• ≡</span></ToolButton>
        <ToolButton label="Daftar bernomor" active={editor.isActive('orderedList')} disabled={disabled || !editor.can().toggleOrderedList()} onClick={() => editor.chain().focus().toggleOrderedList().run()}><span className="list-symbol">1 ≡</span></ToolButton>
        <ToolButton label="Kurangi inden" disabled={disabled || (inList ? !editor.can().liftListItem('listItem') : !editor.can().outdentParagraph())} onClick={() => inList ? editor.chain().focus().liftListItem('listItem').run() : editor.chain().focus().outdentParagraph().run()}><Icon name="outdent" /></ToolButton>
        <ToolButton label="Tambah inden" disabled={disabled || (inList ? !editor.can().sinkListItem('listItem') : !editor.can().indentParagraph())} onClick={() => inList ? editor.chain().focus().sinkListItem('listItem').run() : editor.chain().focus().indentParagraph().run()}><Icon name="indent" /></ToolButton>
      </div>
      <div className="tool-group">{(['left', 'center', 'right'] as const).map((align) => <ToolButton key={align} label={`Rata ${align === 'left' ? 'kiri' : align === 'center' ? 'tengah' : 'kanan'}`} active={editor.isActive({ textAlign: align }) || (align === 'left' && editor.isActive({ textAlign: null }))} disabled={disabled || !editor.can().setTextAlign(align)} onClick={() => editor.chain().focus().setTextAlign(align).run()}><Icon name={align} /></ToolButton>)}</div>
      <div className="tool-group">
        <ToolButton label="Sisipkan atau ubah tautan" active={editor.isActive('link')} disabled={disabled || !editor.can().setLink({ href: 'https://example.com' })} onClick={() => { setHref(String(editor.getAttributes('link').href || '')); setLinkOpen(!linkOpen); }}><Icon name="link" /></ToolButton>
        <ToolButton label="Sisipkan gambar lokal" disabled={disabled || !editor.can().setImage({ src: imageCapabilityProbe })} onClick={onImage}><Icon name="image" /></ToolButton>
        <ToolButton label="Menu tabel" active={tableOpen} disabled={disabled} onClick={() => setTableOpen(!tableOpen)}><Icon name="table" /></ToolButton>
        <ToolButton label="Hapus format" disabled={disabled} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().resetAttributes('paragraph', 'indent').resetAttributes('heading', 'indent').run()}><span className="clear-format">T<small>×</small></span></ToolButton>
      </div>
      <div className="tool-group last"><ToolButton label="Cari dan ganti (Ctrl/⌘ F)" disabled={disabled} onClick={onFind}><Icon name="search" /></ToolButton></div>
    </div>
    {linkOpen && <form className="inline-panel" onSubmit={(event) => { event.preventDefault(); applyLink(); }}><label htmlFor="link-url">Tautan</label><input id="link-url" autoFocus value={href} onChange={(event) => setHref(event.target.value)} placeholder="https://contoh.id" /><button disabled={disabled} type="submit">Terapkan</button><button type="button" disabled={disabled || !editor.isActive('link')} onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkOpen(false); }}>Hapus tautan</button><button type="button" onClick={() => setLinkOpen(false)}>Tutup</button></form>}
    {tableOpen && <div className="inline-panel table-menu" role="group" aria-label="Operasi tabel">
      <button type="button" disabled={disabled || editor.isActive('table') || !editor.can().insertTable({ rows: 3, cols: 3, withHeaderRow: true })} onMouseDown={(event) => event.preventDefault()} onClick={() => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); setTableOpen(false); }}>Sisipkan tabel 3 × 3</button>
      <button type="button" disabled={disabled || !editor.can().addRowAfter()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addRowAfter().run()}>+ Baris</button>
      <button type="button" disabled={disabled || !editor.can().addColumnAfter()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Kolom</button>
      <button type="button" disabled={disabled || !editor.can().deleteRow()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().deleteRow().run()}>Hapus baris</button>
      <button type="button" disabled={disabled || !editor.can().deleteColumn()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().deleteColumn().run()}>Hapus kolom</button>
      <button type="button" disabled={disabled || !editor.can().deleteTable()} onMouseDown={(event) => event.preventDefault()} onClick={() => { editor.chain().focus().deleteTable().run(); setTableOpen(false); }}>Hapus tabel</button>
      <button type="button" onClick={() => setTableOpen(false)}>Tutup</button>
    </div>}
  </div>;
}

function FindPanel({ editor, version, disabled, close, focusRequest }: { editor: Editor; version: number; disabled: boolean; close: () => void; focusRequest: number }) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [index, setIndex] = useState(-1);
  const queryInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    queryInput.current?.focus();
    queryInput.current?.select();
  }, [focusRequest]);
  const matches = useMemo(() => findMatches(editor.state.doc, query), [editor, query, version]);
  useEffect(() => { setIndex(-1); }, [query]);
  const selected = matches.findIndex((match) => editor.state.selection.from === match.from && editor.state.selection.to === match.to);
  const navigate = (direction: number) => {
    if (!matches.length) return;
    const start = selected >= 0 ? selected : index;
    const next = (start < 0 ? (direction > 0 ? 0 : matches.length - 1) : (start + direction + matches.length) % matches.length);
    setIndex(next);
    const match = matches[next];
    editor.chain().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run();
  };
  return <section className="find-panel no-print" aria-label="Cari dan ganti">
    <div className="find-row"><label htmlFor="find-query">Cari</label><input id="find-query" ref={queryInput} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Teks literal, tanpa regex" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') close(); }} /><span className="match-count" role="status">{selected >= 0 ? `${selected + 1} dari ` : ''}{matches.length} hasil</span><button type="button" disabled={disabled || !matches.length} onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(-1)} aria-label="Hasil sebelumnya">↑</button><button type="button" disabled={disabled || !matches.length} onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(1)} aria-label="Hasil berikutnya">↓</button><button type="button" aria-label="Tutup pencarian" onClick={close}><Icon name="close" /></button></div>
    <div className="find-row"><label htmlFor="replace-text">Ganti</label><input id="replace-text" value={replacement} maxLength={10000} onChange={(event) => setReplacement(event.target.value)} placeholder="Teks pengganti" /><button type="button" disabled={disabled || !matches.length} onMouseDown={(event) => event.preventDefault()} onClick={() => { const match = matches[selected >= 0 ? selected : 0]; if (match) replaceMatch(editor, match, replacement); }}>Ganti satu</button><button type="button" disabled={disabled || !matches.length} onMouseDown={(event) => event.preventDefault()} onClick={() => replaceAllMatches(editor, matches, replacement)}>Ganti semua</button><span className="find-note">Tidak membedakan huruf besar/kecil</span></div>
  </section>;
}

export default function App() {
  const theme = useTheme();
  const store = useMemo(() => new DocumentStore(), []);
  const [error, setError] = useState('');
  const extensions = useMemo(() => createExtensions((message) => setError(message)), []);
  const sessionRef = useRef<SaveSession | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const loadingEditor = useRef(false);
  const busyRef = useRef(true);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [records, setRecords] = useState<DocumentRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [listQuery, setListQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusRequest, setFindFocusRequest] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deleting, setDeleting] = useState<DocumentRecord | null>(null);
  const [backupBatches, setBackupBatches] = useState<DocumentRecord[][]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const wordInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageSelection = useRef<{ from: number; to: number; id: string } | null>(null);
  const status = sessionRef.current?.status;
  const editor = useEditor({
    extensions,
    content: emptyContent(),
    editable: false,
    editorProps: {
      attributes: { class: 'document-content', 'aria-label': 'Isi dokumen', spellcheck: 'true' },
      handleClick: (_view, _position, event) => {
        // Editing a link must never navigate away, regardless of pasted attributes.
        if ((event.target as HTMLElement).closest('a')) { event.preventDefault(); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      if (loadingEditor.current || !sessionRef.current) return;
      sessionRef.current.edit({ content: updatedEditor.getJSON() });
      scheduleSave();
    },
  });

  const notify = useCallback(() => {
    setVersion((value) => value + 1);
    const session = sessionRef.current;
    if (session) {
      const snapshot = session.snapshot;
      setRecords((items) => items.map((item) => item.id === snapshot.id ? snapshot : item));
    }
  }, []);

  function scheduleSave() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const session = sessionRef.current;
      if (session && session.status !== 'error') void session.flush().catch(() => {});
    }, 700);
  }

  const bindRecord = useCallback((record: DocumentRecord) => {
    if (!editor) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    loadingEditor.current = true;
    try {
      // A new EditorState resets history and plugin state. Undo can never cross documents.
      editor.view.updateState(EditorState.create({
        schema: editor.schema,
        doc: editor.schema.nodeFromJSON(record.content),
        plugins: editor.state.plugins,
      }));
      sessionRef.current = new SaveSession(record, (snapshot, revision) => store.save(snapshot, revision), notify);
      setActiveId(record.id);
      setTitle(record.title);
      setFindOpen(false);
      setSidebarOpen(false);
      setVersion((value) => value + 1);
      try { localStorage.setItem(selectionKey, record.id); }
      catch { setNotice('Pilihan dokumen tidak dapat diingat. Isi tetap disimpan di IndexedDB.'); }
    } finally { loadingEditor.current = false; }
  }, [editor, store, notify]);

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    async function initialize() {
      try {
        await store.seedIfEmpty();
        const items = await store.list();
        if (cancelled) return;
        setRecords(items);
        let selected: string | null = null;
        try { selected = localStorage.getItem(selectionKey); }
        catch { setNotice('Pilihan dokumen tidak dapat diingat di browser ini.'); }
        const record = items.find((item) => item.id === selected) || items[0];
        if (record) bindRecord(record);
        setReady(true);
      } catch (failure) {
        if (!cancelled) setError(`IndexedDB tidak tersedia: ${failure instanceof Error ? failure.message : String(failure)}. Tidak ada dokumen contoh yang dibuat jika database gagal dibaca.`);
      } finally {
        if (!cancelled) { busyRef.current = false; setBusy(false); }
      }
    }
    void initialize();
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
      const closingSession = sessionRef.current;
      if (closingSession?.dirty) void closingSession.flush().catch((failure) => {
        console.error('Autosave saat editor ditutup gagal. Perubahan belum tersimpan:', failure);
      });
    };
  }, [editor, store, bindRecord]);

  useEffect(() => { if (editor) editor.setEditable(ready && !!activeId && !busy, false); }, [editor, ready, activeId, busy]);
  useEffect(() => {
    if (!editor) return;
    const onTransaction = () => setVersion((value) => value + 1);
    editor.on('transaction', onTransaction);
    return () => { editor.off('transaction', onTransaction); };
  }, [editor]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (sessionRef.current?.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!busyRef.current) void sessionRef.current?.flush().catch(() => {});
      }
      if (event.key.toLowerCase() === 'f' && sessionRef.current) {
        event.preventDefault();
        setFindOpen(true);
        setFindFocusRequest((request) => request + 1);
      }
      if (event.key.toLowerCase() === 'p' && sessionRef.current) { event.preventDefault(); window.print(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keydown); };
  }, []);

  async function action(work: () => Promise<void>, flush = true) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    editor?.setEditable(false, false);
    window.clearTimeout(timer.current);
    timer.current = undefined;
    try {
      if (flush) await sessionRef.current?.flush();
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
      // Read-only/export actions must not cancel a pending debounce permanently.
      if (sessionRef.current?.dirty && sessionRef.current.status !== 'error') scheduleSave();
    }
  }

  function newRecord(content: JSONContent = emptyContent(), recordTitle = 'Dokumen tanpa judul'): DocumentRecord {
    const now = new Date().toISOString();
    return { id: createDocumentId(), title: recordTitle, content, schemaVersion: 1, createdAt: now, updatedAt: now, revision: 0 };
  }

  function download(recordsToExport: DocumentRecord[], filename: string) {
    try {
      const url = URL.createObjectURL(new Blob([serializeBackup(recordsToExport)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Cadangan dokumen diunduh. Simpan berkas ini di tempat aman; berkas dapat berisi data pribadi.');
    } catch (failure) { setError(`Ekspor gagal: ${failure instanceof Error ? failure.message : String(failure)}`); }
  }

  function downloadWord() {
    void action(async () => {
      const source = sessionRef.current?.snapshot;
      if (!source) return;
      const result = await exportDocx(source);
      const url = URL.createObjectURL(result.blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = result.filename;
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setNotice(['Dokumen Word (.docx) diunduh. Simpan cadangan aplikasi jika membutuhkan pemulihan lengkap.', ...result.warnings].join(' '));
    }, false);
  }

  async function importWord(file: File) {
    await action(async () => {
      const result = await importDocx(file);
      const imported = await store.create(newRecord(result.content, result.title));
      setRecords(await store.list());
      bindRecord(imported);
      setNotice(['Dokumen Word diimpor sebagai dokumen baru. Dokumen lama tidak ditimpa.', ...result.warnings].join(' '));
    });
  }
  function exportAll() {
    void action(async () => {
      const latest = await store.list();
      const local = sessionRef.current;
      // A dirty local version is an additional copy, never a replacement for another tab.
      const exports = local?.dirty
        ? [...latest, newRecord(local.snapshot.content, `${Array.from(local.snapshot.title).slice(0, 80).join('')} (belum tersimpan)`)]
        : latest;
      const batches: DocumentRecord[][] = [];
      let batch: DocumentRecord[] = [];
      for (const record of exports) {
        try {
          serializeBackup([...batch, record]);
          batch.push(record);
        } catch {
          if (!batch.length) throw new Error('Satu dokumen melebihi batas cadangan. Ekspor isi dokumen tersebut secara terpisah.');
          batches.push(batch);
          serializeBackup([record]);
          batch = [record];
        }
      }
      if (batch.length) batches.push(batch);
      setBackupBatches(batches.length > 1 ? batches : []);
      if (batches.length === 1) download(batches[0], 'ruang-tulis-semua.json');
      else setNotice(`Cadangan dibagi menjadi ${batches.length} berkas agar memenuhi batas data. Unduh setiap bagian di bawah.`);
    }, false);
  }


  const createDocument = () => void action(async () => {
    const record = await store.create(newRecord());
    setRecords(await store.list());
    bindRecord(record);
  });
  const openDocument = (id: string) => {
    if (id === activeId) { setSidebarOpen(false); return; }
    void action(async () => {
      const record = await store.get(id);
      if (!record) throw new Error('Dokumen telah dihapus di tab lain. Isi saat ini tetap dipertahankan.');
      bindRecord(record);
      setRecords(await store.list());
    });
  };

  async function importFile(file: File) {
    if (file.size > MAX_BACKUP_BYTES) { setError('Cadangan terlalu besar. Batas ukuran 12 MB.'); return; }
    // Read and validate while the operation lock is held; no switch can race import.
    await action(async () => {
      const documents = parseBackup(await file.text());
      // Validate and decode every embedded local image before the atomic write.
      await decodeDocumentImages(documents);
      const imported = await store.importDocuments(documents);
      setRecords(await store.list());
      if (imported[0]) bindRecord(imported[0]);
      setNotice(`${imported.length} dokumen diimpor sebagai salinan baru. Dokumen lama tidak ditimpa.`);
    });
  }

  async function insertImage(file: File) {
    const target = imageSelection.current;
    imageSelection.current = null;
    if (!editor || !target) return;
    if (busyRef.current || target.id !== activeId) {
      setError('Dokumen berubah atau operasi lain masih berjalan. Pilih gambar lagi pada dokumen yang dituju.');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      setError('Gunakan gambar PNG, JPEG, GIF, atau WebP, maksimal 2 MB. SVG tidak didukung.'); return;
    }
    await action(async () => {
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Gambar tidak dapat dibaca.'));
        reader.readAsDataURL(file);
      });
      const documentBytes = new TextEncoder().encode(JSON.stringify(editor.getJSON())).byteLength;
      if (documentBytes + source.length + 8192 > MAX_BACKUP_BYTES) throw new Error('Gambar akan melebihi batas dokumen 12 MB. Gunakan gambar lebih kecil.');
      await decodeLocalRaster(source);
      if (sessionRef.current?.snapshot.id !== target.id) throw new Error('Dokumen berubah. Pilih gambar lagi.');
      editor.chain().focus().setTextSelection({ from: target.from, to: target.to }).setImage({ src: source, alt: Array.from(file.name).slice(0, 90).join('') }).run();
    }, false);
  }

  const outline = editor ? headingOutline(editor.state.doc) : [];
  const stats = editor ? documentStats(editor.state.doc) : { words: 0, characters: 0 };
  const current = sessionRef.current?.snapshot;
  const filtered = records.filter((record) => {
    const matches = record.title.toLocaleLowerCase('id').includes(listQuery.toLocaleLowerCase('id'));
    return matches && (filter !== 'today' || new Date(record.updatedAt).toDateString() === new Date().toDateString());
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return <div className="app-shell">
    <aside className={`sidebar no-print${sidebarOpen ? ' mobile-open' : ''}`} aria-label="Daftar dokumen">
      <div className="brand"><span className="brand-mark"><Icon name="file" size={23} /></span><span>ruang<span className="brand-light">tulis</span><small>Ruang untuk ide Anda.</small></span></div>
      <button type="button" className="primary new-document" disabled={!ready || busy} onClick={createDocument}><Icon name="plus" /> Dokumen baru <span className="new-plus">+</span></button>
      <label className="document-search"><Icon name="search" size={16} /><input aria-label="Cari dokumen" placeholder="Cari dokumen..." value={listQuery} onChange={(event) => setListQuery(event.target.value)} /></label>
      <div className="list-heading"><span>DOKUMEN SAYA</span><span>{records.length}</span></div>
      <select className="document-filter" aria-label="Filter dokumen" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Semua dokumen</option><option value="today">Diubah hari ini</option></select>
      <div className="document-list">
        {filtered.map((record) => <div key={record.id} className={`document-item${activeId === record.id ? ' selected' : ''}`}>
          <button type="button" className="document-open" aria-current={activeId === record.id ? 'page' : undefined} disabled={busy} onClick={() => openDocument(record.id)}><Icon name="file" size={20} /><span><strong>{record.title}</strong><small>{dateFormat.format(new Date(record.updatedAt))}</small></span></button>
          <button type="button" className="document-delete" disabled={busy} aria-label={`Hapus ${record.title}`} title={`Hapus ${record.title}`} onClick={() => { setError(''); setDeleting(record); }}><Icon name="trash" size={16} /></button>
        </div>)}
        {ready && !filtered.length && <p className="empty-list">{records.length ? 'Tidak ada dokumen yang cocok.' : 'Belum ada dokumen. Buat dokumen baru.'}</p>}
        {!ready && <p className="empty-list">{busy ? 'Membuka penyimpanan…' : 'Penyimpanan tidak tersedia.'}</p>}
      </div>
      <div className="sidebar-backup">
        <button type="button" aria-label="Impor Word (.docx)" disabled={!ready || busy} onClick={() => wordInput.current?.click()}><Icon name="file" size={16} /> Impor Word (.docx)</button>
        <button type="button" aria-label="Impor cadangan" disabled={!ready || busy} onClick={() => importInput.current?.click()}><Icon name="upload" size={16} /> Impor cadangan</button>
        <button type="button" aria-label="Cadangkan semua dokumen" disabled={!ready || busy || !records.length} onClick={exportAll}><Icon name="download" size={16} /> Cadangkan semua dokumen</button>
      </div>
      <div className="local-disclosure"><span className="local-dot" /><strong>Lokal, bukan cloud</strong><p>Dokumen hanya di browser ini. Menghapus data browser menghapus dokumen. Ekspor cadangan untuk melindungi dokumen. Tidak ada data yang diunggah.</p></div>
    </aside>

    <main className="workspace">
      <header className="workspace-header no-print">
        <div className="breadcrumb"><button type="button" className="mobile-menu" aria-label="Buka atau tutup daftar dokumen" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="menu" /></button><span>Dokumen saya</span><Icon name="chevron" size={12} /><strong>{title || 'Pilih dokumen'}</strong></div>
        <div className="header-actions">
          <label className="theme-control"><span>Tema</span><select aria-label="Tema tampilan" value={theme.preference} onChange={(event) => theme.setPreference(event.target.value)}>
            <option value="light">Terang</option><option value="dark">Gelap</option><option value="system">Ikuti sistem</option>
          </select></label>
          <button type="button" aria-label="Unduh Word (.docx)" title="Unduh Word (.docx)" disabled={!current || busy} onClick={downloadWord}><Icon name="file" size={16} /><span>Unduh Word (.docx)</span></button>
          <button type="button" aria-label="Unduh cadangan" disabled={!current || busy} onClick={() => current && download([current], 'ruang-tulis-dokumen.json')}><Icon name="download" size={16} /><span>Unduh cadangan</span></button>
          <button type="button" aria-label="Cetak / PDF" disabled={!current || busy} onClick={() => window.print()}><Icon name="print" size={16} /><span>Cetak / PDF</span></button>
        </div>
      </header>
      {theme.sessionOnly && <div className="message notice-message theme-notice no-print" role="status" aria-label="Pemberitahuan tema">Preferensi tema tidak dapat disimpan di browser ini. Pilihan tema hanya berlaku untuk sesi ini.</div>}
      <section className="document-heading no-print">
        <div className="title-area"><label className="eyebrow" htmlFor="document-title">DOKUMEN · UBAH NAMA</label><input id="document-title" aria-label="Judul dokumen / ubah nama" value={title} placeholder="Dokumen tanpa judul" maxLength={200} disabled={!current || busy} onChange={(event) => {
          setTitle(event.target.value);
          sessionRef.current?.edit({ title: event.target.value.trim() || 'Dokumen tanpa judul' });
          scheduleSave();
        }} onBlur={() => { if (!title.trim()) setTitle('Dokumen tanpa judul'); }} /></div>
        <div className={`save-indicator ${status || ''}`} role="status" aria-live="polite">{status === 'saved' ? <><Icon name="check" size={16} />Tersimpan di browser</> : status === 'error' ? <><span className="status-dot" />Gagal menyimpan</> : status ? <><span className="status-dot" />Menyimpan…</> : 'Belum ada dokumen'}</div>
      </section>
      {error && <div className="message error-message no-print" role="alert"><div><strong>Operasi gagal.</strong> {error}</div><button type="button" aria-label="Tutup pesan kesalahan" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
      {status === 'error' && <div className="message save-error no-print" role="alert"><div><strong>Isi belum tersimpan.</strong><p>{sessionRef.current?.error}</p><p>Versi Anda tetap di editor. Ekspor cadangan atau simpan sebagai dokumen baru. Perubahan dari tab lain tidak akan ditimpa.</p></div><div className="recovery-actions"><button type="button" disabled={busy} onClick={() => void action(async () => { await sessionRef.current?.flush(); }, false)}>Coba lagi</button><button type="button" disabled={!current} onClick={() => current && download([current], 'ruang-tulis-belum-tersimpan.json')}>Ekspor isi ini</button><button type="button" disabled={busy || !current} onClick={() => void action(async () => {
        const source = sessionRef.current?.snapshot;
        if (!source) return;
        const copy = await store.create(newRecord(source.content, `${Array.from(source.title).slice(0, 85).join('')} (salinan)`));
        setRecords(await store.list());
        bindRecord(copy);
        setNotice('Isi dipertahankan sebagai dokumen baru. Versi lama tidak ditimpa.');
      }, false)}>Simpan sebagai salinan</button></div></div>}
      {notice && <div className="message notice-message no-print" role="status"><span>{notice}</span><button type="button" aria-label="Tutup pemberitahuan" onClick={() => setNotice('')}><Icon name="close" size={16} /></button></div>}
      {!!backupBatches.length && <section className="message notice-message no-print" aria-label="Bagian cadangan dokumen"><div><strong>Unduh semua bagian untuk cadangan lengkap.</strong><div className="recovery-actions">{backupBatches.map((batch, index) => <button type="button" key={index} onClick={() => download(batch, `ruang-tulis-bagian-${index + 1}.json`)}>Bagian {index + 1} · {batch.length} dokumen</button>)}</div></div><button type="button" aria-label="Tutup daftar cadangan" onClick={() => setBackupBatches([])}><Icon name="close" size={16} /></button></section>}
      {editor && current && <Toolbar key={`toolbar-${activeId}`} editor={editor} disabled={busy} onError={setError} onFind={() => {
        setFindOpen(!findOpen);
        if (!findOpen) setFindFocusRequest((request) => request + 1);
      }} onImage={() => {
        imageSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to, id: current.id };
        imageInput.current?.click();
      }} />}
      {editor && current && findOpen && <FindPanel key={`find-${activeId}`} editor={editor} version={version} disabled={busy} focusRequest={findFocusRequest} close={() => setFindOpen(false)} />}
      <div className="writing-area">
        <div className="paper-wrap">
          <div className="paper-meta no-print"><span>A4 · DOKUMEN LOKAL</span><span>Fokus pada kata-kata Anda</span></div>
          {current ? <article className="document-paper" aria-label="Halaman dokumen" onClickCapture={(event) => { if ((event.target as HTMLElement).closest('a')) event.preventDefault(); }} onAuxClickCapture={(event) => { if ((event.target as HTMLElement).closest('a')) event.preventDefault(); }}><EditorContent editor={editor} /></article> : <div className="welcome-state no-print"><Icon name="file" size={40} /><h1>Tempat ide menjadi tulisan.</h1><p>Buat dokumen baru untuk mulai menulis. Dokumen disimpan secara lokal di browser ini.</p><button type="button" className="primary" disabled={!ready || busy} onClick={createDocument}>Buat dokumen pertama</button>{!ready && !busy && <button type="button" onClick={() => window.location.reload()}>Coba buka penyimpanan lagi</button>}</div>}
          <p className="print-hint no-print">Cetak / PDF membuka dialog browser. Pilih “Simpan sebagai PDF” untuk membuat PDF.</p>
        </div>
        {current && <aside className="outline no-print" aria-label="Kerangka dokumen"><h2>KERANGKA</h2>{outline.length ? <nav aria-label="Navigasi judul">{outline.map((heading) => <button type="button" key={heading.position} style={{ paddingLeft: `${(heading.level - 1) * 12 + 10}px` }} disabled={busy} onClick={() => {
          if (!editor) return;
          const position = Math.min(heading.position + 1, editor.state.doc.content.size);
          editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)).scrollIntoView());
          editor.view.focus();
        }}>{heading.text || 'Judul kosong'}</button>)}</nav> : <p>Judul 1–3 akan muncul di sini.</p>}<div className="shortcut-card"><span>PINTASAN</span><p><kbd>Ctrl / ⌘ S</kbd> Simpan</p><p><kbd>Ctrl / ⌘ F</kbd> Cari & ganti</p><p><kbd>Ctrl / ⌘ Z</kbd> Urungkan</p><p><kbd>Ctrl / ⌘ B</kbd> Tebal</p></div></aside>}
      </div>
      <footer className="status-bar no-print"><span>{stats.words.toLocaleString('id-ID')} kata <span className="status-separator">·</span> {stats.characters.toLocaleString('id-ID')} karakter</span><span>Bahasa Indonesia <span className="status-separator">·</span> Penyimpanan lokal</span></footer>
    </main>
    <input className="visually-hidden" ref={wordInput} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Pilih dokumen Word (.docx)" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importWord(file); }} />
    <input className="visually-hidden" ref={importInput} type="file" accept=".json,application/json" aria-label="Pilih cadangan dokumen" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
    <input className="visually-hidden" ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Pilih gambar lokal" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void insertImage(file); }} />
    {deleting && <div className="modal-backdrop no-print" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape' && !busy) setDeleting(null);
      if (event.key === 'Tab') {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description"><span className="danger-icon"><Icon name="trash" size={26} /></span><h2 id="delete-title">Hapus dokumen?</h2><p id="delete-description">“{deleting.title}” akan dihapus dari browser ini, termasuk perubahan yang belum tersimpan. Tindakan ini tidak dapat dibatalkan. Ekspor cadangan jika ingin menyimpan salinannya.</p>{error && <p className="dialog-error" role="alert">{error}</p>}<div><button type="button" autoFocus disabled={busy} onClick={() => setDeleting(null)}>Batal</button><button type="button" className="danger-button" disabled={busy} onClick={() => {
      const target = deleting;
      void action(async () => {
        const deletingSession = sessionRef.current;
        if (target.id === deletingSession?.snapshot.id) {
          // Wait for every queued write before deleting. An explicitly confirmed
          // discard is allowed after a quota error; the revision check still
          // protects a newer version written in another tab.
          try { await deletingSession.flush(); } catch { /* Confirmed discard. */ }
        }
        const expected = target.id === sessionRef.current?.snapshot.id ? sessionRef.current.snapshot.revision : target.revision;
        await store.delete(target.id, expected);
        setRecords((items) => items.filter((item) => item.id !== target.id));
        setDeleting(null);
        if (target.id === activeId) {
          sessionRef.current = null;
          setActiveId(null);
          setTitle('');
          loadingEditor.current = true;
          try {
            if (editor) editor.view.updateState(EditorState.create({
              schema: editor.schema,
              doc: editor.schema.nodeFromJSON(emptyContent()),
              plugins: editor.state.plugins,
            }));
          } finally { loadingEditor.current = false; }
          try { localStorage.removeItem(selectionKey); } catch { setNotice('Pilihan dokumen lama tidak dapat dihapus dari preferensi browser.'); }
        }
        const items = await store.list();
        setRecords(items);
        if (target.id === activeId && items[0]) bindRecord(items[0]);
      }, false);
    }}>Ya, hapus dokumen</button></div></section></div>}
  </div>;
}
