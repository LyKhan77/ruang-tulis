// @vitest-environment jsdom
import { Editor, Node as TiptapNode, type JSONContent } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExtensions,
  documentStats,
  findMatches,
  headingOutline,
  replaceAllMatches,
  replaceMatch,
} from './editor';
import { validateContent } from './data';
import { pngDataUrl, TINY_PNG } from './raster-fixtures';

const editors: Editor[] = [];
const modKey: KeyboardEventInit = /Mac|iP(hone|ad|od)/.test(navigator.platform)
  ? { metaKey: true }
  : { ctrlKey: true };

function createEditor(content: string | JSONContent = '<p></p>', onRejected?: (message: string) => void): Editor {
  const editor = new Editor({
    extensions: createExtensions(onRejected),
    content,
    // jsdom has no layout; skip only scroll geometry, not keyboard behavior.
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  return editor;
}

// Exercise the registered ProseMirror keymaps, not a substitute command.
function pressKey(editor: Editor, key: string, modifiers: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  return Boolean(editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event)));
}

function textRuns(editor: Editor): { text: string; marks: string[] }[] {
  const runs: { text: string; marks: string[] }[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText) runs.push({ text: node.text!, marks: node.marks.map((mark) => mark.type.name) });
  });
  return runs;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe('createExtensions', () => {
  it('uses the StarterKit link and underline once and limits headings to levels 1–3', () => {
    const editor = createEditor('<p><u>underlined</u></p>');
    const names = editor.extensionManager.extensions.map((extension) => extension.name);
    expect(names.filter((name) => name === 'link')).toHaveLength(1);
    expect(names.filter((name) => name === 'underline')).toHaveLength(1);
    expect(textRuns(editor)).toEqual([{ text: 'underlined', marks: ['underline'] }]);
    expect(editor.commands.setHeading({ level: 3 })).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.level).toBe(3);
    expect(editor.commands.setHeading({ level: 4 })).toBe(false);
    expect(editor.state.doc.firstChild?.attrs.level).toBe(3);
  });

  it.each(['http://example.com', 'https://example.com/a?q=1', 'mailto:reader@example.com'])(
    'accepts a safe link: %s',
    (href) => {
      const editor = createEditor('<p>link</p>');
      editor.commands.setTextSelection({ from: 1, to: 5 });
      expect(editor.commands.setLink({ href })).toBe(true);
      expect(editor.state.doc.firstChild?.firstChild?.marks[0].attrs.href).toBe(href);
    },
  );

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'ftp://example.com', 'tel:123', '//example.com', 'java\nscript:alert(1)'])(
    'rejects an unsafe link in both commands and HTML: %s',
    (href) => {
      const editor = createEditor(`<p><a href="${href}">link</a></p>`);
      expect(textRuns(editor)).toEqual([{ text: 'link', marks: [] }]);
      editor.commands.setTextSelection({ from: 1, to: 5 });
      expect(editor.commands.setLink({ href })).toBe(false);
      expect(editor.getHTML()).not.toContain('href=');
    },
  );

  it('does not autolink typed URLs or enable link click navigation/selection', () => {
    const editor = createEditor();
    editor.commands.insertContent('https://example.com ');
    expect(textRuns(editor)).toEqual([{ text: 'https://example.com ', marks: [] }]);
    const link = editor.extensionManager.extensions.find((extension) => extension.name === 'link');
    expect(link?.options.openOnClick).toBe(false);
    expect(link?.options.enableClickSelection).toBe(false);
  });

  it('parses and inserts bounded raster image data URLs', () => {
    const src = TINY_PNG;
    const editor = createEditor(`<p>before</p><img src="${src}" alt="local">`);
    expect(editor.state.doc.child(1).type.name).toBe('image');
    expect(editor.state.doc.child(1).attrs.src).toBe(src);
    expect(editor.getHTML()).toContain(`src="${src}"`);
    editor.commands.setTextSelection(1);
    expect(editor.commands.setImage({ src, alt: 'inserted' })).toBe(true);
    expect(editor.getHTML()).toContain('alt="inserted"');
  });

  it('allows the application image availability probe without decoding or mutating content', () => {
    const editor = createEditor('<p>body</p>');
    const before = editor.getJSON();
    expect(editor.can().setImage({ src: TINY_PNG })).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it('parses valid image dimensions as numbers and ignores unsafe dimension strings', () => {
    const src = TINY_PNG;
    const editor = createEditor(`<img src="${src}" width="320" height="240"><img src="${src}" width="100%" height="999999999">`);
    expect(editor.state.doc.child(0).attrs.width).toBe(320);
    expect(editor.state.doc.child(0).attrs.height).toBe(240);
    expect(editor.state.doc.child(1).attrs.width).toBeNull();
    expect(editor.state.doc.child(1).attrs.height).toBeNull();
    expect(editor.getHTML()).not.toContain('100%');
    expect(editor.getHTML()).not.toContain('999999999');
  });

  it('rejects unsafe image dimensions supplied to the insertion command', () => {
    const editor = createEditor();
    const src = TINY_PNG;
    const before = editor.getJSON();
    expect(editor.commands.setImage({ src, width: -1 })).toBe(false);
    expect(editor.commands.setImage({ src, height: 12.5 })).toBe(false);
    expect(editor.commands.setImage({ src, width: 10001 })).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it.each([
    'javascript:alert(1)',
    'file:///tmp/image.png',
    'https://example.com/image.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,not-valid!',
    'data:image/png;base64,',
    'data:image/png;base64,AB==',
    'data:image/png;base64,AAAA\n',
    'data:image/png;base64,AAAA',
  ])('rejects unsafe or malformed image sources: %s', (src) => {
    const editor = createEditor(`<p>safe</p><img src="${src}">`);
    expect(editor.getHTML()).not.toContain('<img');
    expect(editor.commands.setImage({ src })).toBe(false);
    expect(editor.getHTML()).not.toContain('<img');
  });

  it('rejects oversized image data URLs before parsing or insertion', () => {
    const src = pngDataUrl({ byteLength: 2 * 1024 * 1024 + 1 });
    const editor = createEditor(`<p>safe</p><img src="${src}">`);
    expect(editor.getHTML()).not.toContain('<img');
    expect(editor.commands.setImage({ src })).toBe(false);
  });

  it('accepts the decoded image size limit, not a smaller encoded-text limit', () => {
    const src = pngDataUrl({ byteLength: 2 * 1024 * 1024 });
    const editor = createEditor();
    expect(editor.commands.setImage({ src })).toBe(true);
    expect(editor.getHTML()).toContain(`src="${src}"`);
  });

  it('does not render an unsafe image source supplied through JSON', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'image', attrs: { src: 'javascript:alert(1)' } }] });
    expect(editor.getHTML()).not.toContain('javascript:');
  });

  it('normalizes pasted link classes without adding a second link extension', () => {
    const editor = createEditor('<p><a href="https://example.com" class="pasted arbitrary-class">link</a></p>');
    const link = editor.state.doc.firstChild?.firstChild?.marks.find((mark) => mark.type.name === 'link');
    expect(link?.attrs.class).toBeNull();
    expect(editor.getHTML()).not.toContain('class=');
    expect(editor.extensionManager.extensions.filter((extension) => extension.name === 'link')).toHaveLength(1);
  });

  it('accepts supported HTML edits while normalizing pasted link class, target, and rel attributes', () => {
    const messages: string[] = [];
    const editor = createEditor('<p>before</p>', (message) => messages.push(message));
    editor.commands.insertContentAt(7, '<a href="https://example.com" class="website-link" target="arbitrary-window" rel="unknown-relation">link</a>');
    const links: Record<string, unknown>[] = [];
    editor.state.doc.descendants((node) => {
      node.marks.forEach((mark) => {
        if (mark.type.name === 'link') links.push(mark.attrs);
      });
    });
    expect(editor.state.doc.textContent).toBe('beforelink');
    expect(links).toEqual([expect.objectContaining({
      href: 'https://example.com',
      class: null,
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
    })]);
    expect(messages).toEqual([]);
    expect(() => validateContent(editor.getJSON())).not.toThrow();
  });

  it('emits storage-valid JSON for paragraphs, headings, ordered lists, links, images, and tables', () => {
    const editor = createEditor(
      '<p>body <a href="https://example.com" class="untrusted">link</a></p>' +
      '<h2 style="margin-left: 48px">heading</h2>' +
      '<ol><li><p>item</p></li></ol>' +
      `<img src="${TINY_PNG}" width="64" height="32">` +
      '<table><tbody><tr><th>Header</th></tr><tr><td>Cell</td></tr></tbody></table>',
    );
    const emitted = editor.getJSON();
    expect(emitted.content?.map((node) => node.type)).toEqual(expect.arrayContaining(['paragraph', 'heading', 'orderedList', 'image', 'table']));
    expect(() => validateContent(emitted)).not.toThrow();
  });

  it('provides all table nodes and paragraph/heading text alignment', () => {
    const editor = createEditor('<p>body</p><h2>heading</h2>');
    editor.commands.setTextSelection({ from: 1, to: 13 });
    expect(editor.commands.setTextAlign('center')).toBe(true);
    expect(editor.state.doc.child(0).attrs.textAlign).toBe('center');
    expect(editor.state.doc.child(1).attrs.textAlign).toBe('center');
    expect(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })).toBe(true);
    let table = editor.state.doc.firstChild;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'table') table = node;
    });
    expect(table?.type.name).toBe('table');
    expect(table?.child(0).type.name).toBe('tableRow');
    expect(table?.child(0).child(0).type.name).toBe('tableHeader');
    expect(table?.child(1).child(0).type.name).toBe('tableCell');
  });
});

