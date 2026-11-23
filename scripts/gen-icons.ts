// Erzeugt static/icon-192.png und icon-512.png (Frosch, gleiche Form wie icon.svg).
// Aufruf: deno run --allow-write scripts/gen-icons.ts

const BG = [0x1f, 0x6f, 0x3d];
const SKIN = [0x7f, 0xd3, 0x5a];
const WHITE = [255, 255, 255];
const BLACK = [17, 17, 17];

const clamp = (v: number) => Math.max(0, Math.min(1, v));

function ellipse(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return (Math.hypot(dx, dy) - 1) * Math.min(rx, ry);
}

function pixel(x: number, y: number, n: number): number[] {
  const px = 1 / n;
  const cover = (d: number) => clamp(0.5 - d / px);
  let c = BG.slice();
  const paint = (col: number[], d: number) => {
    const a = cover(d);
    c = c.map((v, i) => v * (1 - a) + col[i] * a);
  };
  paint(SKIN, ellipse(x, y, 0.5, 0.56, 0.28, 0.22));
  for (const ex of [0.35, 0.65]) {
    paint(SKIN, ellipse(x, y, ex, 0.36, 0.1, 0.1));
    paint(WHITE, ellipse(x, y, ex, 0.36, 0.065, 0.065));
    paint(BLACK, ellipse(x, y, ex, 0.36, 0.03, 0.03));
  }
  // Mund: Bogen unterhalb von (0.5, 0.5)
  if (y > 0.58) {
    paint(BG, Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.17) - 0.012);
  }
  return c;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function png(n: number): Promise<Uint8Array> {
  const raw = new Uint8Array(n * (n * 3 + 1));
  for (let y = 0; y < n; y++) {
    const row = y * (n * 3 + 1);
    for (let x = 0; x < n; x++) {
      const [r, g, b] = pixel((x + 0.5) / n, (y + 0.5) / n, n);
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const z = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, n);
  dv.setUint32(4, n);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", z),
    chunk("IEND", new Uint8Array()),
  ];
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

for (const n of [192, 512]) {
  await Deno.writeFile(`static/icon-${n}.png`, await png(n));
}
