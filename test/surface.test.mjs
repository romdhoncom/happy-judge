// Tests for the drawing surface and the PNG writer in ../main.ts.
//
//   node test/surface.test.mjs
//
// Covers the box downfilter, each primitive's bounds, the 5x7 glyph table, the
// fixed-seed xorshift, the encoder's round trip, and the entry end to end: two
// runs, identical bytes, a valid 1024x1024 PNG under 1 MiB, plus a 300 px
// preview in out/thumb.png so the picture can be judged at the size the judge
// shows it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

process.env.MAKEFUN_NO_RUN = '1';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { Surface, GLYPHS, makeRng, encodePng, crc32, MAX_BYTES } = await import(pathToFileURL(join(root, 'main.ts')).href);

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function near(a, b, slack, message) {
  assert(Math.abs(a - b) <= slack, `${message ?? ''} ${a} vs ${b}`);
}

function assertBufferEqual(a, b, message) {
  assert(a.length === b.length, `${message}: length ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`${message}: byte ${i} is ${a[i]}, expected ${b[i]}`);
  }
}

// --- PNG reading, for the round-trip and structure tests --------------------

function parseChunks(png) {
  assert(
    png.subarray(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]),
    'PNG signature',
  );
  const chunks = [];
  let pos = 8;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    const stored = png.readUInt32BE(pos + 8 + length);
    const computed = crc32(png, pos + 4, pos + 8 + length);
    chunks.push({ type, length, data, stored, computed });
    pos += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function decodePng(png) {
  const chunks = parseChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  assert(ihdr, 'IHDR present');
  const w = ihdr.data.readUInt32BE(0);
  const h = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colour = ihdr.data[9];
  assert(depth === 8 && colour === 2, `8-bit truecolour, got depth ${depth} colour ${colour}`);
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);
  const stride = w * 3;
  assert(raw.length === h * (stride + 1), `inflated ${raw.length}, expected ${h * (stride + 1)}`);
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1);
    const filter = raw[off];
    assert(filter <= 4, `filter type ${filter} on row ${y}`);
    for (let x = 0; x < stride; x++) {
      const cur = raw[off + 1 + x];
      const a = x >= 3 ? out[y * stride + x - 3] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y > 0 ? out[(y - 1) * stride + x - 3] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = cur + pred;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, data: out };
}

// --- the box downfilter -----------------------------------------------------

test('downfilter averages the supersamples of each output pixel', () => {
  const s = new Surface(2, 2, 2);
  s.clear(0x000000);
  s.rect(0, 0, 1, 2, 0xffffff); // left column only
  const out = s.downsample();
  assert(out.length === 2 * 2 * 3, 'output size');
  near(out[0], 255, 1, 'left column white');
  near(out[3], 0, 1, 'right column black');
});

test('downfilter output is exactly the output size at the real settings', () => {
  const s = new Surface(4, 3, 3);
  s.clear(0x204060);
  const out = s.downsample();
  assert(out.length === 4 * 3 * 3, 'size');
  near(out[0], 0x20, 1);
  near(out[1], 0x40, 1);
  near(out[2], 0x60, 1);
});

// --- primitives -------------------------------------------------------------

test('rect clips at the canvas edge instead of throwing', () => {
  const s = new Surface(8, 8, 2);
  s.clear(0x000000);
  s.rect(-20, -20, 24, 24, 0xff0000);
  const out = s.downsample();
  near(out[0], 255, 2, 'top left filled');
  near(out[(7 * 8 + 7) * 3], 0, 2, 'bottom right untouched');
});

test('circle paints its centre and not its corners', () => {
  const s = new Surface(40, 40, 1);
  s.clear(0x000000);
  s.circle(20, 20, 10, 0xffffff);
  const out = s.downsample();
  near(out[(20 * 40 + 20) * 3], 255, 2, 'centre');
  near(out[(20 * 40 + 31) * 3], 0, 2, 'right of the edge');
  near(out[(1 * 40 + 1) * 3], 0, 2, 'corner');
});

test('line covers both endpoints and nothing far away', () => {
  const s = new Surface(40, 40, 1);
  s.clear(0x000000);
  s.line(5, 5, 35, 35, 4, 0xffffff);
  const out = s.downsample();
  near(out[(5 * 40 + 5) * 3], 255, 2, 'start');
  near(out[(35 * 40 + 35) * 3], 255, 2, 'end');
  near(out[(5 * 40 + 35) * 3], 0, 2, 'off the line');
});

test('poly with fewer than three points draws nothing', () => {
  const s = new Surface(8, 8, 1);
  s.clear(0x000000);
  s.poly([[1, 1], [6, 6]], 0xffffff);
  const out = s.downsample();
  for (let i = 0; i < out.length; i++) assert(out[i] === 0, 'nothing painted');
});

test('poly fills its interior and leaves the outside alone', () => {
  const s = new Surface(20, 20, 1);
  s.clear(0x000000);
  s.poly([[5, 5], [15, 5], [15, 15], [5, 15]], 0x00ff00);
  const out = s.downsample();
  near(out[(10 * 20 + 10) * 3 + 1], 255, 2, 'inside green');
  near(out[(2 * 20 + 2) * 3 + 1], 0, 2, 'outside black');
});

test('glow only ever brightens', () => {
  const s = new Surface(20, 20, 1);
  s.clear(0x404040);
  const before = s.downsample();
  s.glow(10, 10, 9, 0xff8800, 0.8, 2);
  const after = s.downsample();
  for (let i = 0; i < before.length; i++) assert(after[i] >= before[i], `pixel ${i} darkened`);
});

// --- the glyph set ----------------------------------------------------------

test('every glyph is 7 rows of 5 bits', () => {
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    assert(rows.length === 7, `glyph ${ch} has ${rows.length} rows`);
    for (const row of rows) {
      assert(row.length === 5, `glyph ${ch} row has ${row.length} cells`);
      assert(/^[01]+$/.test(row), `glyph ${ch} row "${row}" is not bits`);
    }
  }
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') assert(GLYPHS[ch], `missing ${ch}`);
});

test('measureText and text agree on the advance', () => {
  const s = new Surface(400, 60, 1);
  s.clear(0x000000);
  const width = s.measureText('AB', 10);
  assert(width === 110, `measureText ${width}`);
  const end = s.text('AB', 100, 10, 10, 0xffffff);
  near(end, 220, 0.001, 'text returns the pen after the last glyph');
  const out = s.downsample();
  let lit = 0;
  for (let i = 0; i < out.length; i += 3) if (out[i] > 128) lit++;
  assert(lit > 50, `text painted ${lit} pixels`);
});

// --- the fixed-seed generator ----------------------------------------------

test('xorshift repeats for a seed and differs across seeds', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const c = makeRng(54321);
  const first = [];
  for (let i = 0; i < 8; i++) {
    const v = a.next();
    assert(v >= 0 && v < 1, `out of range ${v}`);
    assert(v === b.next(), `same seed diverged at ${i}`);
    first.push(v);
  }
  let differ = false;
  for (let i = 0; i < 8; i++) if (c.next() !== first[i]) differ = true;
  assert(differ, 'different seeds produced the same stream');
});

test('rng range stays inside its bounds', () => {
  const r = makeRng(7);
  for (let i = 0; i < 500; i++) {
    const v = r.range(-3, 9);
    assert(v >= -3 && v < 9, `range produced ${v}`);
    const n = r.int(10);
    assert(Number.isInteger(n) && n >= 0 && n < 10, `int produced ${n}`);
  }
});

// --- the encoder ------------------------------------------------------------

test('8x8 round trip keeps every byte', () => {
  const s = new Surface(8, 8, 1);
  const rng = makeRng(99);
  s.clear(0x102030);
  for (let i = 0; i < 12; i++) {
    s.rect(rng.int(8), rng.int(8), 1 + rng.int(4), 1 + rng.int(4), rng.int(0xffffff), 1);
  }
  const rgb = s.downsample();
  const png = encodePng(8, 8, rgb);
  const back = decodePng(png);
  assert(back.w === 8 && back.h === 8, 'dimensions');
  assertBufferEqual(back.data, rgb, 'pixels');
  for (const chunk of parseChunks(png)) {
    assert(chunk.stored === chunk.computed, `crc on ${chunk.type}`);
  }
});

// --- the entry, end to end --------------------------------------------------

test('two runs write the same bytes, and the file passes the gate limits', () => {
  const dirA = join(root, 'out', 'run-a');
  const dirB = join(root, 'out', 'run-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const env = { ...process.env };
  delete env.MAKEFUN_NO_RUN;
  for (const dir of [dirA, dirB]) {
    execFileSync(process.execPath, [join(root, 'main.ts')], { env: { ...env, MAKEFUN_OUTPUT_DIR: dir }, stdio: 'pipe' });
  }
  const a = readFileSync(join(dirA, 'entry.png'));
  const b = readFileSync(join(dirB, 'entry.png'));
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  assert(sha(a) === sha(b), `two runs differ: ${sha(a)} vs ${sha(b)}`);
  assert(a.length <= MAX_BYTES, `${a.length} bytes is over the limit`);
  const img = decodePng(a);
  assert(img.w === 1024 && img.h === 1024, `dimensions ${img.w}x${img.h}`);
  const chunks = parseChunks(a);
  assert(chunks[0].type === 'IHDR', 'IHDR first');
  assert(chunks[chunks.length - 1].type === 'IEND', 'IEND last');
  for (const chunk of chunks) assert(chunk.stored === chunk.computed, `crc on ${chunk.type}`);
  console.log(`     sha256 ${sha(a)}, ${a.length} bytes`);
});

test('the image still lands at 300 px', () => {
  const png = readFileSync(join(root, 'out', 'entry.png'));
  const img = decodePng(png);
  const dw = 300;
  const dh = 300;
  const small = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * img.h) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * img.w) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.w + sx) * 3;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (y * dw + x) * 3;
      small[o] = Math.round(r / n);
      small[o + 1] = Math.round(g / n);
      small[o + 2] = Math.round(b / n);
    }
  }
  writeFileSync(join(root, 'out', 'thumb.png'), encodePng(dw, dh, small));
  // The lit hatch and the dark bird must both survive the downscale.
  let brightest = 0;
  let darkest = 255;
  for (let i = 0; i < small.length; i += 3) {
    brightest = Math.max(brightest, small[i]);
    darkest = Math.min(darkest, small[i]);
  }
  assert(brightest > 230, `brightest ${brightest}`);
  assert(darkest < 40, `darkest ${darkest}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`FAIL ${name}\n  ${err.stack}`);
  process.exit(1);
}
