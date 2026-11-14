// "The usual" — a night ice-cream van and the pigeon that pays for its cone.
//
// Node 22, standard library only, no network. Draws one 1024x1024 PNG from the
// tables in this file and writes it to $MAKEFUN_OUTPUT_DIR/entry.png
// (default /output/entry.png).
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Nothing here is random: the only pseudo-randomness is a fixed-seed xorshift,
// and every colour, path and glyph is a constant, so two runs write the same
// bytes.
//
// Layout of this file:
//   1. raster core   — CRC32, chunk writer, adaptive filters, PNG assembly
//   2. drawing surface — supersampled canvas, shape/stroke/light primitives,
//                        5x7 glyph set, box downfilter
//   3. fixed-seed xorshift
//   4. the scene
//   5. main

import { deflateSync, inflateSync, constants as zc } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1024;
const H = 1024;
const SS = 5; // supersamples per axis: the canvas is 5120x5120, box-filtered down
const ZOOM = 1.25; // the frame crops to the middle 819x819 of the scene
const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;

// ---------------------------------------------------------------- raster core

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter each scanline with whichever of None/Sub/Up/Paeth leaves the smallest
// sum of absolute signed residuals, then deflate the whole thing.
function filterRows(w, h, rgb) {
  const stride = w * 3;
  const rows = Buffer.allocUnsafe(h * (stride + 1));
  const zero = new Uint8Array(stride);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  const TYPES = [0, 1, 2, 4];
  for (let y = 0; y < h; y++) {
    const cur = rgb.subarray(y * stride, y * stride + stride);
    const prev = y === 0 ? zero : rgb.subarray((y - 1) * stride, (y - 1) * stride + stride);
    let best = 0;
    let bestScore = Infinity;
    for (let t = 0; t < 4; t++) {
      const type = TYPES[t];
      const out = cand[t];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? cur[i - 3] : 0;
        const b = prev[i];
        let v;
        if (type === 0) v = cur[i];
        else if (type === 1) v = cur[i] - a;
        else if (type === 2) v = cur[i] - b;
        else v = cur[i] - paeth(a, b, i >= 3 ? prev[i - 3] : 0);
        v &= 255;
        out[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    const off = y * (stride + 1);
    rows[off] = TYPES[best];
    rows.set(cand[best], off + 1);
  }
  return rows;
}

function encodePng(w, h, rgb) {
  if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) {
    throw new Error(`png: ${w}x${h} is outside the 1..${MAX_SIDE} limit`);
  }
  if (rgb.length !== w * h * 3) {
    throw new Error(`png: expected ${w * h * 3} rgb bytes, got ${rgb.length}`);
  }
  const rows = filterRows(w, h, rgb);
  let idat = null;
  for (const strategy of [zc.Z_DEFAULT_STRATEGY, zc.Z_FILTERED]) {
    const data = deflateSync(rows, { level: 9, memLevel: 9, strategy });
    if (idat === null || data.length < idat.length) idat = data;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  if (png.length > MAX_BYTES) {
    throw new Error(`entry.png came out ${png.length} bytes, over the ${MAX_BYTES} byte limit`);
  }
  return png;
}

// ---- encoder self-test ------------------------------------------------------
//
// An 8x8 image goes through encodePng and back: the chunks are walked, every CRC
// recomputed, the IDAT inflated and unfiltered, and each pixel compared. A
// difference throws before the real image is drawn, so a broken encoder can never
// quietly write a file the gate would reject.

function inflateAndUnfilter(png) {
  let at = 8;
  let w = 0;
  let h = 0;
  const parts = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (at + 12 + len > png.length) throw new Error('png: truncated ' + type);
    if (png.readUInt32BE(at + 8 + len) !== crc32(png, at + 4, at + 8 + len)) {
      throw new Error('png: bad CRC on ' + type);
    }
    if (type === 'IHDR') {
      w = png.readUInt32BE(at + 8);
      h = png.readUInt32BE(at + 12);
      if (png[at + 16] !== 8 || png[at + 17] !== 2 || png[at + 20] !== 0) {
        throw new Error('png: not 8-bit truecolour, not interlaced');
      }
    } else if (type === 'IDAT') {
      parts.push(png.subarray(at + 8, at + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = w * 3;
  if (raw.length !== (stride + 1) * h) {
    throw new Error('png: inflated length is not what IHDR describes');
  }
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    const type = raw[row];
    const base = y * stride;
    const prev = y > 0 ? (y - 1) * stride : -1;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? out[base + i - 3] : 0;
      const b = prev >= 0 ? out[prev + i] : 0;
      const c = prev >= 0 && i >= 3 ? out[prev + i - 3] : 0;
      let v = raw[row + 1 + i];
      if (type === 1) v = (v + a) & 255;
      else if (type === 2) v = (v + b) & 255;
      else if (type === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (type === 4) v = (v + paeth(a, b, c)) & 255;
      out[base + i] = v;
    }
  }
  return { w, h, rgb: out };
}

function smokeTestPng() {
  const w = 8;
  const h = 8;
  const src = new Uint8Array(w * h * 3);
  for (let i = 0; i < src.length; i++) src[i] = (i * 37 + 11) & 255;
  const back = inflateAndUnfilter(encodePng(w, h, src));
  if (back.w !== w || back.h !== h) throw new Error('smoke: size round-trip failed');
  for (let i = 0; i < src.length; i++) {
    if (back.rgb[i] !== src[i]) throw new Error('smoke: pixel byte ' + i + ' round-trip failed');
  }
  if (crc32(Buffer.from('123456789', 'latin1'), 0, 9) !== 0xcbf43926) {
    throw new Error('smoke: crc32 check vector failed');
  }
}

// ----------------------------------------------------------- drawing surface
//
// Everything is drawn on a canvas SS times wider and taller than the output,
// then box-filtered down, so edges get SS*SS levels of coverage for free.
// Public coordinates are output pixels (fractions welcome).

function rgbOf(c) {
  return Array.isArray(c) ? c : [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

class Surface {
  constructor(w, h, ss) {
    this.w = w;
    this.h = h;
    this.ss = ss;
    this.sw = w * ss;
    this.sh = h * ss;
    this.buf = new Uint8ClampedArray(this.sw * this.sh * 3);
  }

  clear(c, a = 1) {
    const [r, g, b] = rgbOf(c);
    const buf = this.buf;
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = buf[i] + (r - buf[i]) * a;
      buf[i + 1] = buf[i + 1] + (g - buf[i + 1]) * a;
      buf[i + 2] = buf[i + 2] + (b - buf[i + 2]) * a;
    }
  }

  _blend(ix, r, g, b, a) {
    const buf = this.buf;
    if (a >= 1) {
      buf[ix] = r;
      buf[ix + 1] = g;
      buf[ix + 2] = b;
      return;
    }
    if (a <= 0) return;
    buf[ix] = buf[ix] + (r - buf[ix]) * a;
    buf[ix + 1] = buf[ix + 1] + (g - buf[ix + 1]) * a;
    buf[ix + 2] = buf[ix + 2] + (b - buf[ix + 2]) * a;
  }

  rect(x, y, w, h, c, a = 1) {
    const S = this.ss;
    const [r, g, b] = rgbOf(c);
    const x0 = Math.max(0, Math.round(x * S));
    const y0 = Math.max(0, Math.round(y * S));
    const x1 = Math.min(this.sw, Math.round((x + w) * S));
    const y1 = Math.min(this.sh, Math.round((y + h) * S));
    for (let py = y0; py < y1; py++) {
      let ix = (py * this.sw + x0) * 3;
      for (let px = x0; px < x1; px++, ix += 3) this._blend(ix, r, g, b, a);
    }
  }

  roundRect(x, y, w, h, radius, c, a = 1) {
    const S = this.ss;
    const [r, g, b] = rgbOf(c);
    const x0 = x * S;
    const y0 = y * S;
    const x1 = (x + w) * S;
    const y1 = (y + h) * S;
    const rad = Math.max(0, Math.min(radius * S, (x1 - x0) / 2, (y1 - y0) / 2));
    const ix0 = Math.max(0, Math.floor(x0));
    const iy0 = Math.max(0, Math.floor(y0));
    const ix1 = Math.min(this.sw, Math.ceil(x1));
    const iy1 = Math.min(this.sh, Math.ceil(y1));
    const r2 = rad * rad;
    for (let py = iy0; py < iy1; py++) {
      const yc = py + 0.5;
      const dy = Math.max(y0 + rad - yc, 0, yc - (y1 - rad));
      let ix = (py * this.sw + ix0) * 3;
      for (let px = ix0; px < ix1; px++, ix += 3) {
        const xc = px + 0.5;
        const dx = Math.max(x0 + rad - xc, 0, xc - (x1 - rad));
        if (dx * dx + dy * dy <= r2) this._blend(ix, r, g, b, a);
      }
    }
  }

  circle(cx, cy, radius, c, a = 1) {
    this.ellipse(cx, cy, radius, radius, c, a, 0);
  }

  ellipse(cx, cy, rx, ry, c, a = 1, angle = 0) {
    const S = this.ss;
    const [r, g, b] = rgbOf(c);
    const cxS = cx * S;
    const cyS = cy * S;
    const rxS = rx * S;
    const ryS = ry * S;
    const ext = Math.max(rxS, ryS);
    const co = Math.cos(-angle);
    const si = Math.sin(-angle);
    const ix0 = Math.max(0, Math.floor(cxS - ext));
    const ix1 = Math.min(this.sw, Math.ceil(cxS + ext));
    const iy0 = Math.max(0, Math.floor(cyS - ext));
    const iy1 = Math.min(this.sh, Math.ceil(cyS + ext));
    for (let py = iy0; py < iy1; py++) {
      const dy = py + 0.5 - cyS;
      let ix = (py * this.sw + ix0) * 3;
      for (let px = ix0; px < ix1; px++, ix += 3) {
        const dx = px + 0.5 - cxS;
        const u = dx * co - dy * si;
        const v = dx * si + dy * co;
        if ((u * u) / (rxS * rxS) + (v * v) / (ryS * ryS) <= 1) this._blend(ix, r, g, b, a);
      }
    }
  }

  // Even-odd scanline fill. pts: [[x,y], ...] in output pixels.
  poly(pts, c, a = 1) {
    const S = this.ss;
    const [r, g, b] = rgbOf(c);
    const n = pts.length;
    if (n < 3) return;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < n; i++) {
      xs[i] = pts[i][0] * S;
      ys[i] = pts[i][1] * S;
      if (ys[i] < minY) minY = ys[i];
      if (ys[i] > maxY) maxY = ys[i];
      if (xs[i] < minX) minX = xs[i];
      if (xs[i] > maxX) maxX = xs[i];
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.sh - 1, Math.ceil(maxY));
    const cx0 = Math.max(0, Math.floor(minX));
    const cx1 = Math.min(this.sw - 1, Math.ceil(maxX));
    const cross = [];
    for (let py = y0; py <= y1; py++) {
      const yc = py + 0.5;
      cross.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ya = ys[j];
        const yb = ys[i];
        if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) {
          const t = (yc - ya) / (yb - ya);
          cross.push(xs[j] + t * (xs[i] - xs[j]));
        }
      }
      if (cross.length < 2) continue;
      cross.sort((p, q) => p - q);
      for (let k = 0; k + 1 < cross.length; k += 2) {
        const from = Math.max(cx0, Math.ceil(cross[k] - 0.5));
        const to = Math.min(cx1, Math.ceil(cross[k + 1] - 0.5) - 1);
        let ix = (py * this.sw + from) * 3;
        for (let px = from; px <= to; px++, ix += 3) this._blend(ix, r, g, b, a);
      }
    }
  }

  // Round-capped thick segment.
  line(x0, y0, x1, y1, width, c, a = 1) {
    const S = this.ss;
    const [r, g, b] = rgbOf(c);
    const hw = (width * S) / 2;
    const ax = x0 * S;
    const ay = y0 * S;
    const bx = x1 * S;
    const by = y1 * S;
    const ix0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw));
    const ix1 = Math.min(this.sw - 1, Math.ceil(Math.max(ax, bx) + hw));
    const iy0 = Math.max(0, Math.floor(Math.min(ay, by) - hw));
    const iy1 = Math.min(this.sh - 1, Math.ceil(Math.max(ay, by) + hw));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const hw2 = hw * hw;
    for (let py = iy0; py <= iy1; py++) {
      const yc = py + 0.5;
      let ix = (py * this.sw + ix0) * 3;
      for (let px = ix0; px <= ix1; px++, ix += 3) {
        const xc = px + 0.5;
        let t = ((xc - ax) * dx + (yc - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = xc - (ax + t * dx);
        const ey = yc - (ay + t * dy);
        if (ex * ex + ey * ey <= hw2) this._blend(ix, r, g, b, a);
      }
    }
  }

  // A path: segments plus a disc at every vertex. Draw paths at a = 1; a
  // translucent path double-blends where its segments overlap.
  polyline(pts, width, c, a = 1) {
    for (let i = 1; i < pts.length; i++) {
      this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width, c, a);
    }
    if (a < 1) return;
    for (const p of pts) this.circle(p[0], p[1], width / 2, c, a);
  }

  arc(cx, cy, radius, from, to, width, c, a = 1) {
    const steps = Math.max(6, Math.ceil((Math.abs(to - from) * radius) / 6));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      pts.push([cx + Math.cos(t) * radius, cy + Math.sin(t) * radius]);
    }
    this.polyline(pts, width, c, a);
  }

  quad(p0, p1, p2, width, c, a = 1) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const u = 1 - t;
      pts.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
    }
    this.polyline(pts, width, c, a);
  }

  cubic(p0, p1, p2, p3, width, c, a = 1) {
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      pts.push([w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0], w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]]);
    }
    this.polyline(pts, width, c, a);
  }

  // Additive radial light: brightens what is under it, never darkens.
  glow(cx, cy, radius, c, strength = 1, power = 3) {
    const S = this.ss;
    const [r, g, b] = rgbOf(c);
    const cxS = cx * S;
    const cyS = cy * S;
    const rS = radius * S;
    const ix0 = Math.max(0, Math.floor(cxS - rS));
    const ix1 = Math.min(this.sw, Math.ceil(cxS + rS));
    const iy0 = Math.max(0, Math.floor(cyS - rS));
    const iy1 = Math.min(this.sh, Math.ceil(cyS + rS));
    const buf = this.buf;
    for (let py = iy0; py < iy1; py++) {
      const dy = (py + 0.5 - cyS) / rS;
      let ix = (py * this.sw + ix0) * 3;
      for (let px = ix0; px < ix1; px++, ix += 3) {
        const dx = (px + 0.5 - cxS) / rS;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const t = 1 - Math.sqrt(d2);
        let k = strength;
        for (let p = 0; p < power; p++) k *= t;
        buf[ix] = buf[ix] + r * k;
        buf[ix + 1] = buf[ix + 1] + g * k;
        buf[ix + 2] = buf[ix + 2] + b * k;
      }
    }
  }

  // Vertical two-stop gradient over a rectangle.
  vgrad(x, y, w, h, top, bottom, a = 1) {
    const S = this.ss;
    const [r0, g0, b0] = rgbOf(top);
    const [r1, g1, b1] = rgbOf(bottom);
    const x0 = Math.max(0, Math.round(x * S));
    const x1 = Math.min(this.sw, Math.round((x + w) * S));
    const y0 = Math.max(0, Math.round(y * S));
    const y1 = Math.min(this.sh, Math.round((y + h) * S));
    const span = Math.max(1, y1 - y0 - 1);
    for (let py = y0; py < y1; py++) {
      const t = (py - y0) / span;
      const r = r0 + (r1 - r0) * t;
      const g = g0 + (g1 - g0) * t;
      const b = b0 + (b1 - b0) * t;
      let ix = (py * this.sw + x0) * 3;
      for (let px = x0; px < x1; px++, ix += 3) this._blend(ix, r, g, b, a);
    }
  }

  // Deterministic per-pixel grain from the caller's seeded generator.
  grain(x, y, w, h, amount, rng) {
    const S = this.ss;
    const x0 = Math.max(0, Math.floor(x * S));
    const x1 = Math.min(this.sw, Math.ceil((x + w) * S));
    const y0 = Math.max(0, Math.floor(y * S));
    const y1 = Math.min(this.sh, Math.ceil((y + h) * S));
    const half = (amount * 255) / 2;
    for (let py = y0; py < y1; py++) {
      let ix = (py * this.sw + x0) * 3;
      for (let px = x0; px < x1; px++, ix += 3) {
        const n = (rng.next() - 0.5) * 2 * half;
        this.buf[ix] = this.buf[ix] + n;
        this.buf[ix + 1] = this.buf[ix + 1] + n;
        this.buf[ix + 2] = this.buf[ix + 2] + n;
      }
    }
  }

  measureText(text, cell, opts = {}) {
    const spacing = opts.spacing === undefined ? 1 : opts.spacing;
    const n = [...text].length;
    return Math.max(0, n * (5 + spacing) * cell - spacing * cell);
  }

  // 5x7 cell glyphs, drawn as rounded cells so the letterforms stay soft at
  // large sizes. Lowercase renders as small caps at opts.small of the height.
  text(text, x, y, cell, c, a = 1, opts = {}) {
    const spacing = opts.spacing === undefined ? 1 : opts.spacing;
    const small = opts.small === undefined ? 0.82 : opts.small;
    const advance = (5 + spacing) * cell;
    let pen = x;
    if (opts.align === 'center') pen -= this.measureText(text, cell, opts) / 2;
    else if (opts.align === 'right') pen -= this.measureText(text, cell, opts);
    for (const ch of String(text)) {
      const glyph = GLYPHS[ch] || GLYPHS[ch.toUpperCase()] || GLYPHS['?'];
      const lower = ch >= 'a' && ch <= 'z';
      const cs = lower ? cell * small : cell;
      const oy = y + (7 * cell - 7 * cs);
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col++) {
          if (bits[col] !== '1') continue;
          const px = pen + col * cs;
          const py = oy + row * cs;
          this.roundRect(px, py, cs, cs, cs * 0.18, c, a);
        }
      }
      pen += advance;
    }
    return pen;
  }

  // Box downfilter, optionally zoomed in: each output pixel averages a
  // (ss / zoom)-sample square of the supersampled canvas, and the frame is the
  // centred crop of that size. With ss 5 and zoom 1.25 the step is exactly 4
  // samples, so the zoom costs no resampling blur.
  downsample(zoom = 1) {
    const { w, h, ss, sw, sh, buf } = this;
    const step = Math.max(1, Math.round(ss / zoom));
    const ox = Math.max(0, Math.round((sw - step * w) / 2));
    const oy = Math.max(0, Math.round((sh - step * h) / 2));
    const out = new Uint8Array(w * h * 3);
    const n = step * step;
    for (let y = 0; y < h; y++) {
      const sy0 = oy + y * step;
      for (let x = 0; x < w; x++) {
        const sx0 = ox + x * step;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < step; sy++) {
          let ix = ((sy0 + sy) * sw + sx0) * 3;
          for (let sx = 0; sx < step; sx++) {
            r += buf[ix];
            g += buf[ix + 1];
            b += buf[ix + 2];
            ix += 3;
          }
        }
        const o = (y * w + x) * 3;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
      }
    }
    return out;
  }
}

