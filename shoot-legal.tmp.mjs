import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.argv[2] || "http://localhost:3000";
const OUT = String.raw`D:\Dev\Claude Files\shots\legal-attribution`;
const tag = process.argv[3] || "local";

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-prefers-reduced-motion"],
});

async function shoot(name, { path = "/", width, height, lang }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1.5 });
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  if (lang) {
    await page.evaluate((l) => localStorage.setItem("bmk_lang", l), lang);
    await page.reload({ waitUntil: "networkidle2" });
  } else {
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
  }
  await page.evaluate(() => {
    document.querySelectorAll("canvas,video,#pre").forEach((e) => e.remove());
    document.querySelectorAll("*").forEach((e) => {
      e.style.animation = "none"; e.style.transition = "none";
    });
    document.querySelectorAll(".r").forEach((e) => e.classList.add("in"));
  });
  const sel = name.includes("about") ? "#about" : "footer .foot-bot";
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - (s === "#about" ? 80 : 320), behavior: "instant" });
  }, sel);
  await new Promise((r) => setTimeout(r, 1200));
  const file = `${OUT}\\${tag}_${name}.png`;
  await page.screenshot({ path: file });
  console.log("saved", file);
  await page.close();
}

await shoot("footer-mobile-390", { width: 390, height: 844 });
await shoot("footer-desktop", { width: 1440, height: 900 });
await shoot("footer-desktop-en", { width: 1440, height: 900, lang: "en" });
await shoot("about-desktop", { path: "/about", width: 1440, height: 900 });

await browser.close();

