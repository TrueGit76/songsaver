// Minimaler ZIP-Leser für den „Export All“-Download von Exportify (keine Bibliothek nötig).
// Unterstützt unkomprimierte (Methode 0) und Deflate-komprimierte Einträge (Methode 8).

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Liest alle Dateien eines ZIP-Archivs.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');

  // Das Inhaltsverzeichnis-Ende liegt in den letzten 22 + max. 65535 Bytes (Kommentar).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Die ZIP-Datei ist beschädigt oder unvollständig.');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = [];

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CENTRAL_SIG) throw new Error('Die ZIP-Datei ist beschädigt.');
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) throw new Error('Die ZIP-Datei ist beschädigt.');
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(start, start + compressedSize);

    if (method === 0) files.push({ name, bytes: data });
    else if (method === 8) files.push({ name, bytes: await inflateRaw(data) });
    else throw new Error(`Nicht unterstützte ZIP-Kompression (Methode ${method}).`);
  }
  return files;
}
