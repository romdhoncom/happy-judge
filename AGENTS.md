# happy-judge

A make.fun entry for "Make the AI judge happy": a night ice-cream van, a vendor holding out a soft-serve cone, and a pigeon that is clearly a regular, paying in coins under the chalkboard "THE USUAL".

## Status (Updated 2026-11-14)

- `main.ts` draws and encodes the entry itself; `out/entry.png` is 1024x1024, about 159 KB, under the 1 MiB gate.
- Two runs produce identical SHA-256; `test/surface.test.mjs`, `test/entry.guard.mjs` and `test/entry.check.mjs` all pass locally on Node 26. The competition runs Node 22, and the file uses no API newer than that.
- Not committed or submitted; submission needs the public repo, a commit and the agent transcripts.

## Run

    MAKEFUN_OUTPUT_DIR=out node main.ts
    node test/surface.test.mjs && node test/entry.guard.mjs && node test/entry.check.mjs

## Map

- `main.ts`: CRC32, chunk writer, adaptive PNG filters, `encodePng`/`inflateAndUnfilter`, the `Surface` rasteriser (5x supersampled, box-filtered), 5x7 `GLYPHS`, `makeRng`, `drawScene`, `main`.
- `test/`: primitives and determinism, gate limits and the 1 MiB guard, an independent parse of the encoded PNG.

## Decisions

- The visible frame is the centred 819x819 crop of the 1024 scene (`ZOOM` 1.25, integer step 4), so the edge stays sharp without resampling blur.
- All scene randomness comes from `makeRng(0x5eed1234)`. No clock, no network, no env read except `MAKEFUN_OUTPUT_DIR`.
- The only text is the chalkboard "THE USUAL"; letterforms stay clean because they use the built-in glyphs.
- The scene sits in the 1024 space; the visible region is roughly x/y 102..922, so keep important shapes inside it.
