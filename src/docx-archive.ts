import { Inflate, zipSync } from 'fflate';

export interface DocxArchiveWarning {
  code: 'external-relationship';
  part: string;
  message: string;
}
export interface PreparedDocxArchive {
  bytes: Uint8Array<ArrayBuffer>;
  warnings: DocxArchiveWarning[];
}
interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  expanded: number;
  local: number;
  start: number;
  end: number;
}
const MiB = 1024 * 1024;
const MAX_COMPRESSED = 12 * MiB;
const MAX_TOTAL = 32 * MiB;
const MAX_PART = 8 * MiB;
const MAX_ENTRIES = 2048;
const MAX_DEPTH = 128;
const MAX_ELEMENTS = 150000;
const INFLATE_CHUNK = 256;
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const activeRelationship: Record<string, boolean> = {
  oleobject: true, package: true, control: true, attachedtemplate: true,
  vbaproject: true, vbadata: true, activexcontrol: true, afchunk: true,
};
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  crcTable[i] = c >>> 0;
}

function fail(message: string): never {
  throw new Error(`DOCX archive: ${message}`);
}
function checkedName(name: string, directory = false): string {
  // Deliberately narrower than ZIP: no URI aliases, Windows special names, or
  // ambiguous separators. ASCII names without UTF-8 flags are supported; legacy
  // code-page names and Unicode path override extras are rejected, not guessed.
  if (!name || /[\\\u0000-\u0020\u007f%:#?]/.test(name) || name.startsWith('/') || name.normalize('NFC') !== name) fail('Unsafe entry name/path.');
  const path = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) fail('Unsafe entry name/path.');
  }
  return path;
}
function extras(bytes: Uint8Array, v: DataView, start: number, length: number): void {
  const end = start + length;
  if (end > bytes.length) fail('Truncated ZIP extra metadata.');
  while (start < end) {
    if (start + 4 > end) fail('Malformed ZIP extra metadata.');
    const id = v.getUint16(start, true), size = v.getUint16(start + 2, true);
    if (id === 1) fail('ZIP64 is unsupported.');
    if (id === 0x7075) fail('Alternate Unicode entry names are unsupported.');
    start += 4 + size;
    if (start > end) fail('Malformed ZIP extra metadata.');
  }
}
function readEntries(bytes: Uint8Array): Entry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (v.getUint32(p, true) === 0x06054b50 && p + 22 + v.getUint16(p + 20, true) === bytes.length) { eocd = p; break; }
  }
  if (eocd < 0) fail('Missing or truncated ZIP end record.');
  const count = v.getUint16(eocd + 10, true), cdSize = v.getUint32(eocd + 12, true), cd = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cd === 0xffffffff
    || (eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50)) fail('ZIP64 is unsupported.');
  if (v.getUint16(eocd + 4, true) || v.getUint16(eocd + 6, true) || v.getUint16(eocd + 8, true) !== count) fail('Multidisk ZIP is unsupported.');
  if (!count || count > MAX_ENTRIES) fail('ZIP entries limit exceeded or archive is empty.');
  if (cd + cdSize !== eocd) fail('Inconsistent ZIP central metadata.');
  const entries: Entry[] = [], names = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let p = cd, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) fail('Invalid ZIP central metadata.');
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
    const compressed = v.getUint32(p + 20, true), expanded = v.getUint32(p + 24, true), local = v.getUint32(p + 42, true);
    if (compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff) fail('ZIP64 is unsupported.');
    if (v.getUint16(p + 34, true)) fail('Multidisk ZIP is unsupported.');
    if (flags & ~0x080e) fail('Encryption or unsupported ZIP flags.');
    if (method !== 0 && method !== 8) fail('Unsafe ZIP compression method.');
    if (method === 0 && (flags & 6)) fail('Unsupported stored ZIP flags.');
    if (v.getUint16(p + 6, true) > 20) fail('Unsupported ZIP version (ZIP64/encryption).');
    const n = v.getUint16(p + 28, true), x = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    if (p + 46 + n + x + comment > eocd) fail('Truncated ZIP central metadata.');
    const rawName = bytes.subarray(p + 46, p + 46 + n);
    if (!(flags & 0x800) && rawName.some(value => value > 127)) fail('Unsupported ZIP name encoding.');
    let name: string;
    try { name = decoder.decode(rawName); } catch { fail('Invalid ZIP name encoding.'); }
    const canonical = checkedName(name, name.endsWith('/')).toLowerCase();
    if (names.has(canonical)) fail('Duplicate ZIP entry name.');
    names.add(canonical);
    // Unix symlinks and other special files must not masquerade as normal parts.
    const kind = (v.getUint32(p + 38, true) >>> 16) & 0xf000;
    if (kind && kind !== 0x8000 && kind !== 0x4000) fail('Unsafe ZIP special-file metadata.');
    if ((kind === 0x4000) !== name.endsWith('/') && kind === 0x4000) fail('Inconsistent ZIP directory metadata.');
    if (name.endsWith('/') && expanded !== 0) fail('ZIP directory has expanded content.');
    if (expanded > MAX_PART) fail('Per-part expanded limit exceeded.');
    total += expanded;
    if (total > MAX_TOTAL) fail('Total expanded limit exceeded.');
    extras(bytes, v, p + 46 + n, x);
    if (local + 30 > cd || v.getUint32(local, true) !== 0x04034b50) fail('Invalid ZIP local metadata.');
    const ln = v.getUint16(local + 26, true), lx = v.getUint16(local + 28, true);
    const start = local + 30 + ln + lx, end = start + compressed;
    if (end > cd || ln !== n || v.getUint16(local + 4, true) !== v.getUint16(p + 6, true)
      || v.getUint16(local + 6, true) !== flags || v.getUint16(local + 8, true) !== method
      || v.getUint16(local + 10, true) !== v.getUint16(p + 12, true)
      || v.getUint16(local + 12, true) !== v.getUint16(p + 14, true)
      || rawName.some((value, index) => bytes[local + 30 + index] !== value)) fail('Inconsistent ZIP local/central metadata.');
    extras(bytes, v, local + 30 + ln, lx);
    const crc = v.getUint32(p + 16, true);
    for (const [lf, expected] of [[14, crc], [18, compressed], [22, expanded]]) {
      const actual = v.getUint32(local + lf, true);
      if (actual === 0xffffffff && lf !== 14) fail('ZIP64 is unsupported.');
      if (actual !== expected && (!(flags & 8) || actual !== 0)) fail('Inconsistent ZIP local/central metadata.');
    }
    if (method === 0 && compressed !== expanded) fail('Stored ZIP output length mismatch.');
    entries.push({ name, flags, method, crc, compressed, expanded, local, start, end });
    p += 46 + n + x + comment;
  }
  if (p !== eocd) fail('Inconsistent ZIP central size/count metadata.');
  // Require complete coverage: no prefixes, hidden local entries, gaps, overlaps,
  // or trailers. Bit 3 descriptors are checked but never fed to the inflater.
  const sorted = [...entries].sort((a, b) => a.local - b.local);
  let next = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i], boundary = sorted[i + 1]?.local ?? cd;
    if (e.local !== next || e.end > boundary) fail('ZIP metadata overlap or unreferenced bytes.');
    const gap = boundary - e.end;
    if (e.flags & 8) {
      if (gap !== 12 && gap !== 16) fail('Missing or invalid ZIP data descriptor.');
      const d = e.end + (gap === 16 ? 4 : 0);
      if ((gap === 16 && v.getUint32(e.end, true) !== 0x08074b50)
        || v.getUint32(d, true) !== e.crc || v.getUint32(d + 4, true) !== e.compressed
        || v.getUint32(d + 8, true) !== e.expanded) fail('Inconsistent ZIP data descriptor.');
    } else if (gap) fail('ZIP metadata overlap or unreferenced bytes.');
    next = boundary;
  }
  return entries;
}

