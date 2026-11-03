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
for (const x of discs) {
  if (!x.title?.hu) fails(`${x.id ?? "?"}: nincs magyar cím`);
  if (!/^https:\/\/kozhang\.hu\/egyeztetesek\/[a-z0-9-]+$/.test(x.url ?? ""))
    fails(`${x.id}: hibás hivatkozás: ${x.url}`);
  if (!["open", "soon", "closed"].includes(x.status))
    fails(`${x.id}: ismeretlen státusz: ${x.status}`);
  if (!CATS.has(x.category)) fails(`${x.id}: ismeretlen kategória: ${x.category}`);
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
