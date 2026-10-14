import { Extension, Mark, mergeAttributes, type Attributes, type Command, type Editor, type Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import StarterKit from '@tiptap/starter-kit';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { isSafeImage, isSafeLink, MAX_BACKUP_BYTES, validateContent } from './data';

const INDENT_STEP_PX = 24;
const MAX_INDENT = 8;
const MAX_IMAGE_DIMENSION = 10000;
const DOCUMENT_METADATA_RESERVE_BYTES = 8192;
const SAFE_LINK_REL = 'noopener noreferrer nofollow';

function isSafeEditorLink(url: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(url) && isSafeLink(url);
}

const SafeStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      if (extension.name !== 'link' || !(extension instanceof Mark)) return extension;
      return extension.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            class: {
              default: null,
              parseHTML: () => null,
              renderHTML: () => ({}),
            },
            target: {
              default: '_blank',
              parseHTML: () => '_blank',
            },
            rel: {
              default: SAFE_LINK_REL,
              parseHTML: () => SAFE_LINK_REL,
            },
          };
        },
      });
    });
  },
});

function safeImageDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_IMAGE_DIMENSION
    ? value
    : null;
}

const SafeImage = Image.extend({
  addAttributes() {
    const attributes: Attributes = this.parent?.() ?? {};
    for (const name of ['width', 'height']) {
      attributes[name] = {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute(name);
          return value && /^\d+$/.test(value) ? safeImageDimension(Number(value)) : null;
        },
        renderHTML: (values) => {
          const dimension = safeImageDimension(values[name]);
          return dimension === null ? {} : { [name]: dimension };
        },
      };
    }
    return attributes;
  },

  parseHTML() {
    return [{
      tag: 'img[src]',
      getAttrs: (element) => {
        const src = element.getAttribute('src');
        return src !== null && isSafeImage(src) ? null : false;
      },
    }];
  },

  renderHTML({ HTMLAttributes }) {
    const attributes = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    if (!isSafeImage(attributes.src)) delete attributes.src;
    return ['img', attributes];
  },

  addCommands() {
    return {
      setImage: (attributes) => ({ commands }) => {
        if (!isSafeImage(attributes.src)) return false;
        if (
          (attributes.width != null && safeImageDimension(attributes.width) === null) ||
          (attributes.height != null && safeImageDimension(attributes.height) === null)
        ) return false;
        return commands.insertContent({ type: this.name, attrs: attributes });
      },
    };
  },

  // The upstream Markdown input rule inserts directly and bypasses setImage.
  // HTML parsing and the validated command are the supported insertion paths.
  addInputRules() {
    return [];
  },
});

function boundedIndent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_INDENT, Math.round(value)))
    : 0;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphIndent: {
      indentParagraph: () => ReturnType;
      outdentParagraph: () => ReturnType;
    };
  }
}

export const ParagraphIndent = Extension.create({
  name: 'paragraphIndent',

  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        indent: {
          default: 0,
          parseHTML: (element) => {
            const margin = element.style.marginLeft;
            if (!/^\d+(?:\.\d+)?px$/i.test(margin)) return 0;
            return boundedIndent(Number.parseFloat(margin) / INDENT_STEP_PX);
          },
          renderHTML: (attributes) => {
            const indent = boundedIndent(attributes.indent);
            return indent ? { style: `margin-left: ${indent * INDENT_STEP_PX}px` } : {};
          },
        },
      },
    }];
  },

  addCommands() {
    const changeIndent = (direction: number) =>
      (): Command => ({ tr, dispatch }) => {
        const changes: { position: number; node: ProseMirrorNode; indent: number }[] = [];
        const { from, to } = tr.selection;
        tr.doc.nodesBetween(from, to, (node, position) => {
          if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
          const current = boundedIndent(node.attrs.indent);
          const indent = boundedIndent(current + direction);
          if (indent !== current) changes.push({ position, node, indent });
          return false;
        });
        if (!changes.length) return false;
        if (dispatch) {
          changes.forEach(({ position, node, indent }) => {
            tr.setNodeMarkup(position, undefined, { ...node.attrs, indent });
          });
        }
        return true;
      };
    return {
      indentParagraph: changeIndent(1),
      outdentParagraph: changeIndent(-1),
    };
  },
});

const EditorShortcuts = Extension.create({
  name: 'editorShortcuts',
  priority: 1100,

  addKeyboardShortcuts() {
    return {
      // The application owns saving; consume the browser's Save Page shortcut.
      'Mod-s': () => true,
      'Mod-]': () => this.editor.commands.indentParagraph(),
      'Mod-[': () => this.editor.commands.outdentParagraph(),
      Enter: () => {
        const { selection } = this.editor.state;
        const { $from } = selection;
        if (
          !(selection instanceof TextSelection) || !selection.empty ||
          $from.parent.type.name !== 'heading' ||
          $from.parentOffset !== $from.parent.content.size
        ) return false;
        // List items retain StarterKit's splitListItem and empty-item fallback.
        for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
          if ($from.node(depth).type.name === 'listItem') return false;
        }
        return this.editor.chain().command(({ commands, tr }) => {
          if (!commands.splitBlock()) return false;
          const { $from: cursor } = tr.selection;
          const paragraph = this.editor.schema.nodes.paragraph;
          if (cursor.parent.type !== paragraph) tr.setNodeMarkup(cursor.before(), paragraph);
          // splitBlock already produces a paragraph at a heading's end. Calling
          // setParagraph on it can return false after dispatch and let another
          // Enter keymap split the new paragraph a second time.
          return true;
        }).run();
      },
    };
  },
});