function expand(bytes: Uint8Array, entry: Entry, budget: { total: number }): Uint8Array {
  const result = new Uint8Array(entry.expanded);
  let written = 0, crc = 0xffffffff;
  const accept = (chunk: Uint8Array): void => {
    written += chunk.length; budget.total += chunk.length;
    if (written > entry.expanded || written > MAX_PART || budget.total > MAX_TOTAL) fail('Actual expanded output length/limit exceeded.');
    result.set(chunk, written - chunk.length);
    for (const value of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255];
  };
  if (entry.method === 0) accept(bytes.subarray(entry.start, entry.end));
  else {
    const inflater = new Inflate(accept);
    // A small push bounds fflate's temporary expansion before ondata can enforce
    // limits (DEFLATE maximum ratio ~1032:1), unlike unchecked unzipSync. The
    // central size only bounds the destination; actual bytes and CRC are checked.
    for (let p = entry.start; p < entry.end; p += INFLATE_CHUNK) {
      inflater.push(bytes.subarray(p, Math.min(p + INFLATE_CHUNK, entry.end)), p + INFLATE_CHUNK >= entry.end);
    }
    // fflate 0.8.3's public stream final callback reflects the caller's final flag,
    // not proof of BFINAL/EOB or full consumption. Check its pinned stream state
    // fail-closed to reject empty, truncated, and trailing-data DEFLATE streams.
    // Updating fflate requires reviewing this dependency-private invariant.
    const state = inflater as unknown as { s?: { f: number; l: unknown; p: number }; p?: Uint8Array };
    if (!state.s || !state.p || !state.s.f || state.s.l || state.p.length !== (state.s.p ? 1 : 0)) fail('Invalid or incomplete ZIP DEFLATE stream.');
  }
  if (written !== entry.expanded) fail('Actual ZIP output length mismatch.');
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('ZIP CRC mismatch.');
  return result;
}

