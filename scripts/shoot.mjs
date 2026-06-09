import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://localhost:3000/";
const OUT = "C:/Users/Alkaz/OneDrive/personal/2026/Claude Files/shots";

const shots = process.argv.slice(2); // e.g. "desktop-en" "mobile-ar" "full-en"

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-prefers-reduced-motion"],
});

async function setLang(page, lang) {
  await page.evaluate((l) => {
    localStorage.setItem("bmk-lang", l);
  }, lang);
}

async function shoot(name, { width, height, lang, full, scrollTo }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await setLang(page, lang);
  await page.reload({ waitUntil: "networkidle2" });
  // freeze animations for crisp captures
  await page.addStyleTag({
    content: "*,*::before,*::after{animation:none !important;transition:none !important}",
  });
  await page.evaluate(() => document.querySelectorAll("video").forEach((v) => v.pause()));
  if (scrollTo) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView();
    }, scrollTo);
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({
    path: `${OUT}/${name}.jpg`,
    type: "jpeg",
    quality: 80,
    fullPage: !!full,
  });
  console.log(`✓ ${name}.jpg`);
  await page.close();
}

const jobs = {
  "desktop-en": { width: 1440, height: 900, lang: "en" },
  "desktop-ar": { width: 1440, height: 900, lang: "ar" },
  "full-en": { width: 1440, height: 900, lang: "en", full: true },
  "full-ar": { width: 1440, height: 900, lang: "ar", full: true },
  "mobile-en": { width: 390, height: 844, lang: "en", full: true },
  "mobile-ar": { width: 390, height: 844, lang: "ar", full: true },
  "platform-en": { width: 1440, height: 900, lang: "en", scrollTo: "#platform" },
  "layers-en": { width: 1440, height: 900, lang: "en", scrollTo: "#layers" },
  "packages-en": { width: 1440, height: 900, lang: "en", scrollTo: "#packages" },
  "contact-en": { width: 1440, height: 900, lang: "en", scrollTo: "#contact" },
  "why-en": { width: 1440, height: 900, lang: "en", scrollTo: "#why" },
  "clients-en": { width: 1440, height: 900, lang: "en", scrollTo: "#clients" },
  "about-en": { width: 1440, height: 900, lang: "en", scrollTo: "#about" },
  "m-about": { width: 390, height: 844, lang: "en", scrollTo: "#about" },
  "m-layers": { width: 390, height: 844, lang: "en", scrollTo: "#layers" },
  "m-platform": { width: 390, height: 844, lang: "en", scrollTo: "#platform" },
  "m-packages": { width: 390, height: 844, lang: "en", scrollTo: "#packages" },
  "ar-desktop": { width: 1440, height: 900, lang: "ar", scrollTo: "#layers" },
  "ar-platform": { width: 1440, height: 900, lang: "ar", scrollTo: "#platform" },
  "ar-packages": { width: 1440, height: 900, lang: "ar", scrollTo: "#packages" },
  "progress-en": { width: 1440, height: 900, lang: "en", scrollTo: "#progress" },
  "tours-en": { width: 1440, height: 900, lang: "en", scrollTo: "#tours" },
  "work-en": { width: 1440, height: 900, lang: "en", scrollTo: "#work" },
  "ar-progress": { width: 1440, height: 900, lang: "ar", scrollTo: "#progress" },
  "ar-tours": { width: 1440, height: 900, lang: "ar", scrollTo: "#tours" },
  "ar-contact": { width: 1440, height: 900, lang: "ar", scrollTo: "#contact" },
  "m-tours": { width: 390, height: 844, lang: "en", scrollTo: "#tours" },
  "m-contact": { width: 390, height: 844, lang: "en", scrollTo: "#contact" },
};

const todo = shots.length ? shots : Object.keys(jobs);
for (const name of todo) {
  if (jobs[name]) await shoot(name, jobs[name]);
}

await browser.close();
console.log("done");