interface DocumentLimitsOptions {
  onRejected?: (message: string) => void;
}

const DocumentLimits = Extension.create<DocumentLimitsOptions>({
  name: 'documentLimits',

  addOptions() {
    return { onRejected: undefined };
  },

  addProseMirrorPlugins() {
    const encoder = new TextEncoder();
    return [new Plugin({
      key: new PluginKey('documentLimits'),
      filterTransaction: (transaction) => {
        if (!transaction.docChanged) return true;
        try {
          const content = transaction.doc.toJSON();
          const bytes = encoder.encode(JSON.stringify(content)).byteLength;
          if (bytes > MAX_BACKUP_BYTES - DOCUMENT_METADATA_RESERVE_BYTES) {
            throw new Error('Document content exceeds the storage limit including metadata reserve.');
          }
          validateContent(content);
          return true;
        } catch {
          this.options.onRejected?.(
            'Perubahan ditolak karena isi dokumen tidak valid atau melebihi batas penyimpanan. Isi sebelumnya tetap dipertahankan.',
          );
          return false;
        }
      },
    })];
  },
});

export function createExtensions(onRejected?: (message: string) => void): Extensions {
  return [
    SafeStarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Enter owns the paragraph after a final heading. Keep automatic trailing
      // paragraphs for images and tables without pre-inserting one for headings.
      trailingNode: { notAfter: ['heading'] },
      link: {
        openOnClick: false,
        enableClickSelection: false,
        autolink: false,
        protocols: ['http', 'https', 'mailto'],
        // protocols extends Link's default allowlist rather than restricting it.
        // isAllowedUri enforces the allowlist for parsing, rendering and commands.
        isAllowedUri: isSafeEditorLink,
        validate: isSafeEditorLink,
        shouldAutoLink: isSafeEditorLink,
      },
    }),
    SafeImage.configure({ allowBase64: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    ParagraphIndent,
    EditorShortcuts,
    DocumentLimits.configure({ onRejected }),
  ];
}

export interface Match {
  from: number;
  to: number;
}

/** Literal, nonoverlapping, case-insensitive matches in ProseMirror positions. */
export function findMatches(doc: ProseMirrorNode, query: string): Match[] {
  if (!query) return [];
  // A quoted regex retains UTF-16 offsets, unlike lowercasing strings whose
  // length can change during Unicode case conversion (for example, İ).
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const matches: Match[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    let run = '';
    let runStart = 0;
    const flush = () => {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(run)) !== null) {
        matches.push({ from: runStart + match.index, to: runStart + match.index + match[0].length });
      }
      run = '';
    };
    node.forEach((child, offset) => {
      if (!child.isText) {
        flush();
        return;
      }
      if (!run) runStart = position + 1 + offset;
      run += child.text;
    });
    flush();
    // Nontext inline nodes are boundaries even if they contain their own text.
    return false;
  });
  return matches;
}

function isTextMatch(doc: ProseMirrorNode, match: Match): boolean {
  const { from, to } = match;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > doc.content.size) return false;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock || !$from.nodeAfter?.isText) return false;
  let onlyText = true;
  $from.parent.nodesBetween($from.parentOffset, $to.parentOffset, (node) => {
    if (!node.isText) onlyText = false;
    return false;
  });
  return onlyText;
}

export function replaceMatch(editor: Editor, match: Match, replacement: string): boolean {
  return replaceAllMatches(editor, [match], replacement);
}

/** Apply a snapshot of matches in one transaction, without shifting later ranges. */
export function replaceAllMatches(editor: Editor, matches: Match[], replacement: string): boolean {
  if (editor.isDestroyed || !matches.length) return false;
  const state = editor.state;
  const { doc, schema } = state;
  const sorted = [...matches].sort((left, right) => right.from - left.from);
  for (let index = 0; index < sorted.length; index += 1) {
    if (!isTextMatch(doc, sorted[index])) return false;
    if (index > 0 && sorted[index].to > sorted[index - 1].from) return false;
  }
  const tr = state.tr;
  sorted.forEach(({ from, to }) => {
    if (!replacement) {
      tr.delete(from, to);
    } else {
      // nodeAfter is the text being replaced, not the preceding character or
      // the selection's stored marks. Read each start from the original doc.
      const marks = doc.resolve(from).nodeAfter!.marks;
      tr.replaceWith(from, to, schema.text(replacement, marks));
    }
  });
  editor.view.dispatch(tr);
  return editor.state !== state;
}

export function headingOutline(doc: ProseMirrorNode): { position: number; level: number; text: string }[] {
  const headings: { position: number; level: number; text: string }[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === 'heading') headings.push({ position, level: node.attrs.level, text: node.textContent });
  });
  return headings;
}

/** Characters exclude structural separators; word boundaries include them. */
export function documentStats(doc: ProseMirrorNode): { words: number; characters: number } {
  const text = doc.textBetween(0, doc.content.size, ' ', ' ').trim();
  return { words: text ? text.split(/\s+/).length : 0, characters: doc.textContent.length };
}
