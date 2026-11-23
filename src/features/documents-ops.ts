// What can be done to a document's bytes: read its text (and a PDF's form
// fields), fill a PDF form, replace text in place, add a line to a page, and
// make a new PDF or Word file from a draft's text. Pure functions on bytes, run
// on a worker thread (documents-worker.ts) so a big or hostile file can't stall
// the voice. The libraries load on first use: nothing is loaded while the
// feature is off.
//
// Honest limits, said back to the person rather than papered over:
// - Encrypted PDFs and XFA forms are refused.
// - Text in a PDF is replaced by covering the old words with a white box and
//   writing the new ones over it in Helvetica, so it only works when the words
//   sit on one line in one piece, and the new words use the PDF's standard
//   font, not the original one. Characters Helvetica can't write become "?".
// - A Word file is read as its text; replacing words in place works when they
//   sit in one run of the same formatting, and anything bigger becomes a new
//   file with headings and bullets, not the original's look.

export type DocKind = 'pdf' | 'docx' | 'txt' | 'md';

export const DOC_LIMITS = {
  /** Biggest file taken, bytes. */
  bytes: 20 * 1024 * 1024,
  /** Most PDF pages read. */
  pages: 300,
  /** Most text kept from a document. */
  chars: 400_000,
  /** Biggest unpacked Word document part. */
  unpacked: 40 * 1024 * 1024,
} as const;

export function kindOf(name: string, contentType?: string | null): DocKind | undefined {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'pdf' || contentType === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt' || ext === 'text' || (!ext && contentType?.startsWith('text/plain'))) return 'txt';
  return undefined;
}

export interface FieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'other';
  value?: string;
  options?: string[];
}

export interface DocInfo {
  text: string;
  pages?: number;
  fields?: FieldInfo[];
  /** True when the text was cut at DOC_LIMITS.chars. */
  cut?: boolean;
}

export class DocError extends Error {}

const cutText = (t: string) => (t.length > DOC_LIMITS.chars ? { text: t.slice(0, DOC_LIMITS.chars), cut: true } : { text: t });

function plain(bytes: Uint8Array): string {
  const t = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (t.slice(0, 4000).includes('\u0000')) throw new DocError("that file isn't plain text");
  return t.replace(/\r\n?/g, '\n');
}

// --- PDF ---------------------------------------------------------------------

async function pdfLib() {
  return import('pdf-lib');
}

async function loadPdf(bytes: Uint8Array) {
  const { PDFDocument, EncryptedPDFError } = await pdfLib();
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) throw new DocError('that PDF is password-protected or encrypted, so I can only read what it lets anyone read');
    throw new DocError("that doesn't open as a PDF");
  }
}

/** An XFA entry means the real form is XML that pdf-lib can't fill. */
function hasXfa(doc: Awaited<ReturnType<typeof loadPdf>>, lib: Awaited<ReturnType<typeof pdfLib>>): boolean {
  // Read from the catalog: getForm() quietly deletes an XFA form, so ask before it runs.
  try {
    return !!doc.catalog.lookupMaybe(lib.PDFName.of('AcroForm'), lib.PDFDict)?.has(lib.PDFName.of('XFA'));
  } catch {
    return false;
  }
}

function fieldsOf(doc: Awaited<ReturnType<typeof loadPdf>>, lib: Awaited<ReturnType<typeof pdfLib>>): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const f of doc.getForm().getFields().slice(0, 300)) {
    const name = f.getName().slice(0, 120);
    if (f instanceof lib.PDFTextField) out.push({ name, type: 'text', value: f.getText() ?? '' });
    else if (f instanceof lib.PDFCheckBox) out.push({ name, type: 'checkbox', value: f.isChecked() ? 'checked' : 'unchecked' });
    else if (f instanceof lib.PDFDropdown) out.push({ name, type: 'dropdown', value: f.getSelected().join(', '), options: f.getOptions().slice(0, 40) });
    else if (f instanceof lib.PDFRadioGroup) out.push({ name, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions().slice(0, 40) });
    else out.push({ name, type: 'other' });
  }
  return out;
}

