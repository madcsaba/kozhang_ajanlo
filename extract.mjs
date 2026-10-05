#!/usr/bin/env node
/**
 * kozhang.hu tartalom-extractor
 *
 * A kozhang.hu egy Vite+React SPA: nincs nyilvános tartalom-API, nincs
 * sitemap, a teljes adat a JavaScript bundle-ökbe van égetve. Ez a script
 * szerveroldalról (CORS nélkül) kinyeri és JSON-ná alakítja:
 *
 *   - 16 egyeztetés (3 nyitott + 13 hamarosan) + statisztikák
 *   - a nyitott témák fejezetei és kérdés-listája
 *   - 19 Tudástér-dokumentum
 *   - 120 téma-taxonómia (12 fő téma x 10 altéma)
 *   - videó-beszélők
 *
 * Cloudflare-megjegyzés: a `/`, `/version.json` és `/sitemap.xml` mögött
 * kihívás van (403), de a `/robots.txt` (a SPA shell-t adja vissza) és az
 * `/assets/*` fájlok kiszolgálhatók. Ezt használja a getShell().
 *
 * Használat:
 *   node extract.mjs          → kiírja public/data/recommendations.json
 *   node extract.mjs --diag   → diagnosztika a stdout-ra
 */

import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://kozhang.hu";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "public", "data", "recommendations.json");
const DIAG = process.argv.includes("--diag");

const UA = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  accept: "*/*",
  "accept-language": "hu-HU,hu;q=0.9,en;q=0.8",
};

async function fetchText(url, required = true) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) {
    if (!required) return null;
    throw new Error(`HTTP ${r.status} — ${url}`);
  }
  return r.text();
}

