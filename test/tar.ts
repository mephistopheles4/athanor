// Tar streams, as `docker cp` would serve them, built for the copy-out tests.
// Erasable TypeScript only, like the other test files.

export interface TarSpec {
  name: string;
  // The type flag: '0' file (default), '5' folder, '1' hard link, '2' link,
  // '3' device, '6' FIFO, or any other.
  type?: string;
  content?: string | Buffer;
  prefix?: string;
  // Written as a PAX x header before the entry: path and size, or raw records.
  pax?: Record<string, string> | string[];
  // The name goes in a GNU L header before the entry.
  gnuLong?: boolean;
  // Replace the size field's text, or spoil the checksum.
  sizeField?: string;
  badChecksum?: boolean;
  // A size to write in the header instead of the content's length.
  declaredSize?: number;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function block(name: string, type: string, size: number, spec: { prefix?: string; sizeField?: string; badChecksum?: boolean } = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(spec.sizeField ?? octal(size, 12), 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  if (spec.prefix) h.write(spec.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(spec.badChecksum ? sum + 1 : sum, 7) + ' ', 148, 'latin1');
  return h;
}

const padded = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

// "<length> <key>=<value>\n", the length counting the whole record.
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

// A tar stream of the given entries, ending the way a real one does unless asked not to.
export function buildTar(specs: TarSpec[], { end = true }: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const type = spec.type ?? '0';
    const data = Buffer.from(spec.content ?? '');
    if (spec.pax) {
      const records = Array.isArray(spec.pax) ? spec.pax.join('') : Object.entries(spec.pax).map(([k, v]) => paxRecord(k, v)).join('');
      parts.push(block('PaxHeader/x', 'x', Buffer.byteLength(records)), padded(Buffer.from(records)));
    }
    let name = spec.name;
    if (spec.gnuLong) {
      const long = Buffer.from(name + '\0');
      parts.push(block('././@LongLink', 'L', long.length), padded(long));
      name = name.slice(0, 50);
    }
    parts.push(block(name, type, spec.declaredSize ?? data.length, spec), padded(data));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