type TextItem = { str: string; transform: number[]; width: number; height: number };

async function pdfText(bytes: Uint8Array, maxPages = DOC_LIMITS.pages): Promise<{ pages: number; perPage: TextItem[][] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  try {
    const pdf = await task.promise;
    const perPage: TextItem[][] = [];
    for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const items: TextItem[] = [];
      for (const x of tc.items) if ('str' in x) items.push({ str: x.str, transform: x.transform as number[], width: x.width, height: x.height });
      perPage.push(items);
      page.cleanup();
    }
    return { pages: pdf.numPages, perPage };
  } catch (e) {
    if ((e as Error).name === 'PasswordException') throw new DocError('that PDF needs a password to open');
    throw e instanceof DocError ? e : new DocError("I couldn't read the text in that PDF");
  } finally {
    await task.destroy();
  }
}

/** A page's items as lines of text, top to bottom. */
function pageLines(items: TextItem[]): string {
  const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5]!;
    const row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, it.height * 0.4));
    if (row) row.parts.push({ x: it.transform[4]!, s: it.str });
    else rows.push({ y, parts: [{ x: it.transform[4]!, s: it.str }] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) =>
      r.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.s)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

// --- Word ----------------------------------------------------------------------

async function docxPart(bytes: Uint8Array): Promise<{ zip: import('jszip'); xml: string }> {
  const JSZip = (await import('jszip')).default;
  let zip: import('jszip');
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocError("that doesn't open as a Word file");
  }
  const part = zip.file('word/document.xml');
  if (!part) throw new DocError("that Word file has no document in it");
  // The unpacked size as the zip says it, checked before unpacking.
  const declared = (part as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (declared > DOC_LIMITS.unpacked) throw new DocError('that Word file is too big once unpacked');
  const xml = await part.async('string');
  if (xml.length > DOC_LIMITS.unpacked) throw new DocError('that Word file is too big once unpacked');
  return { zip, xml };
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const toXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function docxText(xml: string): string {
  const body = xml.split('<w:body')[1] ?? xml;
  const out: string[] = [];
  for (const p of body.split(/<\/w:p>/)) {
    const runs = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? unxml(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n')).join('');
    if (!runs.trim()) {
      if (out.length && out.at(-1) !== '') out.push('');
      continue;
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const head = /^(Heading|Title)(\d?)$/i.exec(style);
    if (head) out.push(`${'#'.repeat(/^title$/i.test(head[1]!) ? 1 : Math.min(3, Number(head[2] || 1) + 1))} ${runs.trim()}`);
    else if (/<w:numPr>/.test(p) || /List/i.test(style)) out.push(`- ${runs.trim().replace(/^[•·▪-]\s*/, '')}`);
    else out.push(runs.trim());
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- the operations --------------------------------------------------------------

export async function readDoc(kind: DocKind, bytes: Uint8Array): Promise<DocInfo> {
  if (bytes.byteLength > DOC_LIMITS.bytes) throw new DocError('that file is too big');
  if (kind === 'txt' || kind === 'md') return cutText(plain(bytes));
  if (kind === 'docx') return cutText(docxText((await docxPart(bytes)).xml));
  const lib = await pdfLib();
  const doc = await loadPdf(bytes);
  const fields = hasXfa(doc, lib) ? undefined : fieldsOf(doc, lib);
  const { pages, perPage } = await pdfText(bytes);
  const text = perPage.map((items, i) => `--- page ${i + 1} ---\n${pageLines(items)}`).join('\n\n');
  return { ...cutText(text), pages, ...(fields?.length ? { fields } : {}), ...(pages > DOC_LIMITS.pages ? { cut: true } : {}) };
}

export interface FillResult {
  bytes: Uint8Array;
  filled: string[];
  missing: string[];
  refused: { name: string; why: string }[];
}

/** Fill a PDF's form fields by name (case and spacing ignored). */
export async function fillPdf(bytes: Uint8Array, values: Record<string, string>): Promise<FillResult> {
  const lib = await pdfLib();
  const doc = await loadPdf(bytes);
  if (hasXfa(doc, lib)) throw new DocError("that PDF's form is an XFA form, which I can't fill; it needs Adobe Reader");
  const form = doc.getForm();
  const fields = form.getFields();
  if (!fields.length) throw new DocError('that PDF has no form fields to fill');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out: FillResult = { bytes, filled: [], missing: [], refused: [] };
  for (const [key, value] of Object.entries(values).slice(0, 300)) {
    const f = fields.find((x) => x.getName() === key) ?? fields.find((x) => norm(x.getName()) === norm(key));
    if (!f) {
      out.missing.push(key);
      continue;
    }
    const v = String(value);
    try {
      if (f instanceof lib.PDFTextField) {
        const max = f.getMaxLength();
        f.setText(max !== undefined && v.length > max ? v.slice(0, max) : v);
      } else if (f instanceof lib.PDFCheckBox) {
        if (/^(true|yes|x|checked|check|on|1|✓)$/i.test(v.trim())) f.check();
        else f.uncheck();
      } else if (f instanceof lib.PDFDropdown || f instanceof lib.PDFRadioGroup) {
        const opt = f.getOptions().find((o) => norm(o) === norm(v));
        if (!opt) {
          out.refused.push({ name: f.getName(), why: `not one of its choices (${f.getOptions().slice(0, 8).join(', ')})` });
          continue;
        }
        f.select(opt);
      } else {
        out.refused.push({ name: f.getName(), why: "a kind of field I can't fill" });
        continue;
      }
      out.filled.push(f.getName());
    } catch (e) {
      out.refused.push({ name: f.getName(), why: (e as Error).message.slice(0, 80) });
    }
  }
  // Keep the values visible in viewers that don't draw fields themselves.
  try {
    form.updateFieldAppearances(await doc.embedFont(lib.StandardFonts.Helvetica));
  } catch {
    // appearances are a nicety
  }
  out.bytes = await doc.save();
  return out;
}

/** What Helvetica (WinAnsi) can write; anything else becomes "?". */
function winAnsi(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^ -~ -ÿ\n]/g, '?');
}

/** Replace words in a PDF by covering them and writing the new ones over. */
export async function replacePdf(bytes: Uint8Array, find: string, replace: string, all = true): Promise<{ bytes: Uint8Array; count: number }> {
  const lib = await pdfLib();
  const doc = await loadPdf(bytes);
  const { perPage } = await pdfText(bytes);
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const want = find.trim();
  if (!want) throw new DocError('say which words to replace');
  let count = 0;
  perPage.forEach((items, pi) => {
    const page = doc.getPage(pi);
    for (const it of items) {
      const at = it.str.toLowerCase().indexOf(want.toLowerCase());
      if (at < 0 || (!all && count)) continue;
      const size = Math.max(4, Math.abs(it.transform[3] ?? it.height) || it.height || 10);
      const per = it.str.length ? it.width / it.str.length : size * 0.5;
      const x = it.transform[4]! + per * at;
      const y = it.transform[5]!;
      const oldW = per * want.length;
      page.drawRectangle({ x: x - 0.5, y: y - size * 0.25, width: oldW + 1, height: size * 1.2, color: lib.rgb(1, 1, 1) });
      const text = winAnsi(replace);
      // Squeeze longer words to the old width rather than run over what follows.
      const natural = font.widthOfTextAtSize(text, size);
      const fit = natural > oldW * 1.15 && natural > 0 ? Math.max(4, (size * oldW * 1.15) / natural) : size;
      page.drawText(text, { x, y, size: fit, font, color: lib.rgb(0, 0, 0) });
      count++;
    }
  });
  if (!count) throw new DocError(`I couldn't find "${want.slice(0, 60)}" written in one piece in that PDF`);
  return { bytes: await doc.save(), count };
}

/** A line of text at the top or bottom of a page, or on a new last page. */
export async function addTextPdf(bytes: Uint8Array, text: string, where: 'top' | 'bottom' | 'new page', pageNo = 1): Promise<Uint8Array> {
  const lib = await pdfLib();
  const doc = await loadPdf(bytes);
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  if (where === 'new page') {
    const last = doc.getPage(doc.getPageCount() - 1);
    const { width, height } = last.getSize();
    const page = doc.addPage([width, height]);
    drawWrapped(page, font, winAnsi(text), 72, height - 72, width - 144, 11);
  } else {
    const n = Math.min(Math.max(1, Math.round(pageNo)), doc.getPageCount());
    const page = doc.getPage(n - 1);
    const { width, height } = page.getSize();
    const t = winAnsi(text).split('\n')[0]!.slice(0, 200);
    page.drawText(t, { x: 36, y: where === 'top' ? height - 28 : 18, size: 10, font, color: lib.rgb(0, 0, 0), maxWidth: width - 72 });
  }
  return doc.save();
}

type Page = ReturnType<Awaited<ReturnType<typeof loadPdf>>['addPage']>;
type Font = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdf>>['embedFont']>>;

/** Words wrapped to a width; returns the y below the last line. */
function drawWrapped(page: Page, font: Font, text: string, x: number, y: number, width: number, size: number): number {
  let yy = y;
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        page.drawText(line, { x, y: yy, size, font });
        yy -= size * 1.35;
        line = w;
      } else line = next;
    }
    page.drawText(line, { x, y: yy, size, font });
    yy -= size * 1.35;
  }
  return yy;
}