async function exists(url) {
  try {
    const r = await fetch(url, { headers: { ...UA, range: "bytes=0-64" } });
    if (r.status === 403 && (r.headers.get("cf-mitigated") || "").includes("challenge")) return false;
    if (r.status === 206 || r.status === 200) {
      const ct = r.headers.get("content-type") || "";
      if (ct.startsWith("text/html")) return false; // SPA shell fallback
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Zárójelezés keresése, miközben kihagyjuk a stringeket/template-eket. */
function bracket(src, openIdx) {
  const open = src[openIdx];
  const close = open === "[" ? "]" : open === "{" ? "}" : ")";
  let depth = 0;
  let mode = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (mode) {
      if (c === "\\") { i++; continue; }
      if (c === mode) mode = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { mode = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Távoli kód kiértékelése — szigorú ellenőrzéssel, csak adat-literalokra. */
const SUSPICION =
  /\b(function|require|import|export|globalThis|process|window|document|fetch|XMLHttpRequest|constructor|__proto__|prototype|eval|localStorage|sessionStorage|=>)\b/;

function evalLiteral(code, what) {
  if (SUSPICION.test(code)) {
    throw new Error(`Gyanús token a(z) "${what}" literalban — kiértékelés megtagadva.`);
  }
  try {
    return new Function(`"use strict";return (${code});`)();
  } catch (e) {
    throw new Error(`Nem sikerült kiértékelni a(z) "${what}" literalot: ${e.message}`);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

/** SPA shell lekérése (a robots.txt-t a Cloudflare kiszolgálja). */
async function getShell() {
  for (const p of ["/robots.txt", "/favicon.svg", "/"]) {
    const html = await fetchText(`${BASE}${p}`, false);
    if (html && /assets\/index-[A-Za-z0-9_-]+\.js/.test(html)) return html;
  }
  throw new Error("Nem tudom betölteni a SPA shell-t (minden útvonal 403).");
}

async function discoverAssets() {
  const html = await getShell();
  const idxMatch = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!idxMatch) throw new Error("Nem találom a index-bundle-t a HTML-ben.");
  const indexPath = idxMatch[0];
  const indexJs = await fetchText(`${BASE}${indexPath}`);

  const rel = new Set();
  for (const m of indexJs.matchAll(/\.\/([A-Za-z0-9_.+-]+\.js)/g)) rel.add(m[1]);
  for (const m of indexJs.matchAll(/["'`]\/assets\/([A-Za-z0-9_.+-]+\.js)["'`]/g)) rel.add(m[1]);

  return {
    indexJs,
    indexPath,
    build: indexPath.match(/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? null,
    assets: [...rel],
    fetchAsset: (name) => fetchText(`${BASE}/assets/${name}`),
  };
}

/** `Lo=[{id:`…`}]` tömb kinyerése (a 16 egyeztetés listája). */
function extractListing(src) {
  const decl = src.match(/=\[\{id:/);
  if (!decl) throw new Error("Nem találom az egyeztetés-tömböt.");
  const open = decl.index + decl[0].indexOf("[");
  const close = bracket(src, open);
  if (close < 0) throw new Error("Az egyeztetés-tömb zárójele nem található.");
  return evalLiteral(src.slice(open, close + 1), "Lo tömb");
}

/** JSON.parse(`...`) blokkok kinyerése. */
function findJsonParseBlocks(src) {
  const out = [];
  const needle = "JSON.parse(`";
  let i = -1;
  while ((i = src.indexOf(needle, i + 1)) >= 0) {
    const start = i + needle.length;
    const end = src.indexOf("`", start);
    if (end < 0) break;
    const raw = src.slice(start, end);
    if (raw.includes("${")) { i = end; continue; }
    try {
      const str = new Function(`return \`${raw}\`;`)();
      out.push({ index: i, data: JSON.parse(str) });
    } catch { /* nem JSON → kihagyjuk */ }
    i = end;
  }
  return out;
}

/**
 * A nyitott témák részletes objektumai: `{id:`X`, …, chapters:[{title,minutes,steps}]}`
 * A `steps` lehet inline tömb vagy hivatkozott változó (pl. `steps:Js`).
 */
function extractDetailChapters(src, ids) {
  const result = new Map();
  const varCache = new Map();

  const resolveVar = (name) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    if (varCache.has(name)) return varCache.get(name);
    const m = src.match(new RegExp(`\\b${name}\\s*=\\s*\\[`));
    if (!m) { varCache.set(name, null); return null; }
    const o = m.index + m[0].indexOf("[");
    const c = bracket(src, o);
    let v = null;
    if (c > 0) { try { v = evalLiteral(src.slice(o, c + 1), `steps:${name}`); } catch {} }
    varCache.set(name, v);
    return v;
  };

  const normalizeSteps = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((s) => {
        if (Array.isArray(s)) {
          const [id, hu, en] = s;
          return { id, title: { hu, en }, kind: "question" };
        }
        if (s && typeof s === "object" && s.id) {
          return { id: s.id, title: s.title ?? null, kind: s.kind ?? "question", minutes: s.minutes ?? null };
        }
        return null;
      })
      .filter(Boolean);

  for (const id of ids) {
    if (result.has(id)) continue;
    for (const m of src.matchAll(new RegExp(`id:\\s*\`${id}\``, "g"))) {
      const ci = src.indexOf("chapters:[", m.index);
      if (ci < 0 || ci - m.index > 12000) continue;
      const o = ci + "chapters:".length;
      const c = bracket(src, o);
      if (c < 0) continue;

      let chapters;
      try {
        chapters = evalLiteral(src.slice(o, c + 1), `chapters:${id}`);
      } catch {
        // `steps:Js` hivatkozás miatt nem értékelhető ki → kézzel bontjuk
        chapters = null;
      }

      if (Array.isArray(chapters)) {
        result.set(
          id,
          chapters.map((ch, idx) => {
            const steps = normalizeSteps(ch.steps).map((s, i) => ({ ...s, index: i }));
            return {
              index: idx,
              title: ch.title ?? null,
              minutes: ch.minutes ?? null,
              unlocksAt: ch.unlocksAt ?? null,
              stepCount: steps.length,
              steps: steps.map((s) => ({
                id: s.id,
                title: s.title?.hu ?? null,
                kind: s.kind,
                minutes: s.minutes,
                index: s.index,
              })),
            };
          }),
        );
        break;
      }

      // fallback: lépés-változó feloldása a chapter blokkban
      const block = src.slice(o, c + 1);
      const chapterMatches = [...block.matchAll(/\{title:\s*\{[^}]*\}\s*,\s*minutes:\s*\d+/g)];
      const resolved = chapterMatches.map((cm, idx) => {
        const start = cm.index;
        const end = bracket(block, start);
        const body = end > 0 ? block.slice(start, end + 1) : "";
        const sm = body.match(/\bsteps:\s*([A-Za-z_$][\w$]*)/);
        const steps = sm ? normalizeSteps(resolveVar(sm[1])) : [];
        return {
          index: idx,
          title: { hu: cm[0].match(/hu:\s*`([^`]*)`/)?.[1] ?? null, en: cm[0].match(/en:\s*`([^`]*)`/)?.[1] ?? null },
          minutes: Number(cm[0].match(/minutes:\s*(\d+)/)?.[1] ?? 0),
          unlocksAt: body.match(/unlocksAt:\s*`([^`]*)`/)?.[1] ?? null,
          stepCount: steps.length,
          steps: steps.map((s, i) => ({ id: s.id, title: s.title?.hu ?? null, kind: s.kind, minutes: s.minutes, index: i })),
        };
      });
      if (resolved.length) { result.set(id, resolved); break; }
    }
  }
  return result;
}

/** Kép-URL: a bundle `.jpg`-t ír, a szerver `.webp`-t szolgál ki. */
async function resolveImage(rel) {
  if (!rel) return null;
  const direct = `${BASE}/${rel}`;
  if (await exists(direct)) return direct;
  if (rel.endsWith(".jpg")) {
    const webp = `${BASE}/${rel.slice(0, -4)}.webp`;
    if (await exists(webp)) return webp;
  }
  return null;
}

// ───────────────────────────────────────────────────────────── main ──

async function main() {
  const t0 = Date.now();
  const { indexJs, indexPath, build, assets, fetchAsset } = await discoverAssets();
  console.log(`index: ${indexPath}  (${assets.length} asset, build=${build})`);

  const sources = await mapLimit(assets, 8, async (name) => {
    try { return { name, text: await fetchAsset(name) }; }
    catch (e) { console.warn(`  ! ${name}: ${e.message}`); return null; }
  });
  const chunks = [{ name: indexPath, text: indexJs }, ...sources.filter(Boolean)];
  console.log(`betöltve: ${chunks.length} bundle`);

  // 1) Egyeztetések
  const discChunk = chunks.find((c) => /\bparticipants:\s*\d+/.test(c.text) && c.text.includes("=[{id:"));
  if (!discChunk) throw new Error("Nem találom az egyeztetés-tömböt.");
  const discussions = extractListing(discChunk.text);
  console.log(`egyeztetések: ${discussions.length}  (${discChunk.name})`);

  // 2) Részletes objektumok: fejezetek + kérdés-lista (csak a nyitottaknak van)
  const detailChunk = chunks.find((c) => c.text.includes("chapters:["));
  const detailIds = discussions.filter((d) => d.status === "open").map((d) => d.id);
  const chaptersByDiscussion = detailChunk
    ? extractDetailChapters(detailChunk.text, detailIds)
    : new Map();
  console.log(`részletes adat: ${chaptersByDiscussion.size}/${detailIds.length} nyitott témánál`);

  // 3) Tudástér (JSON.parse blokkok a index-bundle-ban)
  let knowledge = [];
  for (const c of chunks) {
    for (const b of findJsonParseBlocks(c.text)) {
      const d = b.data;
      if (Array.isArray(d) && d.length && d[0]?.kind === "document" && d[0].discussionId !== undefined) {
        knowledge = d;
      }
    }
  }
  console.log(`tudástér: ${knowledge.length}`);

  // 4) Tématarbonómia: `"education-1":"..."` párok
  const taxonomyMap = new Map();
  for (const c of chunks) {
    for (const m of c.text.matchAll(/"([a-z]+)-(\d+)":"([^"]{5,120})"/g)) {
      const [, key, num, label] = m;
      if (!taxonomyMap.has(key)) taxonomyMap.set(key, new Map());
      taxonomyMap.get(key).set(Number(num), label);
    }
  }
  const taxonomy = [...taxonomyMap.entries()]
    .map(([key, subs]) => ({
      key,
      subtopics: [...subs.entries()].sort((a, b) => a[0] - b[0]).map(([n, label]) => ({ key: `${key}-${n}`, label })),
    }))
    .filter((t) => t.subtopics.length >= 5);
  console.log(`taxonómia: ${taxonomy.length} fő téma, ${taxonomy.reduce((n, t) => n + t.subtopics.length, 0)} altéma`);

  // 5) Videó-beszélők (a contentByDiscussion cinema blokkjaiból)
  let media = [];
  let contentByDiscussion = null;
  for (const c of chunks) {
    for (const b of findJsonParseBlocks(c.text)) {
      if (b.data?.contentByDiscussion) contentByDiscussion = b.data.contentByDiscussion;
    }
  }
  for (const [discussionId, steps] of Object.entries(contentByDiscussion ?? {})) {
    for (const [stepId, st] of Object.entries(steps)) {
      for (const block of st.blocks ?? []) {
        if (block.kind !== "cinema" || !Array.isArray(block.speakers)) continue;
        for (const sp of block.speakers) {
          media.push({
            discussionId,
            stepId,
            block: block.title ?? null,
            chips: block.chips ?? null,
            id: sp.id,
            name: sp.name,
            meta: sp.meta,
            duration: sp.duration,
            chapters: sp.chapters ?? [],
          });
        }
      }
    }
  }
  console.log(`videó-beszélők: ${media.length}`);

  // 6) Képek valós ellenőrzése (a bundle `.jpg`-t ír, a szerver `.webp`-t ad)
  const photoRel = discussions.map((d) => d.photo).filter((p) => p && !p.includes("logo/"));
  const heroRel = discussions.map((d) => d.hero).filter(Boolean);
  const knowledgeRel = knowledge.map((k) => k.photo).filter(Boolean);
  const allRel = [...new Set([...photoRel, ...heroRel, ...knowledgeRel])];
  const photoPairs = await mapLimit(allRel, 6, async (rel) => [rel, await resolveImage(rel)]);
  const photoMap = new Map(photoPairs.filter(([, url]) => url));
  const missing = allRel.filter((r) => !photoMap.has(r));
  console.log(`képek: ${photoMap.size}/${allRel.length} megvan${missing.length ? ` (hiányzik: ${missing.slice(0, 3).join(", ")})` : ""}`);

  const resolvePhoto = (rel) => (rel ? photoMap.get(rel) ?? null : null);

  // 7) Build-verzió (a version.json a Cloudflare blokkolja → a bundle hash a jele)
  let sourceBuild = null;
  try {
    const t = await fetchText(`${BASE}/version.json`, false);
    if (t) sourceBuild = JSON.parse(t).build ?? null;
  } catch { /* opcionális */ }
  if (!sourceBuild) sourceBuild = build;
  console.log(`build: ${sourceBuild ?? "ismeretlen"}`);

  // ── Összeállítás ──
  const knowledgeByDiscussion = {};
  for (const k of knowledge) {
    if (!k.discussionId) continue;
    (knowledgeByDiscussion[k.discussionId] ??= []).push(k.id);
  }

  const items = discussions.map((d) => {
    const chs = chaptersByDiscussion.get(d.id) ?? [];
    const questions = chs.flatMap((ch) =>
      ch.steps.map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        minutes: s.minutes,
        chapter: ch.title?.hu ?? null,
        chapterIndex: ch.index,
        url: `${BASE}/egyeztetesek/${d.id}/lepes/${s.id}`,
      })),
    );
    const kb = knowledgeByDiscussion[d.id] ?? [];
    return {
      id: d.id,
      title: d.title,
      description: d.description,
      lead: d.lead,
      category: d.category,
      scope: d.scope ?? "national",
      status: d.status,
      locality: d.locality ?? null,
      participants: d.participants ?? 0,
      completionRate: d.completionRate ?? 0,
      daysLeft: d.daysLeft ?? null,
      opensAt: d.opensAt ?? null,
      badgeStyle: d.badgeStyle ?? null,
      brand: !!d.brand,
      photo: resolvePhoto(d.photo),
      hero: resolvePhoto(d.hero),
      chapters: chs.map((ch) => ({
        index: ch.index,
        title: ch.title,
        minutes: ch.minutes,
        unlocksAt: ch.unlocksAt,
        stepCount: ch.stepCount,
      })),
      chapterCount: chs.length,
      stepCount: questions.length,
      totalMinutes: chs.reduce((n, ch) => n + (ch.minutes ?? 0), 0),
      knowledgeCount: kb.length,
      knowledgeIds: kb,
      questions,
      mediaCount: media.filter((m) => m.discussionId === d.id).length,
      url: `${BASE}/egyeztetesek/${d.id}`,
      ideasUrl: `${BASE}/egyeztetesek/${d.id}/otletek`,
    };
  });

  const categories = {};
  for (const i of items) categories[i.category] = (categories[i.category] ?? 0) + 1;

  const payload = {
    generatedAt: new Date().toISOString(),
    source: BASE,
    sourceBuild,
    counts: {
      discussions: items.length,
      open: items.filter((i) => i.status === "open").length,
      soon: items.filter((i) => i.status === "soon").length,
      knowledge: knowledge.length,
      taxonomyTopics: taxonomy.length,
      taxonomySubtopics: taxonomy.reduce((n, t) => n + t.subtopics.length, 0),
      questions: items.reduce((n, i) => n + i.questions.length, 0),
      mediaSpeakers: media.length,
    },
    categories,
    discussions: items,
    knowledge: knowledge.map((k) => ({
      id: k.id,
      title: k.title,
      lead: k.lead,
      categories: k.categories,
      date: k.date,
      discussionId: k.discussionId ?? null,
      photo: resolvePhoto(k.photo),
      source: k.source ?? null,
      featured: !!k.featured,
      url: `${BASE}/tudaster/${k.id}`,
    })),
    taxonomy,
    media,
  };

  if (DIAG) {
    console.log("\n── diagnosztika ──");
    console.log("kategóriák:", JSON.stringify(categories));
    for (const i of items) {
      console.log(
        `  ${i.status.padEnd(5)} ${i.id.padEnd(32)} ${String(i.chapterCount).padStart(2)} fej / ` +
          `${String(i.stepCount).padStart(2)} kérd / ${String(i.totalMinutes).padStart(3)} perc / ` +
          `${String(i.participants).padStart(6)} résztvevő / ${i.photo ? "kép ✓" : "kép ✗"}`,
      );
    }
    console.log("taxonómia:", taxonomy.map((t) => `${t.key}(${t.subtopics.length})`).join(", "));
  }

  await mkdir(path.dirname(OUT), { recursive: true });

  // Változás-érzékelés: a `generatedAt` minden futásnál más, ezért azt kihagyva
  // hasonlítunk. Ha tartalmilag semmi sem változott, nem írunk — így a
  // frissítő munkafolyamat nem generál üres commitokat naponta.
  const strip = (o) => {
    const { generatedAt, ...rest } = o;
    return JSON.stringify(rest);
  };
  let previous = null;
  try { previous = await readFile(OUT, "utf8"); } catch { /* még nincs fájl */ }
  const prevJson = previous ? JSON.parse(previous) : null;

  // Első megjelenés: a hírcsatorna ebből tudja, mikor jelent meg egy téma.
  // Az előző csomagból öröklődik; ami már ott volt, de még nem volt dátuma,
  // az előző csomag idejét kapja.
  const prevById = new Map((prevJson?.discussions ?? []).map((x) => [x.id, x]));
  for (const i of payload.discussions) {
    const p = prevById.get(i.id);
    i.firstSeen = p?.firstSeen ?? (p ? prevJson.generatedAt : payload.generatedAt);
  }

  const incoming = strip(payload);
  const unchanged = prevJson !== null && strip(prevJson) === incoming;
  const force = process.argv.includes("--force"); // generatedAt frissítése változatlan tartalomnál is

  if (unchanged && !force) {
    console.log(`\n✓ ${path.relative(process.cwd(), OUT)} — nincs változás (build ${sourceBuild})`);
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} mp · a fájl érintetlen maradt`);
    return { changed: false, counts: payload.counts };
  }

  await writeFile(OUT, JSON.stringify(payload, null, 2));

  const rel = path.relative(process.cwd(), OUT);
  const kb = (await stat(OUT)).size;
  console.log(`\n✓ ${rel} — ${prevJson ? "frissítve" : "létrehozva"}`);
  console.log(
    `  ${payload.counts.discussions} téma (${payload.counts.open} nyitott / ${payload.counts.soon} hamarosan) · ` +
      `${payload.counts.questions} kérdés · ${payload.counts.knowledge} cikk · ` +
      `${payload.counts.taxonomySubtopics} altéma · ${payload.counts.mediaSpeakers} videó-beszélő`,
  );
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} mp, ${(kb / 1024).toFixed(0)} KB`);
  return { changed: true, counts: payload.counts };
}

main().catch((e) => {
  console.error("\n✗ Hiba:", e.message);
  process.exit(1);
});