describe('ParagraphIndent', () => {
  it('round-trips paragraph and heading indentation through margin-left', () => {
    const editor = createEditor('<p style="margin-left: 48px">body</p><h2 style="margin-left: 24px">title</h2>');
    expect(editor.state.doc.child(0).attrs.indent).toBe(2);
    expect(editor.state.doc.child(1).attrs.indent).toBe(1);
    editor.commands.setTextSelection({ from: 1, to: 12 });
    expect(editor.commands.indentParagraph()).toBe(true);
    expect(editor.state.doc.child(0).attrs.indent).toBe(3);
    expect(editor.state.doc.child(1).attrs.indent).toBe(2);
    expect(editor.getHTML()).toContain('margin-left: 72px');
    expect(editor.commands.outdentParagraph()).toBe(true);
    expect(editor.state.doc.child(0).attrs.indent).toBe(2);
    expect(editor.state.doc.child(1).attrs.indent).toBe(1);
  });

  it('bounds indentation at 0–8 and reports unavailable changes without mutation', () => {
    const editor = createEditor('<p>body</p>');
    expect(editor.commands.outdentParagraph()).toBe(false);
    expect(editor.getHTML()).not.toContain('margin-left');
    for (let step = 0; step < 8; step += 1) expect(editor.commands.indentParagraph()).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.indent).toBe(8);
    const before = editor.getJSON();
    expect(editor.commands.indentParagraph()).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.can().outdentParagraph()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it('clamps imported margins and ignores negative or unsupported margins', () => {
    const editor = createEditor('<p style="margin-left: 999px">a</p><p style="margin-left: -24px">b</p><p style="margin-left: 10%">c</p>');
    expect(editor.state.doc.child(0).attrs.indent).toBe(8);
    expect(editor.state.doc.child(1).attrs.indent).toBe(0);
    expect(editor.state.doc.child(2).attrs.indent).toBe(0);
  });

  it('does not indent unrelated block types', () => {
    const editor = createEditor('<pre><code>code</code></pre>');
    editor.commands.setTextSelection(2);
    expect(editor.commands.indentParagraph()).toBe(false);
    expect(editor.state.doc.firstChild?.attrs.indent).toBeUndefined();
  });
});

describe('keyboard shortcuts', () => {
  it.each([1, 2, 3])('switches explicitly to a paragraph when Enter is pressed at the end of heading %i', (level) => {
    const editor = createEditor(`<h${level}>Title</h${level}>`);
    expect(editor.state.doc.childCount).toBe(1);
    editor.commands.setTextSelection(6);
    // Selecting a final heading must not pre-insert an automatic blank paragraph.
    expect(editor.state.doc.childCount).toBe(1);
    expect(pressKey(editor, 'Enter')).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).type.name).toBe('heading');
    expect(editor.state.doc.child(0).textContent).toBe('Title');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.parent.textContent).toBe('');
    expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1);
    expect(editor.commands.insertContent('Body')).toBe(true);
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('Body');
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe('Title');
    expect(editor.state.selection.$from.index(0)).toBe(1);
  });

  it('inserts the new paragraph adjacent to a heading without moving existing following text', () => {
    const editor = createEditor('<h2>Title</h2><p>Existing body</p>');
    editor.commands.setTextSelection(6);
    expect(editor.state.doc.childCount).toBe(2);
    expect(pressKey(editor, 'Enter')).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1);
    expect(editor.commands.insertContent('Body')).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe('Title');
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('Body');
    expect(editor.state.doc.child(2).textContent).toBe('Existing body');
    expect(editor.state.doc.childCount).toBe(3);
  });

  it.each(['image', 'table'] as const)('still adds an accessible trailing paragraph after a final %s', (type) => {
    const content: JSONContent = type === 'image'
      ? { type: 'doc', content: [{ type: 'image', attrs: { src: TINY_PNG } }] }
      : { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] }] }] };
    const editor = createEditor(content);
    // TrailingNode deliberately runs on any transaction, including a meta-only one.
    expect(editor.commands.command(({ tr }) => { tr.setMeta('trailingNodeRegression', true); return true; })).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).type.name).toBe(type);
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.lastChild?.textContent).toBe('');
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
    expect(editor.commands.insertContent('After block')).toBe(true);
    expect(editor.state.doc.child(1).textContent).toBe('After block');
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('retains heading behavior for Enter in the middle of a heading', () => {
    const editor = createEditor('<h2>Title</h2>');
    editor.commands.setTextSelection(3);
    expect(pressKey(editor, 'Enter')).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe('Ti');
    expect(editor.state.selection.$from.parent.type.name).toBe('heading');
    expect(editor.state.selection.$from.parent.textContent).toBe('tle');
  });

  it.each(['bulletList', 'orderedList'])('uses the standard Enter fallback to leave an empty %s', (type) => {
    const editor = createEditor({ type: 'doc', content: [{ type, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] });
    editor.commands.setTextSelection(3);
    expect(pressKey(editor, 'Enter')).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.isActive(type)).toBe(false);
  });

  it('still splits a nonempty list item with Enter', () => {
    const editor = createEditor('<ul><li><p>item</p></li></ul>');
    editor.commands.setTextSelection(7);
    expect(pressKey(editor, 'Enter')).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe('bulletList');
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.isActive('listItem')).toBe(true);
  });

  it('consumes Mod-s without modifying the document', () => {
    const editor = createEditor('<p>unsaved</p>');
    const before = editor.getJSON();
    expect(pressKey(editor, 's', modKey)).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it('supports basic mark shortcuts and indentation shortcuts', () => {
    const editor = createEditor('<p>text</p>');
    editor.commands.setTextSelection({ from: 1, to: 5 });
    expect(pressKey(editor, 'b', modKey)).toBe(true);
    expect(pressKey(editor, 'i', modKey)).toBe(true);
    expect(pressKey(editor, 'u', modKey)).toBe(true);
    expect(textRuns(editor)[0].marks).toEqual(expect.arrayContaining(['bold', 'italic', 'underline']));
    expect(pressKey(editor, ']', modKey)).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.indent).toBe(1);
    expect(pressKey(editor, '[', modKey)).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.indent).toBe(0);
  });
});