/** A new PDF from a draft's markdown: title, "## " headings, "- " bullets, paragraphs. */
export async function makePdf(title: string, markdown: string): Promise<Uint8Array> {
  const lib = await pdfLib();
  const doc = await lib.PDFDocument.create();
  doc.setTitle(winAnsi(title).slice(0, 120));
  const regular = await doc.embedFont(lib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(lib.StandardFonts.HelveticaBold);
  const [W, H, M] = [612, 792, 72];
  let page = doc.addPage([W, H]);
  let y = H - M;
  const need = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const lines = (font: Font, size: number, text: string, indent = 0, mark = '') => {
    const words = winAnsi(text).split(/\s+/);
    let line = '';
    let first = true;
    const flush = () => {
      need(size * 1.4);
      if (first && mark) page.drawText(mark, { x: M + indent - 12, y, size, font });
      page.drawText(line, { x: M + indent, y, size, font });
      y -= size * 1.4;
      first = false;
    };
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > W - 2 * M - indent && line) {
        flush();
        line = w;
      } else line = next;
    }
    if (line) flush();
  };
  if (title.trim()) {
    lines(bold, 16, title);
    y -= 8;
  }
  for (const raw of markdown.split('\n')) {
    const l = raw.trim();
    const h = /^#{1,3}\s+(.+)$/.exec(l);
    const b = /^[-*•]\s+(.+)$/.exec(l);
    if (!l) y -= 6;
    else if (h) {
      y -= 6;
      lines(bold, 13, h[1]!);
    } else if (b) lines(regular, 11, b[1]!, 14, '•');
    else lines(regular, 11, l);
  }
  return doc.save();
}

