#!/usr/bin/env node
/**
 * stats.mjs – a kozhang.hu NYILVÁNOS szavazati adatainak kinyerése.
 *
 * A témához kötött szavazatszámok (témaszavazás) bejelentkezés mögött vannak,
 * az ötlettárak támogatásszámlálói viszont publikusan látszanak – viszont a
 * Cloudflare csak valódi böngészőt enged át, ezért rendszerszintű Chrome-ot
 * (puppeteer-core, böngészőletöltés nélkül) használunk.
 *
 * Kimenet: public/data/otletek.json
 *   { generatedAt, topics: [ { id, url, count, total, ideas: [ {title, supports, category} ] } ] }
 *
 * Használat: node stats.mjs        (CHROME_PATH felülírhatja a Chrome helyét)
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "public", "data", "recommendations.json");
const OUT = path.join(HERE, "public", "data", "otletek.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error("Nincs elérhető Chrome. Állítsd be a CHROME_PATH környezeti változót.");
}

/** Egy ötletfal kinyerése: ötletek címe + támogatásszáma, csökkenő sorrendben. */
async function scrapeWall(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 2400 });
  // A Cloudflare Turnstile csak „valódi" böngészőt enged át az adatvégpontokra
  // (nup.kozhang.app) – leplezzük az automatizálási nyomokat.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });
  try {
    // A Cloudflare-kihívás és az SPA-indulás is valós időt igényel; 3 próbálkozás.
    let ready = false;
    for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page
        .evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((x) => /Mindennek a megengedése/i.test(x.textContent));
          btn?.click();
        })
        .catch(() => {});
      try {
        await page.waitForFunction(() => /\d+\s*támogatás/.test(document.body?.innerText || ""), {
          timeout: 40000,
        });
        ready = true;
      } catch {
        console.log(`  · újratöltés (${attempt}/3): a számlálók még nem töltődtek be`);
      }
    }
    if (!ready) return { url, ideas: [] };
    const ideas = await page.evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const cards = document.querySelectorAll('[data-slot="ch3-idea-card"],[data-slot="idea-top-card"]');
      const seen = new Map();
      for (const c of cards) {
        const title = clean(c.querySelector("h3")?.textContent || "");
        if (!title) continue;
        const cnt = [...c.querySelectorAll("*")].find(
          (e) => e.children.length === 0 && /\d/.test(e.textContent) && /támogat/i.test(e.textContent),
        );
        const supports = cnt ? parseInt(cnt.textContent.replace(/\D/g, ""), 10) || 0 : 0;
        const pEl = c.querySelector("p");
        const description = pEl ? clean(pEl.textContent) : null;
        const prev = seen.get(title);
        if (!prev || supports > prev.supports)
          seen.set(title, { title, supports, description, category: c.getAttribute("data-category") || null });
      }
      return [...seen.values()].sort((a, b) => b.supports - a.supports);
    });
    return { url, ideas };
  } finally {
    await page.close();
  }
}

const rec = JSON.parse(await readFile(DATA, "utf8"));
const walls = rec.discussions.filter((d) => d.status === "open" && d.ideasUrl);
if (!walls.length) throw new Error("Nincs nyitott témához tartozó ötletfal a recommendations.json-ban.");

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-blink-features=AutomationControlled", "--window-size=1440,900"],
});

const topics = [];
try {
  for (const d of walls) {
    console.log(`→ ötletfal: ${d.id}  (${d.ideasUrl})`);
    const { ideas } = await scrapeWall(browser, d.ideasUrl);
    const total = ideas.reduce((s, x) => s + x.supports, 0);
    console.log(`  ${ideas.length} ötlet, ${total} támogatás`);
    topics.push({ id: d.id, url: d.ideasUrl, count: ideas.length, total, ideas });
  }
} finally {
  await browser.close();
}

if (!topics.some((t) => t.ideas.length)) {
  throw new Error("Egyetlen ötletfalon sem sikerült számot kinyerni (Cloudflare? szerkezetváltozás?).");
}

// Változás-jelentés az előző pillanatképhez képest
try {
  const prev = JSON.parse(await readFile(OUT, "utf8"));
  for (const t of topics) {
    const p = prev.topics?.find((x) => x.id === t.id);
    if (!p) continue;
    const dTotal = t.total - p.total;
    const prevByTitle = new Map(p.ideas.map((x) => [x.title, x.supports]));
    const risers = t.ideas
      .map((x) => ({ title: x.title, d: x.supports - (prevByTitle.get(x.title) ?? x.supports) }))
      .filter((x) => x.d > 0)
      .sort((a, b) => b.d - a.d)
      .slice(0, 3);
    console.log(
      `\n${t.id}: ${p.total} → ${t.total} támogatás (${dTotal >= 0 ? "+" : ""}${dTotal})` +
        (risers.length ? `\n  legnagyobb emelkedés: ${risers.map((r) => `${r.title.slice(0, 40)} (+${r.d})`).join("; ")}` : ""),
    );
  }
} catch { /* még nincs előző pillanatkép */ }

await writeFile(
  OUT,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), source: "https://kozhang.hu", topics },
    null,
    2,
  ) + "\n",
);
console.log(`\n✓ ${path.relative(process.cwd(),OUT)} — pillanatkép mentve`);
