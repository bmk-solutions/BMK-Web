import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = "C:/Users/Alkaz/OneDrive/Work/2- BMK Soutions";
const LOGO = `${BASE}/0- MARKETING AND DATA/1- Logo`;
const CS = `${BASE}/Backup - 10-25/0- MARKETING AND DATA/2- Company Profile/Source/case studies`;
const VID = `${BASE}/Backup - 10-25/0- MARKETING AND DATA/2- Company Profile/Source/Video`;
const OUT = path.resolve("public");
const TMP = path.join(os.tmpdir(), "bmk-assets");

for (const d of ["brand", "clients", "projects", "tours", "bim"]) {
  await mkdir(path.join(OUT, d), { recursive: true });
}
await mkdir(TMP, { recursive: true });

const jobs = [
  { src: `${LOGO}/Inverted-mark.png`, dst: "brand/mark-white.webp", w: 256, q: 95, alpha: true },
  { src: `${LOGO}/Secondary-Inverted-logo.png`, dst: "brand/logo-white.webp", w: 560, q: 95, alpha: true },
  { src: `${LOGO}/Primary-Inverted-logo.png`, dst: "brand/logo-stacked-white.webp", w: 480, q: 95, alpha: true },
  { src: `${VID}/companies.png`, dst: "clients/companies.webp", w: 1280, q: 88 },
  { src: `${CS}/1-Progress Reports/Site/urban/1- urban old.jpg`, dst: "projects/site-old.webp", w: 1280, q: 82 },
  { src: `${CS}/1-Progress Reports/Site/urban/2- urban mid.png`, dst: "projects/site-mid.webp", w: 1280, q: 82 },
  { src: `${CS}/1-Progress Reports/Site/urban/3- urban new.jpg`, dst: "projects/site-new.webp", w: 1280, q: 82 },
  { src: `${CS}/1-Progress Reports/Site/drone/3- drone new.jpg`, dst: "projects/drone.webp", w: 1800, q: 82 },
  { src: `${CS}/3- AR-VR Services/Resedintial/Panorama_06_2024-02-13-22-37-32.jpg`, dst: "tours/residential.webp", w: 2800, q: 80 },
  { src: `${CS}/3- AR-VR Services/Midical/Panorama_NGHA Riyadh-2_2025-02-20-01-41-15.jpg`, dst: "tours/medical.webp", w: 2800, q: 80 },
  { src: `${CS}/2- BIM Services/clash detection/aggregate-data-and-clash-detection.jpg`, dst: "bim/clash.webp", w: 1400, q: 82 },
  { src: `${CS}/2- BIM Services/clash detection/MEP-01.jpg`, dst: "bim/mep.webp", w: 1400, q: 82 },
  { src: `${CS}/2- BIM Services/modeling/architectural-service-revit-modeling.jpg`, dst: "bim/model.webp", w: 1400, q: 82 },
  { src: `${CS}/2- BIM Services/modeling/Naslovna.jpg`, dst: "bim/model2.webp", w: 1400, q: 82 },
];

let i = 0;
for (const j of jobs) {
  const tmp = path.join(TMP, `t${i++}.png`);
  try {
    // ffmpeg decodes virtually anything; scale down here to keep temp small.
    execFileSync(
      ffmpegPath,
      ["-y", "-i", j.src, "-vf", `scale='min(${j.w},iw)':-1`, tmp],
      { stdio: "ignore" }
    );
    const info = await sharp(tmp)
      .webp({ quality: j.q, alphaQuality: j.alpha ? 100 : undefined })
      .toFile(path.join(OUT, j.dst));
    console.log(`✓ ${j.dst}  ${(info.size / 1024).toFixed(0)}KB ${info.width}x${info.height}`);
  } catch (e) {
    console.log(`✗ ${j.dst}  (${String(e.message).split("\n")[0]})`);
  }
}
await rm(TMP, { recursive: true, force: true });
console.log("done");
