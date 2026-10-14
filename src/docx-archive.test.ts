// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { prepareDocxArchive as preflightDocxArchive } from './docx-archive';

const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const relationships = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const documentXml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>';
function parts(extra: Record<string, Uint8Array | string> = {}) {
  const result: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(types), '_rels/.rels': strToU8(relationships),
    'word/document.xml': strToU8(documentXml),
  };
  for (const [name, value] of Object.entries(extra)) result[name] = typeof value === 'string' ? strToU8(value) : value;
  return result;
}
function fixture(extra: Record<string, Uint8Array | string> = {}, level: 0 | 6 = 6) {
  return zipSync(parts(extra), { level });
}
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function central(bytes: Uint8Array) {
  const v = view(bytes);
  const entries: { central: number; local: number }[] = [];
  let p = v.getUint32(bytes.length - 22 + 16, true);
  while (v.getUint32(p, true) === 0x02014b50) {
    entries.push({ central: p, local: v.getUint32(p + 42, true) });
    p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return entries;
}
function changeBoth(bytes: Uint8Array, localField: number, centralField: number, value: number, width = 4) {
  const v = view(bytes), e = central(bytes)[2];
  if (width === 2) { v.setUint16(e.local + localField, value, true); v.setUint16(e.central + centralField, value, true); }
  else { v.setUint32(e.local + localField, value, true); v.setUint32(e.central + centralField, value, true); }
  return bytes;
}
// Insert a genuine descriptor and zero local sizes, updating all shifted offsets.
function descriptor(signed: boolean) {
  const old = fixture(), entries = central(old), e = entries[2], ov = view(old);
  const start = e.local + 30 + ov.getUint16(e.local + 26, true) + ov.getUint16(e.local + 28, true);
  const end = start + ov.getUint32(e.central + 20, true), length = signed ? 16 : 12;
  const bytes = new Uint8Array(old.length + length);
  bytes.set(old.subarray(0, end)); bytes.set(old.subarray(end), end + length);
  const v = view(bytes), d = end + (signed ? 4 : 0);
  if (signed) v.setUint32(end, 0x08074b50, true);
  for (let i = 0; i < 3; i++) v.setUint32(d + i * 4, ov.getUint32(e.central + 16 + i * 4, true), true);
  v.setUint16(e.local + 6, ov.getUint16(e.local + 6, true) | 8, true);
  for (const offset of [14, 18, 22]) v.setUint32(e.local + offset, 0, true);
  v.setUint16(e.central + length + 8, ov.getUint16(e.central + 8, true) | 8, true);
  const oldCd = ov.getUint32(old.length - 6, true);
  v.setUint32(bytes.length - 6, oldCd + length, true);
  return bytes;
}
function rel(target: string, type = 'image', mode = '') {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/></Relationships>`;
}

describe('DOCX archive preflight', () => {
  it('accepts an actual docx package exported by the installed library', async () => {
    const exported = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Genuine export')] }] }));
    const result = preflightDocxArchive(new Uint8Array(exported));
    expect(result.warnings).toEqual([]);
    expect(new TextDecoder().decode(unzipSync(result.bytes)['word/document.xml'])).toContain('Genuine export');
  });
  it('accepts package-absolute main targets and empty document relationships', () => {
    const result = preflightDocxArchive(fixture({
      '_rels/.rels': relationships.replace('Target="word/document.xml"', 'Target="/word/document.xml"'),
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    }));
    expect(result.warnings).toEqual([]);
    expect(unzipSync(result.bytes)['word/document.xml']).toBeDefined();
  });
  it('accepts an ArrayBuffer input without mutating its ZIP metadata', () => {
    const bytes = fixture(), original = bytes.slice();
    expect(preflightDocxArchive(bytes.buffer).bytes.length).toBeGreaterThan(0);
    expect(bytes).toEqual(original);
  });
  it.each([0, 6] as const)('accepts verified method level %s and ordinary directories', (level) => {
    const result = preflightDocxArchive(fixture({ 'word/': new Uint8Array(), 'word/media/pixel.dat': new Uint8Array([1, 2]) }, level));
    expect(result.warnings).toEqual([]);
    expect(unzipSync(result.bytes)['word/media/pixel.dat']).toEqual(new Uint8Array([1, 2]));
  });
  it.each([false, true])('accepts a %s signed streaming descriptor and rebuilds verified sizes', (signed) => {
    const result = preflightDocxArchive(descriptor(signed));
    expect(new TextDecoder().decode(unzipSync(result.bytes)['word/document.xml'])).toContain('Hello');
    for (const e of central(result.bytes)) expect(view(result.bytes).getUint16(e.local + 6, true) & 8).toBe(0);
  });
  it('rejects inconsistent descriptor CRC', () => {
    const bytes = descriptor(true), e = central(bytes)[2], v = view(bytes);
    const end = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true) + v.getUint32(e.central + 20, true);
    v.setUint32(end + 4, 123, true);
    expect(() => preflightDocxArchive(bytes)).toThrow(/descriptor/i);
  });
  it('rejects CRC mismatch even when both headers agree', () => {
    expect(() => preflightDocxArchive(changeBoth(fixture(), 14, 16, 123))).toThrow(/CRC/i);
  });
  it('rejects a stored part modified after packing', () => {
    const bytes = fixture({}, 0), e = central(bytes)[2], v = view(bytes);
    bytes[e.local + 30 + v.getUint16(e.local + 26, true)] ^= 1;
    expect(() => preflightDocxArchive(bytes)).toThrow(/CRC/i);
  });
  it('rejects forged small output lengths rather than trusting central allocation sizes', () => {
    expect(() => preflightDocxArchive(changeBoth(fixture(), 22, 24, 1))).toThrow(/length|expanded/i);
  });
  it('rejects forged larger output lengths', () => {
    expect(() => preflightDocxArchive(changeBoth(fixture(), 22, 24, 1000))).toThrow(/length/i);
  });
  it('stops a compressed bomb whose declared size was forged small', () => {
    const bytes = fixture({ 'bomb.dat': new Uint8Array(8 * 1024 * 1024 + 1) });
    const e = central(bytes)[3], v = view(bytes);
    v.setUint32(e.local + 22, 1, true); v.setUint32(e.central + 24, 1, true);
    expect(() => preflightDocxArchive(bytes)).toThrow(/length|expanded/i);
  });
  it('rejects the per-part expanded limit', () => {
    expect(() => preflightDocxArchive(fixture({ 'large.dat': new Uint8Array(8 * 1024 * 1024 + 1) }))).toThrow(/part|expanded/i);
  });
  it('rejects the aggregate expanded limit', () => {
    const block = new Uint8Array(8 * 1024 * 1024);
    expect(() => preflightDocxArchive(fixture({ 'a.dat': block, 'b.dat': block, 'c.dat': block, 'd.dat': block }))).toThrow(/total|expanded/i);
  });
  it('rejects compressed archives over 12 MiB before inspecting bytes', () => {
    expect(() => preflightDocxArchive(new Uint8Array(12 * 1024 * 1024 + 1))).toThrow(/compressed/i);
  });
  it('rejects more than 2048 entries', () => {
    const extra: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2046; i++) extra[`entry${i}`] = new Uint8Array();
    expect(() => preflightDocxArchive(fixture(extra))).toThrow(/entries/i);
  });
  it.each(['../escape.xml', '/absolute.xml', 'word\\evil.xml', 'word/../evil.xml', 'C:/evil.xml', 'word//evil.xml', 'word/%2e%2e/evil.xml'])('rejects unsafe name %s', (name) => {
    expect(() => preflightDocxArchive(fixture({ [name]: '<x/>' }))).toThrow(/name|path/i);
  });
  it('rejects duplicate names independently of fflate object deduplication', () => {
    const bytes = fixture({ 'same-a': '', 'same-b': '' }), v = view(bytes), entries = central(bytes);
    const a = entries[3], b = entries[4];
    bytes.set(bytes.subarray(a.central + 46, a.central + 52), b.central + 46);
    bytes.set(bytes.subarray(a.local + 30, a.local + 36), b.local + 30);
    expect(() => preflightDocxArchive(bytes)).toThrow(/duplicate/i);
    expect(v.getUint16(b.central + 28, true)).toBe(6);
  });
  it('rejects case-folded duplicate package names', () => {
    expect(() => preflightDocxArchive(fixture({ 'WORD/document.xml': documentXml }))).toThrow(/duplicate/i);
  });
  it.each([1, 0x40, 0x2000])('rejects encryption flag %s', (flag) => {
    expect(() => preflightDocxArchive(changeBoth(fixture(), 6, 8, flag, 2))).toThrow(/flag|encrypt/i);
  });
  it('rejects ZIP64 sentinel sizes', () => {
    expect(() => preflightDocxArchive(changeBoth(fixture(), 18, 20, 0xffffffff))).toThrow(/ZIP64/i);
  });
  it('rejects multidisk EOCD', () => {
    const bytes = fixture(); view(bytes).setUint16(bytes.length - 18, 1, true);
    expect(() => preflightDocxArchive(bytes)).toThrow(/disk/i);
  });
  it('rejects unsafe compression methods', () => {
    expect(() => preflightDocxArchive(changeBoth(fixture(), 8, 10, 99, 2))).toThrow(/method/i);
  });
  it('rejects central/local metadata disagreement', () => {
    const bytes = fixture(); view(bytes).setUint32(central(bytes)[2].local + 22, 9, true);
    expect(() => preflightDocxArchive(bytes)).toThrow(/metadata/i);
  });
  it('rejects overlapping local offsets', () => {
    const bytes = fixture(), entries = central(bytes);
    view(bytes).setUint32(entries[1].central + 42, entries[0].local, true);
    expect(() => preflightDocxArchive(bytes)).toThrow();
  });
  it.each([new Uint8Array(), new Uint8Array([80, 75, 3, 4])])('rejects invalid ZIP', (bytes) => {
    expect(() => preflightDocxArchive(bytes)).toThrow(/ZIP/i);
  });
  it('rejects ZIP64 extra metadata even without sentinel sizes', () => {
    const bytes = zipSync(parts(), { extra: { 1: new Uint8Array(16) } });
    expect(() => preflightDocxArchive(bytes)).toThrow(/ZIP64/i);
  });
  it('rejects truncated deflate even when output length and CRC could still match', () => {
    const bytes = fixture(), e = central(bytes)[2], v = view(bytes);
    // Clearing BFINAL changes no output bytes, but the stream is incomplete.
    const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
    bytes[start] &= 0xfe;
    expect(() => preflightDocxArchive(bytes)).toThrow();
  });
  it('requires the expected content-types and relationships namespaces', () => {
    expect(() => preflightDocxArchive(fixture({ '[Content_Types].xml': types.replace('2006/content-types', 'wrong') }))).toThrow(/root|namespace/i);
    expect(() => preflightDocxArchive(fixture({ '_rels/.rels': relationships.replace('2006/relationships', 'wrong') }))).toThrow(/root|namespace/i);
  });
  it('validates XML declared under an unconventional extension', () => {
    const declaredTypes = types.replace('</Types>', '<Default Extension="custom" ContentType="application/example+xml"/></Types>');
    expect(() => preflightDocxArchive(fixture({ '[Content_Types].xml': declaredTypes, 'extra.custom': '<x>' }))).toThrow(/XML/i);
  });
  it('does not count apparent tags inside comments, CDATA, or attributes', () => {
    const xml = '<x note="&lt;y/&gt;"><!-- ' + '<z>'.repeat(200) + ' --><![CDATA[' + '<z>'.repeat(200) + ']]></x>';
    expect(preflightDocxArchive(fixture({ 'extra.xml': xml })).warnings).toEqual([]);
  });
  it('rejects unsupported declared XML encodings', () => {
    expect(() => preflightDocxArchive(fixture({ 'extra.xml': '<?xml version="1.0" encoding="ISO-8859-1"?><x/>' }))).toThrow(/encoding/i);
  });
  it('rejects a second main relationship, duplicate IDs, or a missing source part', () => {
    const doubled = relationships.replace('</Relationships>', relationships.slice(relationships.indexOf('<Relationship Id'), relationships.indexOf('</Relationships>')).replace('rId1', 'rId2') + '</Relationships>');
    expect(() => preflightDocxArchive(fixture({ '_rels/.rels': doubled }))).toThrow(/duplicate/i);
    expect(() => preflightDocxArchive(fixture({ '_rels/.rels': doubled.replace('rId2', 'rId1') }))).toThrow(/duplicate/i);
    expect(() => preflightDocxArchive(fixture({ 'word/_rels/missing.xml.rels': rel('document.xml') }))).toThrow(/source/i);
  });
  it.each(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])('requires %s', (name) => {
    const p = parts(); delete p[name];
    expect(() => preflightDocxArchive(zipSync(p))).toThrow(/required/i);
  });
  it.each(['<x>', '<x/><y/>', '<x>&unknown;</x>', '<!DOCTYPE x [<!ENTITY e "evil">]><x>&e;</x>'])('rejects invalid or dangerous XML %s', (xml) => {
    expect(() => preflightDocxArchive(fixture({ 'extra.xml': xml }))).toThrow(/XML|DTD|ENTITY/i);
  });
  it('rejects XML nesting before parsing', () => {
    expect(() => preflightDocxArchive(fixture({ 'deep.xml': '<x>'.repeat(129) + '</x>'.repeat(129) }))).toThrow(/depth/i);
  });
  it('counts XML elements across all parts', () => {
    const xml = '<x>' + '<y/>'.repeat(75000) + '</x>';
    expect(() => preflightDocxArchive(fixture({ 'one.xml': xml, 'two.xml': xml }))).toThrow(/elements/i);
  });
  it.each(['le', 'be'])('normalizes UTF-16%s validated XML to UTF-8', (endian) => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?>' + documentXml;
    const bytes = new Uint8Array(2 + xml.length * 2), v = view(bytes);
    v.setUint16(0, 0xfeff, endian === 'le');
    for (let i = 0; i < xml.length; i++) v.setUint16(2 + i * 2, xml.charCodeAt(i), endian === 'le');
    const result = preflightDocxArchive(fixture({ 'word/document.xml': bytes }));
    const output = new TextDecoder('utf-8', { fatal: true }).decode(unzipSync(result.bytes)['word/document.xml']);
    expect(output).toContain('Hello'); expect(output).not.toMatch(/encoding=["']UTF-16/i);
  });
  it('rejects malformed UTF-8 rather than silently replacing it', () => {
    expect(() => preflightDocxArchive(fixture({ 'extra.xml': new Uint8Array([60, 120, 62, 0xff, 60, 47, 120, 62]) }))).toThrow(/encoding|UTF|XML/i);
  });
  it('rejects DTD in UTF-16 XML', () => {
    const xml = '\ufeff<!DOCTYPE x><x/>', bytes = new Uint8Array(xml.length * 2);
    for (let i = 0; i < xml.length; i++) view(bytes).setUint16(i * 2, xml.charCodeAt(i), true);
    expect(() => preflightDocxArchive(fixture({ 'extra.xml': bytes }))).toThrow(/DTD|ENTITY/i);
  });
  it.each(['<document/>', documentXml.replace('wordprocessingml/2006/main', 'wrong')])('requires the Word document root namespace', (xml) => {
    expect(() => preflightDocxArchive(fixture({ 'word/document.xml': xml }))).toThrow(/root|namespace/i);
  });
  it('requires the normal nonmacro Word main content type', () => {
    expect(() => preflightDocxArchive(fixture({ '[Content_Types].xml': types.replace('wordprocessingml.document.main+xml', 'wordprocessingml.template.main+xml') }))).toThrow(/content type/i);
  });
  it.each(['word/vbaProject.bin', 'word/activeX/activeX1.xml', 'word/embeddings/oleObject1.bin'])('rejects active part %s', (name) => {
    expect(() => preflightDocxArchive(fixture({ [name]: new Uint8Array() }))).toThrow(/active|macro|OLE/i);
  });
  it('rejects macro content types even without a macro entry', () => {
    expect(() => preflightDocxArchive(fixture({ '[Content_Types].xml': types.replace('officedocument.wordprocessingml.document.main', 'ms-word.document.macroEnabled.main') }))).toThrow(/active|macro|content type/i);
  });
  it.each(['../../outside.xml', '%2e%2e/%2e%2e/outside.xml', 'file:///tmp/private', 'C:/private', '..\\private'])('rejects unsafe internal relationship target %s', (target) => {
    expect(() => preflightDocxArchive(fixture({ 'word/_rels/document.xml.rels': rel(target) }))).toThrow(/target|relationship/i);
  });
  it('accepts internal parent traversal that remains in the archive', () => {
    const result = preflightDocxArchive(fixture({ 'word/_rels/document.xml.rels': rel('../media/pixel.dat'), 'media/pixel.dat': new Uint8Array([1]) }));
    expect(result.warnings).toEqual([]);
  });
  it('rejects missing internal relationship targets', () => {
    expect(() => preflightDocxArchive(fixture({ 'word/_rels/document.xml.rels': rel('missing.png') }))).toThrow(/target/i);
  });
  it('warns on external non-hyperlink relationships without fetching them', () => {
    const result = preflightDocxArchive(fixture({ 'word/_rels/document.xml.rels': rel('https://example.invalid/image.png', 'image', 'External') }));
    expect(result.warnings).toHaveLength(1); expect(result.warnings[0].message).toMatch(/external/i);
  });
  it('does not warn for ordinary external hyperlinks', () => {
    expect(preflightDocxArchive(fixture({ 'word/_rels/document.xml.rels': rel('https://example.invalid/', 'hyperlink', 'External') })).warnings).toEqual([]);
  });
  it('retains unsafe external hyperlinks for the parent sanitizer, without fetching', () => {
    const result = preflightDocxArchive(fixture({ 'word/_rels/document.xml.rels': rel('javascript:alert(1)', 'hyperlink', 'External') }));
    expect(result.warnings).toEqual([]);
    expect(new TextDecoder().decode(unzipSync(result.bytes)['word/_rels/document.xml.rels'])).toContain('javascript:alert(1)');
  });
  it.each(['oleObject', 'package', 'control', 'attachedTemplate'])('rejects active relationship type %s, including external ones', (type) => {
    expect(() => preflightDocxArchive(fixture({ 'word/_rels/document.xml.rels': rel('https://example.invalid/', type, 'External') }))).toThrow(/active/i);
  });
});