describe('findMatches', () => {
  it('finds case-insensitive matches across adjacent text with different marks', () => {
    const editor = createEditor('<p><strong>ab</strong><em>CD</em>ef</p>');
    expect(findMatches(editor.state.doc, 'bCdE')).toEqual([{ from: 2, to: 6 }]);
    expect(findMatches(editor.state.doc, 'abcdef')).toEqual([{ from: 1, to: 7 }]);
  });

  it('recomputes positions from the current document after edits', () => {
    const editor = createEditor('<p><strong>ab</strong><em>CD</em>ef</p>');
    editor.commands.insertContentAt(1, 'z');
    expect(findMatches(editor.state.doc, 'bcde')).toEqual([{ from: 3, to: 7 }]);
    editor.commands.deleteRange({ from: 1, to: 3 });
    expect(findMatches(editor.state.doc, 'bcde')).toEqual([{ from: 1, to: 5 }]);
  });

  it('does not match across paragraphs, headings, hard breaks, or other block boundaries', () => {
    const editor = createEditor('<p>foo<br>bar</p><h2>baz</h2><blockquote><p>qux</p></blockquote>');
    expect(findMatches(editor.state.doc, 'foobar')).toEqual([]);
    expect(findMatches(editor.state.doc, 'barbaz')).toEqual([]);
    expect(findMatches(editor.state.doc, 'bazqux')).toEqual([]);
    expect(findMatches(editor.state.doc, 'bar')).toEqual([{ from: 5, to: 8 }]);
  });

  it('does not match across an inline nontext atom', () => {
    const atom = TiptapNode.create({
      name: 'testAtom', inline: true, group: 'inline', atom: true,
      renderHTML: () => ['span', { 'data-atom': 'true' }],
    });
    const editor = new Editor({
      extensions: [...createExtensions(), atom],
      editorProps: { handleScrollToSelection: () => true },
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo' }, { type: 'testAtom' }, { type: 'text', text: 'bar' }] }] },
    });
    editors.push(editor);
    expect(findMatches(editor.state.doc, 'foobar')).toEqual([]);
    expect(findMatches(editor.state.doc, 'bar')).toEqual([{ from: 5, to: 8 }]);
  });

  it.each(['.', '[x]', '(a)+', '$5?', '\\path', '^end', '|pipe|'])(
    'treats regex syntax literally: %s',
    (query) => {
      const editor = createEditor('<p>a.b [x] (a)+ $5? \\path ^end |pipe|</p>');
      const matches = findMatches(editor.state.doc, query);
      expect(matches).toHaveLength(1);
      expect(editor.state.doc.textBetween(matches[0].from, matches[0].to)).toBe(query);
    },
  );

  it('returns nonoverlapping matches, including literal spaces, and no matches for an empty query', () => {
    const editor = createEditor('<p>aaa aaa</p>');
    expect(findMatches(editor.state.doc, 'aa')).toEqual([{ from: 1, to: 3 }, { from: 5, to: 7 }]);
    expect(findMatches(editor.state.doc, ' ')).toEqual([{ from: 4, to: 5 }]);
    expect(findMatches(editor.state.doc, '')).toEqual([]);
  });

  it('keeps UTF-16 document positions correct during case-insensitive search', () => {
    const editor = createEditor('<p>İ 😀 Ab</p>');
    expect(findMatches(editor.state.doc, 'ab')).toEqual([{ from: 6, to: 8 }]);
  });
});