/** A new Word file from a draft's markdown, with real headings and bullets. */
export async function makeDocx(title: string, markdown: string): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const p = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${toXml(text)}</w:t></w:r></w:p>`;
  const body: string[] = [];
  if (title.trim()) body.push(p(title, 'Title'));
  for (const raw of markdown.split('\n')) {
    const l = raw.trim();
    const h = /^(#{1,3})\s+(.+)$/.exec(l);
    const b = /^[-*•]\s+(.+)$/.exec(l);
    if (!l) continue;
    if (h) body.push(p(h[2]!, `Heading${Math.max(1, h[1]!.length - 1)}`));
    else if (b) body.push(p(b[1]!, 'ListBullet'));
    else body.push(p(l));
  }
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  const style = (id: string, name: string, rpr: string, ppr = '') =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:rPr>${rpr}</w:rPr></w:style>`;
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>${style('Title', 'Title', '<w:b/><w:sz w:val="36"/>')}${style('Heading1', 'heading 1', '<w:b/><w:sz w:val="28"/>', '<w:spacing w:before="240"/>')}${style('Heading2', 'heading 2', '<w:b/><w:sz w:val="24"/>', '<w:spacing w:before="200"/>')}${style('ListBullet', 'List Bullet', '', '<w:ind w:left="360" w:hanging="360"/>')}</w:styles>`,
  );
  // List Bullet without a numbering part: a bullet character keeps it readable everywhere.
  const doc = body.map((x) => x.replace(/(<w:pStyle w:val="ListBullet"\/><\/w:pPr><w:r><w:t xml:space="preserve">)/, '$1• ')).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${doc}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** Replace words inside one run of a Word file, keeping everything else as it was. */
export async function replaceDocx(bytes: Uint8Array, find: string, replace: string): Promise<{ bytes: Uint8Array; count: number }> {
  const { zip, xml } = await docxPart(bytes);
  const want = toXml(find.trim());
  if (!want) throw new DocError('say which words to replace');
  let count = 0;
  const out = xml.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (m, open: string, inner: string, close: string) => {
    if (!inner.toLowerCase().includes(want.toLowerCase())) return m;
    const re = new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const next = inner.replace(re, () => (count++, toXml(replace)));
    return `${open.includes('xml:space') ? open : open.replace('<w:t', '<w:t xml:space="preserve"')}${next}${close}`;
  });
  if (!count) throw new DocError(`I couldn't find "${find.slice(0, 60)}" in one piece of that Word file`);
  zip.file('word/document.xml', out);
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), count };
}

