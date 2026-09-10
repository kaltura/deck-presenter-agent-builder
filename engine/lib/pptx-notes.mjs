import { readFileSync } from 'node:fs';
import { openZip, readZipText } from './pptx-zip.mjs';

const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const NOTES_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const SKIP_PLACEHOLDER_TYPES = new Set(['sldNum', 'dt', 'ftr', 'hdr']);

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ref in XML_ENTITIES ? XML_ENTITIES[ref] : m;
  });
}

function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function parseRels(xml) {
  const rels = [];
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const id = attrs.match(/\bId="([^"]*)"/)?.[1];
    const type = attrs.match(/\bType="([^"]*)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]*)"/)?.[1];
    if (id && type && target) rels.push({ id, type, target });
  }
  return rels;
}

function slideOrder(zip) {
  const presentation = readZipText(zip, 'ppt/presentation.xml');
  if (presentation === null) throw new Error('Not a valid .pptx: ppt/presentation.xml is missing.');
  const presRels = parseRels(readZipText(zip, 'ppt/_rels/presentation.xml.rels') || '');
  const byId = new Map(presRels.filter((r) => r.type === SLIDE_REL_TYPE).map((r) => [r.id, resolveTarget('ppt', r.target)]));

  const order = [];
  for (const m of presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"[^>]*\/>/g)) {
    const target = byId.get(m[1]);
    if (target) order.push(target);
  }
  return order;
}

function notesPartFor(zip, slidePart) {
  const dir = slidePart.slice(0, slidePart.lastIndexOf('/'));
  const name = slidePart.slice(slidePart.lastIndexOf('/') + 1);
  const relsPath = `${dir}/_rels/${name}.rels`;
  const relsXml = readZipText(zip, relsPath);
  if (relsXml === null) return null;
  const rel = parseRels(relsXml).find((r) => r.type === NOTES_REL_TYPE);
  return rel ? resolveTarget(dir, rel.target) : null;
}

function notesText(xml) {
  const blocks = [];
  for (const shapeMatch of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const shape = shapeMatch[1];
    const phType = shape.match(/<p:ph\b[^>]*\btype="([^"]*)"/)?.[1];
    if (phType && SKIP_PLACEHOLDER_TYPES.has(phType)) continue;

    const lines = [];
    for (const paraMatch of shape.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const runs = [...paraMatch[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXmlText(t[1]));
      lines.push(runs.join('').trim());
    }
    const text = lines.join('\n').trim();
    if (text) blocks.push(text);
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Returns [{ slide: 1, notes: 'string' }, ...] in presentation order. */
export function extractPptxNotes(pptxPath) {
  const zip = openZip(readFileSync(pptxPath));
  const slides = slideOrder(zip);
  if (slides.length === 0) throw new Error('Not a valid .pptx, or it has no slides in ppt/presentation.xml.');

  return slides.map((slidePart, i) => {
    const notesPart = notesPartFor(zip, slidePart);
    const xml = notesPart ? readZipText(zip, notesPart) : null;
    return { slide: i + 1, notes: xml ? notesText(xml) : '' };
  });
}

/** Renders the same "## Slide N" shape reference-ingestion.md expects from a hand-prepared notes.md. */
export function renderNotesMarkdown(notesBySlide) {
  const sections = notesBySlide.map(
    ({ slide, notes }) => `## Slide ${slide}\n\n${notes || '_No speaker notes._'}`,
  );
  return `# Speaker notes\n\n${sections.join('\n\n')}\n`;
}