// 5 wide, 7 tall. '1' is ink.
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '01100', '01000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  "'": ['00100', '00100', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '00100', '00000', '00000', '00100', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

// ------------------------------------------------------------------- xorshift

function makeRng(seed) {
  let s = seed >>> 0 || 0x1f123bb5;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length) % list.length],
  };
}

// --------------------------------------------------------------------- scene

const PAL = {
  skyTop: 0x080b19,
  skyLow: 0x1e2748,
  ground: 0x0e1220,
  vanBody: 0x1a2033,
  vanDark: 0x121726,
  inkSoft: 0x231d2d,
  chalk: 0xf3e6c9,
};

function drawScene(s) {
  const rng = makeRng(0x5eed1234);

  // Night sky, low and quiet.
  s.vgrad(0, 0, W, 700, PAL.skyTop, PAL.skyLow);
  for (let i = 0; i < 130; i++) {
    const x = rng.range(0, W);
    const y = rng.range(0, 430);
    const r = rng.range(0.6, 1.6);
    s.circle(x, y, r, 0xdbe4ff, rng.range(0.12, 0.42));
  }
  // A faint city glow on the horizon, behind the van.
  s.glow(512, 700, 640, 0x2c3a63, 0.5, 2);

  // Street, with the hatch's light spilling down onto the pavement in front of
  // the van. The night outside the pool stays dark; the pool is what the hatch
  // does to the road.
  s.rect(0, 660, W, H - 660, PAL.ground);
  s.rect(0, 660, W, 3, 0x2a3350);
  s.glow(505, 706, 430, 0x8a5622, 0.55, 2);
  s.ellipse(505, 706, 320, 78, 0x7a4c22, 0.2); // the light pool, raked forward
  s.ellipse(505, 718, 220, 46, 0x96632c, 0.2);
  s.ellipse(505, 736, 140, 26, 0xa87034, 0.18);

  // Wheels, then body, so the body overlaps them.
  s.circle(268, 762, 48, 0x07080e);
  s.circle(762, 762, 48, 0x07080e);
  s.circle(268, 762, 20, 0x1b2233);
  s.circle(762, 762, 20, 0x1b2233);
  s.arc(268, 762, 46, 0.3, 2.84, 5, 0x232a3c, 0.55); // road light on the tyre
  s.arc(762, 762, 46, 0.3, 2.84, 5, 0x232a3c, 0.55);

  // Van body and roof.
  s.roundRect(140, 300, 744, 470, 28, PAL.vanBody);
  s.roundRect(124, 262, 776, 48, 20, 0x252d45);
  s.rect(124, 294, 776, 10, PAL.vanDark);
  s.rect(136, 258, 752, 2.5, 0x7d90c0, 0.28); // moonlight on the roof rail
  s.rect(140, 300, 3, 340, 0x6d80b0, 0.18); // and down the near edge
  s.rect(881, 300, 3, 340, 0x6d80b0, 0.18);
  s.glow(505, 700, 300, 0x8a5c2a, 0.22, 2); // the road's warmth on the paint

  // Hatch: the only light in the frame. The wall stays a deep amber so the
  // scoop, not the wall, is the brightest thing in the hatch.
  s.roundRect(232, 368, 556, 256, 16, 0xe8a96a);
  s.vgrad(240, 376, 540, 240, 0xffd9a4, 0xeeae70);
  s.glow(508, 440, 400, 0xff9a4a, 0.26, 2);
  s.glow(508, 580, 300, 0xffd197, 0.22, 2);

  // Awning over the hatch: alternating fabric stripes, each ending in a
  // half-round scallop, so the hem reads as cloth rather than a string of beads.
  {
    const stripes = 11;
    const sw = 566 / stripes;
    for (let i = 0; i < stripes; i++) {
      const color = i % 2 === 0 ? 0xd8c19a : 0xbfa47c;
      const x = 226 + i * sw;
      s.rect(x, 340, sw + 0.5, 26, color);
      s.ellipse(x + sw / 2, 366, sw / 2, 13, color);
    }
    s.rect(226, 340, 566, 3, 0xe6d3ae, 0.55); // light on the awning's top rail
    s.rect(226, 336, 566, 5, 0xa88f68); // the rail it hangs from
  }

  // Counter ledge.
  s.roundRect(206, 618, 618, 30, 10, 0xf7d9ad);
  s.rect(206, 642, 618, 9, 0xc79a63);

  // Vendor: leaning out of the hatch, one arm bent at the elbow to hold the
  // cone steady. The other arm stays behind the counter.
  const ink = PAL.inkSoft;
  s.poly(
    [
      [296, 624],
      [302, 530],
      [316, 494],
      [342, 476],
      [372, 472],
      [402, 484],
      [422, 512],
      [430, 624],
    ],
    ink,
  ); // torso with sloped shoulders, not a slab
  s.circle(352, 424, 38, ink); // head
  s.poly(
    [
      [310, 404],
      [396, 404],
      [386, 374],
      [320, 374],
    ],
    0x2c2536,
  ); // paper hat
  s.poly(
    [
      [306, 402],
      [406, 402],
      [406, 392],
      [306, 392],
    ],
    0x362e42,
  ); // hat brim
  // A face lit by the hatch: two happy squints, a smile and a flush of colour.
  // Small marks, and the silhouette becomes a person instead of a shape.
  s.arc(339, 424, 8, -2.6, -0.55, 3.5, 0xffc089, 0.95); // left squint
  s.arc(367, 424, 8, -2.6, -0.55, 3.5, 0xffc089, 0.95); // right squint
  s.arc(371, 412, 11, -2.95, -2.15, 2.5, 0xffc089, 0.45); // one raised brow
  s.arc(352, 440, 14, 0.42, 2.72, 4, 0xffc089, 0.98); // the smile
  s.arc(352, 424, 38, -0.7, 0.15, 4, 0xffa868, 0.45); // warm edge on the cheek

  // Shoulder, elbow, wrist: one bend, so the arm reaches rather than points.
  s.polyline(
    [
      [408, 514],
      [470, 590],
      [534, 562],
    ],
    29,
    ink,
  );
  s.line(468, 602, 536, 574, 2.5, 0xffa868, 0.3); // rim under the forearm

  // The cone: tip in the fist, wafer leaning up toward the customer.
  const tip = [532, 576];
  const wide = [584, 516];
  {
    const dx = wide[0] - tip[0];
    const dy = wide[1] - tip[1];
    const len = Math.hypot(dx, dy);
    const ux = -dy / len;
    const uy = dx / len;
    const hw = 27;
    const p1 = [wide[0] + ux * hw, wide[1] + uy * hw];
    const p2 = [wide[0] - ux * hw, wide[1] - uy * hw];
    s.poly([tip, p1, p2], 0xf0d3a0);
    const lerp = (a, b2, t) => [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t];
    for (const t of [0.3, 0.56, 0.8]) {
      const a1 = lerp(tip, p1, t);
      const a2 = lerp(tip, p2, t);
      s.line(a1[0], a1[1], a2[0], a2[1], 2.5, 0xc79a58, 0.65);
    }
    s.line(lerp(tip, p1, 0.15)[0], lerp(tip, p1, 0.15)[1], lerp(tip, p2, 0.7)[0], lerp(tip, p2, 0.7)[1], 2, 0xc79a58, 0.5);
    s.line(lerp(tip, p2, 0.15)[0], lerp(tip, p2, 0.15)[1], lerp(tip, p1, 0.7)[0], lerp(tip, p1, 0.7)[1], 2, 0xc79a58, 0.5);
    s.arc(wide[0], wide[1], 27, 3.35, 6.05, 3, 0xd3a86e, 0.6); // shadow under the cream
  }
  // Soft-serve: four curls, each undercut by the shadow of the one above, so
  // the spiral reads as a swirl and not as a cloud. A swirl says ice cream at
  // any size; a ball of white says lamp.
  const cream = 0xfff2d2;
  const creamLit = 0xfffbf0;
  const creamShade = 0xe4b87e;
  s.circle(588, 508, 30, cream); // base curl, overhanging the wafer
  s.circle(594, 490, 25, creamShade); // undercut beneath curl two
  s.circle(592, 488, 23, cream);
  s.circle(592, 474, 18, creamShade); // undercut beneath curl three
  s.circle(586, 470, 16, cream);
  s.circle(594, 459, 10, creamShade);
  s.circle(594, 456, 9, cream);
  s.arc(588, 508, 30, 2.35, 3.9, 2.4, 0xd9ab6f, 0.5); // the fold at the cone's lip
  s.ellipse(576, 504, 7, 12, creamLit, 0.55, -0.5); // lit face of each curl
  s.ellipse(580, 486, 6, 9, creamLit, 0.5, -0.4);
  s.ellipse(578, 470, 4, 6, creamLit, 0.45, -0.3);
  s.circle(600, 443, 9, 0xd6453f); // the cherry on top
  s.circle(597, 440, 3, 0xff9a86, 0.8);
  s.arc(601, 434, 9, -2.4, -1.1, 2.5, 0x6f2f2f, 0.9); // its stem
  s.roundRect(611, 514, 9, 28, 4.5, cream); // one drip off the base curl
  s.circle(615, 542, 5, cream);

  // The fist, afterwards, so the fingers sit over the wafer and the cone reads
  // as held rather than balanced.
  s.circle(532, 576, 15, ink);
  s.circle(519, 567, 7.5, ink); // thumb
  s.circle(544, 571, 6, ink); // fingers curling round the tip
  s.circle(541, 583, 6, ink);
  s.arc(532, 576, 15, -2.0, -0.4, 3, 0xffb877, 0.5); // warm edge on the hand

  // The pigeon: slate so it sits cool in the warm hatch, up on the counter with
  // its beak already in the cream. A blue ring on one leg, because it is a
  // regular and someone once raced it.
  const b = 0x37364d;
  const bDark = 0x2a2940;
  const bPale = 0x45445d;
  const bNeck = 0x2f5a5c;
  s.ellipse(700, 620, 70, 9, 0x8a6a3a, 0.32); // its shadow on the ledge
  s.poly(
    [
      [728, 584],
      [778, 624],
      [764, 637],
      [718, 608],
    ],
    bDark,
  ); // tail
  s.ellipse(672, 536, 24, 34, bNeck, 1, -0.5); // iridescent neck, between body and head
  s.ellipse(708, 568, 56, 44, b, 1, -0.12); // body
  s.ellipse(680, 556, 26, 36, bPale, 0.5, -0.3); // chest catching the hatch
  s.ellipse(720, 578, 42, 25, bDark, 1, -0.16); // folded wing
  s.arc(720, 580, 36, 0.15, 1.15, 2, 0x53526e, 0.5); // feather edge
  s.line(700, 600, 700, 618, 5.5, 0xb4645a); // legs
  s.line(726, 600, 726, 618, 5.5, 0xb4645a);
  s.line(692, 619, 704, 619, 4.5, 0xb4645a); // toes
  s.line(722, 619, 734, 619, 4.5, 0xb4645a);
  s.line(696, 610, 704, 612, 4, 0x4f8fd0); // the ring on its leg
  s.circle(648, 508, 24, bPale); // head
  s.circle(626, 507, 6, 0xc9a9a0); // cere
  s.poly(
    [
      [628, 503],
      [610, 499],
      [627, 515],
    ],
    0x191524,
  ); // short beak, in the cream
  s.arc(642, 500, 7, -2.55, -0.7, 3, 0xffd9a0, 0.95); // a contented closed eye
  s.arc(648, 508, 24, -2.7, -1.0, 3, 0xffb877, 0.5); // warm rim on the head
  s.arc(708, 568, 54, -2.9, -1.6, 3, 0xffb877, 0.2); // and along its back

  // Paid in full: three coins stacked on the ledge, and the fourth still
  // leaning where the pigeon nudged it across the counter.
  for (let i = 0; i < 3; i++) {
    const cy = 604 - i * 9;
    s.ellipse(626, cy, 20, 8, 0x5f3708);
    s.ellipse(626, cy - 2, 18, 6.5, 0xffc65e);
    s.ellipse(623, cy - 3.5, 11, 3, 0xffe9b8, 0.65);
  }
  s.ellipse(644, 616, 15, 6.5, 0x5f3708);
  s.ellipse(644, 614, 13, 5, 0xffd27a);
  s.ellipse(641, 612.5, 7.5, 2.2, 0xfff0c8, 0.7);

  // Chalkboard on the van front: the joke, in the vendor's own hand.
  s.roundRect(456, 664, 220, 100, 10, 0x0b0f16);
  s.roundRect(462, 670, 208, 88, 8, 0x141a26);
  s.text('THE', 566, 676, 5, PAL.chalk, 0.9, { align: 'center' });
  s.text('USUAL', 566, 716, 5, PAL.chalk, 0.9, { align: 'center' });

  // A last breath of warm haze so the light has somewhere to go.
  s.glow(500, 650, 320, 0x6b3f14, 0.22, 2);
}

// ---------------------------------------------------------------------- main

function main() {
  smokeTestPng();
  const surface = new Surface(W, H, SS);
  drawScene(surface);
  const png = encodePng(W, H, surface.downsample(ZOOM));
  const dir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'entry.png');
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes, ${W}x${H})`);
}

export { Surface, GLYPHS, makeRng, encodePng, filterRows, crc32, drawScene, main, W, H, SS, MAX_BYTES };

// The grader runs this file directly, so it draws on every invocation unless a
// test sets MAKEFUN_NO_RUN to import the pieces without drawing.
if (!process.env.MAKEFUN_NO_RUN) main();
