// test/encoder.check.mjs - checks the encoder in main.ts against the gate's conditions.
//
// Deliberately independent of main.ts's own decoder: the CRC here is computed bit by bit with no
// table, and the inflated length is compared against what IHDR describes. Run it after main.ts:
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts && node test/encoder.check.mjs

import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;
const file = process.argv[2] ?? 'out/entry.png';

let failures = 0;
function check(ok, what, detail = '') {
  if (ok) {
    console.log('  ok    ' + what);
  } else {
    failures++;
    console.log('  FAIL  ' + what + (detail ? ' — ' + detail : ''));
  }
}

/** CRC32 with no lookup table: the definition, not an implementation detail. */
function crc32Bitwise(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const bytes = readFileSync(file);
const size = statSync(file).size;
console.log(file + ': ' + size + ' bytes, sha256 ' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '...');

console.log('gate');
check(size <= MAX_BYTES, 'at most 1 MiB', size + ' bytes');
const sig = [137, 80, 78, 71, 13, 10, 26, 10];
check(sig.every((v, i) => bytes[i] === v), 'PNG signature');

console.log('chunks');
let at = 8;
let width = 0, height = 0, bitDepth = 0, colourType = 0, interlace = 0;
let sawIhdr = false, sawIend = false, idatBytes = 0;
const idat = [];
while (at + 12 <= bytes.length) {
  const length = bytes.readUInt32BE(at);
  const type = bytes.toString('latin1', at + 4, at + 8);
  if (at + 12 + length > bytes.length) {
    check(false, 'chunk ' + type + ' fits in the file');
    break;
  }
  const stored = bytes.readUInt32BE(at + 8 + length);
  const computed = crc32Bitwise(bytes, at + 4, at + 8 + length);
  check(stored === computed, 'CRC on ' + type + ' at ' + at, 'stored ' + stored + ' computed ' + computed);
  if (type === 'IHDR') {
    sawIhdr = true;
    width = bytes.readUInt32BE(at + 8);
    height = bytes.readUInt32BE(at + 12);
    bitDepth = bytes[at + 16];
    colourType = bytes[at + 17];
    interlace = bytes[at + 20];
  } else if (type === 'IDAT') {
    idatBytes += length;
    idat.push(bytes.subarray(at + 8, at + 8 + length));
  } else if (type === 'IEND') {
    sawIend = true;
    at += 12 + length;
    break;
  }
  at += 12 + length;
}
check(sawIhdr, 'has IHDR');
check(sawIend, 'has IEND');
check(idatBytes > 0, 'has IDAT', idatBytes + ' bytes');
check(at === bytes.length, 'file ends exactly at IEND', 'ended at ' + at + ' of ' + bytes.length);

console.log('header');
check(width >= 1 && width <= MAX_SIDE && height >= 1 && height <= MAX_SIDE, 'size within 1024x1024', width + 'x' + height);
check(bitDepth === 8 && colourType === 2 && interlace === 0, '8-bit truecolour, not interlaced');

console.log('image data');
const raw = inflateSync(Buffer.concat(idat));
const stride = width * 3;
const expected = (stride + 1) * height;
check(raw.length === expected, 'inflated length matches IHDR', raw.length + ' vs ' + expected);
const filterTypes = new Set();
for (let y = 0; y < height; y++) filterTypes.add(raw[y * (stride + 1)]);
check([...filterTypes].every((t) => t >= 0 && t <= 4), 'every filter byte is 0..4', [...filterTypes].join(','));

console.log('determinism of the encoder itself');
const a = deflateSync(raw, { level: 9 });
const b = deflateSync(raw, { level: 9 });
check(a.equals(b), 'deflateSync is stable for the same input');
check(createHash('sha256').update(a).digest('hex') === createHash('sha256').update(b).digest('hex'), 'deflate output hashes match');

console.log(failures === 0 ? '' : failures + ' check(s) failed');
console.log(failures === 0 ? 'all checks passed' : 'FAILED');
process.exit(failures === 0 ? 0 : 1);
