import { inflateRawSync } from 'node:zlib';

/**
 * The narrow slice of the ZIP format a .pptx needs: read the central
 * directory, then read one named entry (STORED or DEFLATE) by walking to
 * its local file header. No stdlib zip reader exists, and a real dependency
 * for this narrow, fully-specified slice of the format isn't worth adding.
 */
export function openZip(buf) {
  const searchStart = Math.max(0, buf.length - 65557); // 22-byte EOCD + max 0xFFFF comment
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= searchStart; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid zip file: no end-of-central-directory record found.');

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Malformed zip: central directory entry has the wrong signature.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

export function readZipEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const { buf } = zip;
  const p = entry.localHeaderOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`Malformed zip: local header for "${name}" has the wrong signature.`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${entry.method} for "${name}".`);
}

export function readZipText(zip, name) {
  const data = readZipEntry(zip, name);
  return data === null ? null : data.toString('utf8');
}