/** Replace words in a text file. */
export function replaceText(bytes: Uint8Array, find: string, replace: string): { bytes: Uint8Array; count: number } {
  const t = plain(bytes);
  const want = find.trim();
  if (!want) throw new DocError('say which words to replace');
  let count = 0;
  const out = t.replace(new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), () => (count++, replace));
  if (!count) throw new DocError(`I couldn't find "${want.slice(0, 60)}" in that file`);
  return { bytes: new TextEncoder().encode(out), count };
}

export type DocOp =
  | { op: 'read'; kind: DocKind; bytes: Uint8Array }
  | { op: 'fill'; bytes: Uint8Array; values: Record<string, string> }
  | { op: 'replace'; kind: DocKind; bytes: Uint8Array; find: string; replace: string }
  | { op: 'addText'; bytes: Uint8Array; text: string; where: 'top' | 'bottom' | 'new page'; page?: number }
  | { op: 'makePdf'; title: string; text: string }
  | { op: 'makeDocx'; title: string; text: string };

/** One operation, by name: what the worker runs. */
export async function runOp(o: DocOp): Promise<unknown> {
  switch (o.op) {
    case 'read':
      return readDoc(o.kind, o.bytes);
    case 'fill':
      return fillPdf(o.bytes, o.values);
    case 'replace':
      return o.kind === 'pdf' ? replacePdf(o.bytes, o.find, o.replace) : o.kind === 'docx' ? replaceDocx(o.bytes, o.find, o.replace) : replaceText(o.bytes, o.find, o.replace);
    case 'addText':
      return addTextPdf(o.bytes, o.text, o.where, o.page);
    case 'makePdf':
      return makePdf(o.title, o.text);
    case 'makeDocx':
      return makeDocx(o.title, o.text);
  }
}
