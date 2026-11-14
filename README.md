# The usual

A make.fun entry for "Make the AI judge happy": a small night ice-cream van, a
vendor with a cone, and a pigeon that is clearly a regular, paying in coins.

`main.ts` draws the whole picture itself and writes one PNG to
`$MAKEFUN_OUTPUT_DIR/entry.png` (default `/output/entry.png`). It has no
dependencies, imports only `node:zlib`, `node:fs` and `node:path`, and never
touches the network. The PNG is encoded in the same file: CRC32, chunk writer,
adaptive per-row filters, one `IDAT` from `deflateSync`, then `IHDR`/`IEND`. The
output is deterministic, so two runs write the same bytes. The file is 1024 by
1024 and about 145 KB, under the 1 MiB gate.

    node main.ts                          # writes /output/entry.png
    MAKEFUN_OUTPUT_DIR=out node main.ts   # writes ./out/entry.png

Set `MAKEFUN_NO_RUN=1` to import the drawing surface and encoder without drawing
(the tests do this).

## Tests

    node test/surface.test.mjs   # primitives, glyphs, encoder round trip, two runs, 300 px preview
    node test/entry.guard.mjs    # CRC vector and the 1 MiB / 1024 px guards
    node test/entry.check.mjs    # independent parse of out/entry.png: chunks, CRCs, filters, size

`test/surface.test.mjs` writes two runs to `out/run-a` and `out/run-b` and compares
their SHA-256, and writes a 300 px preview to `out/thumb.png`.
