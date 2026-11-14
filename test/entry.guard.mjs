// test/entry.guard.mjs - the shipped encoder's limits, straight from main.ts.
//
// MAKEFUN_NO_RUN keeps the import from drawing and writing. Every case here is one
// the gate would reject, so encodePng has to throw before anything reaches disk.

process.env.MAKEFUN_NO_RUN = '1';
const { encodePng, crc32, MAX_BYTES, W, H } = await import('../main.ts');

let failures = 0;
function pass(ok, what, detail = '') {
  console.log((ok ? '  ok    ' : '  FAIL  ') + what + (ok || !detail ? '' : ' — ' + detail));
  if (!ok) failures++;
}
function throws(what, fn) {
  try {
    fn();
    pass(false, what, 'did not throw');
  } catch (e) {
    pass(true, what + ': ' + String(e.message).slice(0, 80));
  }
}

console.log('crc32');
pass(crc32(Buffer.from('123456789', 'latin1'), 0, 9) === 0xcbf43926, 'check vector 123456789 -> CBF43926');
pass(crc32(Buffer.alloc(0), 0, 0) === 0, 'empty input -> 0');

console.log('guard');
throws('width over 1024', () => encodePng(1025, 1, new Uint8Array(1025 * 3)));
throws('height over 1024', () => encodePng(1, 1025, new Uint8Array(1025 * 3)));

// Deterministic noise is incompressible, so 1024x1024 must land over the cap.
let s = 0x12345678;
const noise = new Uint8Array(W * H * 3);
for (let i = 0; i < noise.length; i++) {
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5; s >>>= 0;
  noise[i] = s & 0xff;
}
const t0 = process.hrtime.bigint();
let guarded = false;
try {
  const n = encodePng(W, H, noise).length;
  pass(false, 'noise at 1024x1024 trips the 1 MiB guard', 'came out ' + n + ' bytes');
} catch (e) {
  guarded = e.message.includes(String(MAX_BYTES));
  pass(guarded, 'noise at 1024x1024 trips the guard: ' + String(e.message).slice(0, 70));
}
console.log('        worst-case encode ' + (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0) + ' ms');

console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