function parseXml(bytes: Uint8Array, budget: { elements: number }): XMLDocument {
  let encoding = 'utf-8';
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0 && bytes[3] === 0)) encoding = 'utf-16le';
  else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0)) encoding = 'utf-16be';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { fail('Invalid XML encoding.'); }
  if (text.includes('\u0000')) fail('Unsupported XML encoding or NUL.');
  // Reject declarations before invoking a parser: no DTD, internal/external
  // entities, network resolution, or entity expansion is permitted.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('XML DTD/ENTITY is forbidden.');
  const declared = /^<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/i.exec(text)?.[1].toLowerCase();
  if (declared && (encoding === 'utf-8' ? declared !== 'utf-8' && declared !== 'utf8'
    : declared !== 'utf-16' && declared !== encoding)) fail('Unsupported or inconsistent XML encoding declaration.');
  // Count before DOM parsing so deep/huge element trees never reach the parser.
  // Comments, CDATA, PI, and quoted attributes cannot masquerade as element tags.
  let depth = 0, p = 0;
  while ((p = text.indexOf('<', p)) !== -1) {
    let terminator = '', prefix = 0;
    if (text.startsWith('<!--', p)) { terminator = '-->'; prefix = 4; }
    else if (text.startsWith('<![CDATA[', p)) { terminator = ']]>'; prefix = 9; }
    else if (text.startsWith('<?', p)) { terminator = '?>'; prefix = 2; }
    if (terminator) {
      const end = text.indexOf(terminator, p + prefix);
      if (end < 0) fail('Malformed XML.');
      p = end + terminator.length; continue;
    }
    if (text.startsWith('<!', p)) fail('Forbidden XML declaration.');
    let quote = '', end = p + 1;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') fail('Malformed XML tag.');
    }
    if (end === text.length) fail('Malformed XML.');
    if (text[p + 1] === '/') { if (--depth < 0) fail('Malformed XML nesting.'); }
    else {
      if (++budget.elements > MAX_ELEMENTS) fail('XML elements limit exceeded.');
      if (depth + 1 > MAX_DEPTH) fail('XML depth limit exceeded.');
      if (text[end - 1] !== '/') depth++;
    }
    p = end + 1;
  }
  if (depth) fail('Malformed XML nesting.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (!doc.documentElement || doc.doctype || doc.getElementsByTagNameNS('*', 'parsererror').length) fail('Malformed XML.');
  return doc;
}
function requireRoot(doc: XMLDocument, name: string, namespace: string): Element {
  const root = doc.documentElement;
  if (root.localName !== name || root.namespaceURI !== namespace) fail('Unexpected XML root or namespace.');
  return root;
}
function rejectActive(name: string, contentType = ''): void {
  if (/(?:^|\/)(?:activex|embeddings)(?:\/|$)|(?:^|\/)vba[^/]*|\.(?:docm|dotm|xlsm|pptm)$/i.test(name)
    || /macroenabled|vba|activex|oleobject/i.test(contentType)) fail('Unsafe active content (macro/ActiveX/OLE).');
}
function resolveTarget(source: string, target: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(target.split('#')[0]); } catch { fail('Invalid relationship target encoding.'); }
  if (!decoded || /[\\\u0000-\u0020\u007f:?#%]/.test(decoded) || decoded.startsWith('//')) fail('Unsafe internal relationship target.');
  const segments = decoded.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of decoded.replace(/^\//, '').split('/')) {
    if (segment === '..') { if (!segments.length) fail('Internal relationship target escapes archive.'); segments.pop(); }
    else if (segment !== '.') { if (!segment) fail('Invalid internal relationship target.'); segments.push(segment); }
  }
  const path = segments.join('/');
  try { checkedName(path); } catch { fail('Unsafe internal relationship target.'); }
  return path;
}

/**
 * Synchronous, browser-only archive preflight; never fetches or accesses files.
 * Input: Uint8Array or ArrayBuffer. Output: fresh ZIP bytes and security warnings.
 * Limits: 12 MiB ZIP, 32 MiB actual expanded total, 8 MiB per part, 2048 entries;
 * XML depth 128 and 150000 elements cumulatively across all XML parts.
 * Rejects encryption, ZIP64/multidisk, unsupported methods/flags, unsafe or
 * duplicate names (including case aliases), metadata disagreement, bad CRC,
 * mismatched actual lengths, malformed XML, DTD/entities, and active content.
 * Normal directories and signed/unsigned bit-3 descriptors are supported.
 * Required roots use transitional OPC/Word namespaces and the normal nonmacro
 * document main content type at word/document.xml; Strict OOXML is unsupported.
 * Repack happens only after every part is verified. Descriptors are discarded;
 * XML is reserialized as UTF-8, including originally UTF-16 parts.
 * This is not an image/HTML sanitizer, an antivirus, or full OOXML schema
 * validation. External relationships are retained; external non-hyperlinks
 * produce warnings. Caller MUST keep Mammoth externalFileAccess:false and
 * sanitize converter HTML/links and separately validate embedded images.
 */
export function prepareDocxArchive(input: Uint8Array | ArrayBuffer): PreparedDocxArchive {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_COMPRESSED) fail('Compressed ZIP limit exceeded (12 MiB).');
  const entries = readEntries(bytes);
  const output: Record<string, Uint8Array> = Object.create(null);
  const xml = new Map<string, XMLDocument>();
  const expansion = { total: 0 }, xmlBudget = { elements: 0 };
  for (const entry of entries) {
    rejectActive(entry.name);
    const data = expand(bytes, entry, expansion);
    output[entry.name] = data;
    if (/\.(?:xml|rels|vml|svg)$/i.test(entry.name)) xml.set(entry.name, parseXml(data, xmlBudget));
  }
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    if (!xml.has(required)) fail(`Missing required DOCX part: ${required}.`);
  }
  const ct = requireRoot(xml.get('[Content_Types].xml')!, 'Types', CT_NS);
  const defaults = new Map<string, string>(), overrides = new Map<string, string>();
  for (const child of Array.from(ct.children)) {
    if (child.namespaceURI !== CT_NS || (child.localName !== 'Default' && child.localName !== 'Override')) fail('Invalid content type metadata.');
    if (child.children.length) fail('Invalid nested content type metadata.');
    const type = child.getAttribute('ContentType') ?? '';
    if (!type || /[\s;]/.test(type)) fail('Invalid content type.');
    rejectActive('', type);
    if (child.localName === 'Default') {
      const extension = (child.getAttribute('Extension') ?? '').toLowerCase();
      if (!extension || /[./\\%]/.test(extension) || defaults.has(extension)) fail('Duplicate or invalid default content type.');
      defaults.set(extension, type);
    } else {
      const partName = child.getAttribute('PartName') ?? '';
      if (!partName.startsWith('/')) fail('Invalid content type part name.');
      const name = checkedName(partName.slice(1));
      if (overrides.has(name.toLowerCase()) || !Object.hasOwn(output, name)) fail('Duplicate or missing content type part.');
      overrides.set(name.toLowerCase(), type);
    }
  }
  if ((overrides.get('word/document.xml') ?? defaults.get('xml')) !== MAIN_TYPE) fail('Unsupported Word main content type.');
  requireRoot(xml.get('word/document.xml')!, 'document', WORD_NS);
  for (const entry of entries) {
    if (entry.name.endsWith('/') || entry.name === '[Content_Types].xml') continue;
    const extension = entry.name.split('.').pop()!.toLowerCase();
    const type = overrides.get(entry.name.toLowerCase()) ?? defaults.get(extension);
    // Untyped non-XML inert entries are allowed; declared XML with unconventional
    // extensions still receives the same parser and cumulative element limits.
    if (type && /(?:\+xml|\/xml)$/i.test(type) && !xml.has(entry.name)) xml.set(entry.name, parseXml(output[entry.name], xmlBudget));
  }
  const warnings: DocxArchiveWarning[] = [];
  let mainRelationship = false;
  for (const [name, doc] of xml) {
    if (!/\.rels$/i.test(name)) continue;
    const root = requireRoot(doc, 'Relationships', REL_NS);
    let source = '';
    if (name !== '_rels/.rels') {
      const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/.exec(name);
      if (!match) fail('Invalid relationship part path.');
      source = (match[1] ? `${match[1]}/` : '') + match[2];
      if (!Object.hasOwn(output, source)) fail('Missing relationship source part.');
    }
    const ids = new Set<string>();
    let warnedExternal = false;
    for (const child of Array.from(root.children)) {
      if (child.namespaceURI !== REL_NS || child.localName !== 'Relationship') fail('Invalid relationship XML.');
      if (child.children.length) fail('Invalid nested relationship metadata.');
      const id = child.getAttribute('Id') ?? '', type = child.getAttribute('Type') ?? '', target = child.getAttribute('Target') ?? '';
      const mode = child.getAttribute('TargetMode') ?? 'Internal';
      if (!id || ids.has(id) || !type || !target || (mode !== 'External' && mode !== 'Internal')) fail('Invalid or duplicate relationship metadata.');
      ids.add(id);
      const kind = type.slice(type.lastIndexOf('/') + 1).toLowerCase();
      if (Object.hasOwn(activeRelationship, kind) || /vba|activex|oleobject/i.test(type)) fail('Unsafe active relationship.');
      if (mode === 'External') {
        if (type !== `${OFFICE_REL}hyperlink` && !warnedExternal) {
          warnings.push({ code: 'external-relationship', part: name, message: `External non-hyperlink relationships in ${name} are not fetched; related content may be omitted.` });
          warnedExternal = true;
        }
      } else {
        const resolved = resolveTarget(source, target);
        if (!Object.hasOwn(output, resolved) || resolved.endsWith('/')) fail('Missing internal relationship target.');
        if (name === '_rels/.rels' && type === `${OFFICE_REL}officeDocument`) {
          if (resolved !== 'word/document.xml' || mainRelationship) fail('Unsupported or duplicate main document relationship target.');
          mainRelationship = true;
        }
      }
    }
  }
  if (!mainRelationship) fail('Missing required main document relationship.');
  const serializer = new XMLSerializer(), encoder = new TextEncoder();
  let normalizedTotal = 0;
  for (const entry of entries) {
    const doc = xml.get(entry.name);
    if (doc) output[entry.name] = encoder.encode('<?xml version="1.0" encoding="UTF-8"?>' + serializer.serializeToString(doc).replace(/^<\?xml[^?]*\?>/, ''));
    if (output[entry.name].length > MAX_PART) fail('Normalized XML per-part expanded limit exceeded.');
    normalizedTotal += output[entry.name].length;
    if (normalizedTotal > MAX_TOTAL) fail('Normalized XML total expanded limit exceeded.');
  }
  // Store verified bytes: avoids a second compressor's CPU cost and length
  // ambiguity. This safe repack may exceed the original 12 MiB input limit.
  const rebuilt = zipSync(output, { level: 0 });
  return { bytes: new Uint8Array(rebuilt), warnings };
}