describe('replacement', () => {
  it('replaces one match with its starting text marks and preserves untouched bold/italic text', () => {
    const editor = createEditor('<p><strong>left </strong><em>ab</em><strong>CD</strong> / <em>right</em></p>');
    expect(replaceMatch(editor, { from: 6, to: 10 }, 'Z')).toBe(true);
    expect(textRuns(editor)).toEqual([
      { text: 'left ', marks: ['bold'] },
      { text: 'Z', marks: ['italic'] },
      { text: ' / ', marks: [] },
      { text: 'right', marks: ['italic'] },
    ]);
    expect(findMatches(editor.state.doc, 'abcd')).toEqual([]);
    expect(findMatches(editor.state.doc, 'z')).toEqual([{ from: 6, to: 7 }]);
  });

  it('preserves the portions of marked text nodes outside a replacement', () => {
    const editor = createEditor('<p><strong>before ab</strong><em>CD after</em></p>');
    expect(replaceMatch(editor, { from: 8, to: 12 }, 'X')).toBe(true);
    expect(textRuns(editor)).toEqual([
      { text: 'before X', marks: ['bold'] },
      { text: ' after', marks: ['italic'] },
    ]);
  });

  it('does not inherit arbitrary marks from preceding text or stored cursor marks', () => {
    const editor = createEditor('<p><strong>left </strong>ab<em>CD tail</em></p>');
    editor.commands.setTextSelection(7);
    editor.commands.setMark('bold');
    expect(editor.state.storedMarks?.map((mark) => mark.type.name)).toEqual(['bold']);
    expect(replaceMatch(editor, { from: 6, to: 10 }, 'plain')).toBe(true);
    expect(textRuns(editor)).toEqual([
      { text: 'left ', marks: ['bold'] },
      { text: 'plain', marks: [] },
      { text: ' tail', marks: ['italic'] },
    ]);
  });

  it('replaces all matches in descending order in one undoable transaction', () => {
    const editor = createEditor('<p><strong>pre </strong><em>cat</em> + <strong>CAT</strong><em> tail</em></p>');
    const before = editor.getJSON();
    const matches = findMatches(editor.state.doc, 'cat');
    const input = matches.map((match) => ({ ...match }));
    expect(replaceAllMatches(editor, matches, 'elephant')).toBe(true);
    expect(matches).toEqual(input);
    expect(textRuns(editor)).toEqual([
      { text: 'pre ', marks: ['bold'] },
      { text: 'elephant', marks: ['italic'] },
      { text: ' + ', marks: [] },
      { text: 'elephant', marks: ['bold'] },
      { text: ' tail', marks: ['italic'] },
    ]);
    expect(findMatches(editor.state.doc, 'elephant')).toEqual([{ from: 5, to: 13 }, { from: 16, to: 24 }]);
    const after = editor.getJSON();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(after);
  });

  it('accepts unsorted matches and shorter replacements without position drift', () => {
    const editor = createEditor('<p>cat cat cat</p>');
    expect(replaceAllMatches(editor, [{ from: 9, to: 12 }, { from: 1, to: 4 }, { from: 5, to: 8 }], 'x')).toBe(true);
    expect(editor.state.doc.textContent).toBe('x x x');
  });

  it('deletes a match when replacement is empty and treats replacement syntax literally', () => {
    const editor = createEditor('<p><strong>left</strong>cat<em>right</em></p>');
    expect(replaceMatch(editor, { from: 5, to: 8 }, '')).toBe(true);
    expect(textRuns(editor)).toEqual([{ text: 'left', marks: ['bold'] }, { text: 'right', marks: ['italic'] }]);
    expect(replaceMatch(editor, { from: 1, to: 5 }, '$&\\1')).toBe(true);
    expect(editor.state.doc.textContent).toBe('$&\\1right');
  });

  it.each([
    { from: -1, to: 2 },
    { from: 1, to: 99 },
    { from: 1, to: 1 },
    { from: 2, to: 1 },
    { from: 1.5, to: 2 },
    { from: NaN, to: 2 },
    { from: 1, to: 8 },
  ])('rejects invalid or boundary-crossing ranges without mutation: %j', (match) => {
    const editor = createEditor('<p>foo<br>bar</p>');
    const before = editor.getJSON();
    expect(replaceMatch(editor, match, 'X')).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('rejects a batch atomically if a range is invalid or overlaps another range', () => {
    const editor = createEditor('<p>abcdef</p>');
    const before = editor.getJSON();
    expect(replaceAllMatches(editor, [{ from: 1, to: 3 }, { from: 2, to: 4 }], 'X')).toBe(false);
    expect(replaceAllMatches(editor, [{ from: 1, to: 3 }, { from: 20, to: 21 }], 'X')).toBe(false);
    expect(replaceAllMatches(editor, [], 'X')).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('supports undo and redo through the registered shortcuts after a single replacement', () => {
    const editor = createEditor('<p><strong>cat</strong><em> tail</em></p>');
    const before = editor.getJSON();
    expect(replaceMatch(editor, { from: 1, to: 4 }, 'dog')).toBe(true);
    const after = editor.getJSON();
    expect(pressKey(editor, 'z', modKey)).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(pressKey(editor, 'z', { ...modKey, shiftKey: true })).toBe(true);
    expect(editor.getJSON()).toEqual(after);
  });
});

describe('DocumentLimits and document binding', () => {
  it('rejects an oversized live edit, reports rejection, and preserves the previous valid document', () => {
    const messages: string[] = [];
    const editor = createEditor('<p>valid</p>', (message) => messages.push(message));
    const before = editor.getJSON();
    editor.commands.insertContentAt(1, 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(editor.getJSON()).toEqual(before);
    expect(() => validateContent(editor.getJSON())).not.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ditolak');
    expect(messages[0]).toContain('sebelumnya');
  });

  it('rejects an invalid transaction even when a generic command bypasses the safe link command', () => {
    const messages: string[] = [];
    const editor = createEditor('<p>valid</p>', (message) => messages.push(message));
    const before = editor.getJSON();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setMark('link', { href: 'javascript:alert(1)' });
    expect(editor.getJSON()).toEqual(before);
    expect(messages).toHaveLength(1);
  });

  it('reserves JSON headroom for document metadata and the backup envelope', () => {
    const src = pngDataUrl({ byteLength: 1_572_000 });
    const content: JSONContent = {
      type: 'doc',
      content: Array.from({ length: 6 }, () => ({ type: 'image', attrs: { src } })),
    };
    // This content fits validateContent's limit, but not the editor's reserve.
    expect(() => validateContent(content)).not.toThrow();
    const messages: string[] = [];
    const editor = createEditor('<p>valid</p>', (message) => messages.push(message));
    const before = editor.getJSON();
    editor.commands.setContent(content);
    expect(editor.getJSON()).toEqual(before);
    expect(messages).toHaveLength(1);
  });

  it('reports a rejected replacement as false and preserves the previous document', () => {
    const editor = createEditor('<p>cat</p>');
    const before = editor.getJSON();
    expect(replaceMatch(editor, { from: 1, to: 4 }, 'x'.repeat(2 * 1024 * 1024 + 1))).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('isolates undo history after binding a new document with a fresh EditorState', () => {
    const editor = createEditor('<p>First</p>');
    editor.commands.insertContentAt(6, ' edited');
    expect(editor.state.doc.textContent).toBe('First edited');
    const doc = editor.schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }],
    });
    editor.view.updateState(EditorState.create({ schema: editor.schema, doc, plugins: editor.state.plugins }));
    const before = editor.getJSON();
    expect(editor.commands.undo()).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    editor.commands.insertContentAt(2, '!');
    expect(editor.state.doc.textContent).toBe('S!econd');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.textContent).toBe('S!econd');
  });
});

describe('document summaries', () => {
  it('returns heading positions, levels, and text across marks and nested blocks', () => {
    const editor = createEditor('<h1><strong>One</strong></h1><p>body</p><blockquote><h3>Two</h3></blockquote>');
    expect(headingOutline(editor.state.doc)).toEqual([
      { position: 0, level: 1, text: 'One' },
      { position: 12, level: 3, text: 'Two' },
    ]);
    editor.commands.insertContentAt(1, 'New ');
    expect(headingOutline(editor.state.doc)).toEqual([
      { position: 0, level: 1, text: 'New One' },
      { position: 16, level: 3, text: 'Two' },
    ]);
  });

  it('counts words across blocks and hard breaks without adding structural characters', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
        ] },
        { type: 'paragraph', content: [
          { type: 'text', text: 'One' },
          { type: 'hardBreak' },
          { type: 'text', text: 'two   three' },
        ] },
      ],
    });
    expect(documentStats(editor.state.doc)).toEqual({ words: 5, characters: 25 });
    expect(documentStats(createEditor().state.doc)).toEqual({ words: 0, characters: 0 });
  });
});
