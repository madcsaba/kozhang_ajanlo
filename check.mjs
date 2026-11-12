#!/usr/bin/env node
/**
 * Adatcsomag-ellenőrzés — a frissítő munkafolyamat kapuja.
 *
 * Nem a pontos darabszámokat ellenőrzi (egy új témával azonnal elbukna),
 * hanem azt, hogy az adatcsomag épséges és értelmes:
 *   - megvannak a nyitott témák, van elég kérdés
 *   - a Tudástér és a taxonómia nem esett vissza
 *   - minden cím és hivatkozás ép
 *
 * Ha ez hibával lép ki, a frissítő NEM írja felül a legutóbbi jó adatcsomagot.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "public", "data", "recommendations.json");

/** A kozhang.hu kategória-kulcsai — ismeretlen érték elírásra utal. */
const CATS = new Set([
  "public-media", "culture", "transport", "digital", "economy",
  "municipality", "climate", "environment", "health", "education",
  "family", "living", "safety", "society", "legislation",
]);

const problems = [];
const fails = (msg) => problems.push(msg);

let d;
try {
  d = JSON.parse(await readFile(FILE, "utf8"));
} catch (e) {
  console.error(`✗ az adatcsomag nem olvasható vagy nem érvényes JSON: ${e.message}`);
  process.exit(1);
}

const c = d.counts ?? {};

// Alsó korlátok: egy sikertelen kinyerés (pl. Cloudflare-kihívás HTML-je)
// ezeken mindenképpen fennakad. Felső korlát nincs — az új témák jöhetnek.
if (!(c.discussions >= 3)) fails(`egyeztetés: ${c.discussions} (legalább 3 kell, a nyitottak)`);
if (!(c.open >= 1)) fails(`nyitott téma: ${c.open} (legalább 1 kell)`);
if (!(c.questions >= 40)) fails(`kérdés: ${c.questions} (legalább 40 kell)`);
if (!(c.knowledge >= 10)) fails(`Tudástér-cikk: ${c.knowledge} (legalább 10 kell)`);
if (!(c.taxonomyTopics >= 10)) fails(`főtéma: ${c.taxonomyTopics} (legalább 10 kell)`);
if (!(c.taxonomySubtopics >= 100)) fails(`altéma: ${c.taxonomySubtopics} (legalább 100 kell)`);
if (!(c.mediaSpeakers >= 5)) fails(`videó-beszélő: ${c.mediaSpeakers} (legalább 5 kell)`);

// Szerkezeti épség
const discs = Array.isArray(d.discussions) ? d.discussions : [];
const NOW = Date.now();
for (const x of discs) {
  if (!x.title?.hu) fails(`${x.id ?? "?"}: nincs magyar cím`);
  if (!/^https:\/\/kozhang\.hu\/egyeztetesek\/[a-z0-9-]+$/.test(x.url ?? ""))
    fails(`${x.id}: hibás hivatkozás: ${x.url}`);
  if (!["open", "soon", "closed"].includes(x.status))
    fails(`${x.id}: ismeretlen státusz: ${x.status}`);
  if (!CATS.has(x.category)) fails(`${x.id}: ismeretlen kategória: ${x.category}`);
  // A lejárt témák státuszát a kozhang.hu logikája szerint futásidőben
  // számítjuk – ellenőrizzük, hogy a lezárási dátum valóban a státuszt támasztja alá.
  if (x.status === "closed" && !x.closesAt) fails(`${x.id}: lezárva, de nincs closesAt`);
  if (x.status === "open" && x.closesAt) {
    const t = Date.parse(`${x.closesAt}+01:00`);
    if (!isNaN(t) && t <= NOW) fails(`${x.id}: lejárt (${x.closesAt}), mégis nyitott`);
  }
  if (x.status === "closed" && x.closesAt) {
    const t = Date.parse(`${x.closesAt}+01:00`);
    if (!isNaN(t) && t > NOW) fails(`${x.id}: még nem lejárt (${x.closesAt}), mégis lezárva`);
  }
  // a fejezetek és a lépések összhangja – a hibás fejezet-hozzárendelés itt
  // derülne ki (pl. ha egy téma másik téma fejezeteit kapná)
  const chapters = Array.isArray(x.chapters) ? x.chapters : [];
  if (chapters.length) {
    const sumSteps = chapters.reduce((n, ch) => n + (ch.stepCount || 0), 0);
    const qs = Array.isArray(x.questions) ? x.questions : [];
    if (qs.length && sumSteps !== qs.length)
      fails(`${x.id}: a fejezetek lépésszáma (${sumSteps}) nem egyezik a kérdésekkel (${qs.length})`);
    for (const q of qs) {
      if (!q.title) fails(`${x.id}/${q.id}: lépésnek nincs címe`);
      if (!q.url || !q.url.startsWith("https://kozhang.hu/egyeztetesek/"))
        fails(`${x.id}/${q.id}: hibás lépés-hivatkozás: ${q.url}`);
    }
  }
}
const known = new Set(discs.map((x) => x.id));
if (known.size !== discs.length) fails("duplált téma-azonosító van a csomagban");

for (const k of Array.isArray(d.knowledge) ? d.knowledge : []) {
  if (!k.title?.hu) fails(`tudástér/${k.id}: nincs magyar cím`);
  if (!/^https:\/\/kozhang\.hu\/tudaster\//.test(k.url ?? ""))
    fails(`tudástér/${k.id}: hibás hivatkozás: ${k.url}`);
}

// A képek élnek — ha a kozhang.hu átveszi őket, az oldal üres kártyákkal indulna
const withPhoto = discs.filter((x) => x.hero || x.photo).length;
if (discs.length && withPhoto / discs.length < 0.8)
  fails(`túl kevés kép: ${withPhoto}/${discs.length}`);

if (!d.generatedAt) fails("nincs generatedAt időbélyeg");

if (problems.length) {
  console.error("✗ az adatcsomag hibás:");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

console.log(
  `✓ adatcsomag rendben — ${c.discussions} téma (${c.open} nyitott / ${c.soon} hamarosan), ` +
    `${c.questions} kérdés, ${c.knowledge} cikk, ${c.taxonomySubtopics} altéma, ` +
    `${c.mediaSpeakers} videó-beszélő, ${withPhoto}/${discs.length} kép`,
);
