import sharp from "sharp";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const dir = path.resolve("public/media");

const jobs = [
  { in: "hero.png", out: "hero.webp", width: 2000, q: 82 },
  { in: "hero.png", out: "hero-poster.webp", width: 1280, q: 70 },
  { in: "layer-capture.png", out: "layer-capture.webp", width: 1400, q: 80 },
  { in: "layer-production.png", out: "layer-production.webp", width: 1400, q: 80 },
  { in: "layer-platform.png", out: "layer-platform.webp", width: 1400, q: 80 },
  { in: "layer-intelligence.png", out: "layer-intelligence.webp", width: 1400, q: 80 },
  { in: "blueprint.png", out: "blueprint.webp", width: 2400, q: 72 },
  { in: "logo-mark.png", out: "logo-mark.webp", width: 512, q: 90 },
];

for (const j of jobs) {
  const src = path.join(dir, j.in);
  const dst = path.join(dir, j.out);
  await sharp(src)
    .resize({ width: j.width, withoutEnlargement: true })
    .webp({ quality: j.q })
    .toFile(dst);
  const s = await stat(dst);
  console.log(`✓ ${j.out}  ${(s.size / 1024).toFixed(0)} KB`);
}

// Remove the heavy source PNGs (keep only what we use as favicon source).
for (const f of await readdir(dir)) {
  if (f.endsWith(".png") && f !== "logo-mark.png") {
    await unlink(path.join(dir, f));
    console.log(`– removed ${f}`);
  }
}
console.log("done");
