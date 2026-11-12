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

// ---------- szabad azonosítók feloldása (minifikátor kiemelt változóira) ----------
// A minifikátor a gyakran ismétlődő objektumokat `var X={...}` alakban kiemeli, és a
// listában csupasz `X` elemként hivatkozik rá (pl. `as=[{...},is,{id:...}]`). Ezeket a
// chunk-ban lévő deklarációjukból oldjuk fel, mielőtt kiértékelnénk a tömböt.

const KEYWORDS = new Set(("true false null undefined NaN Infinity this super new typeof void delete " +
  "in of case do else for if while with try catch finally return break continue switch throw " +
  "yield await async function class extends import export default instanceof var let const").split(" "));

/** Stringek/template-ek tartalmának kitakarása (hosszmegőrző), hogy a keresés ne lásson bele. */
function maskStrings(code) {
  let out = "", i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"' || c === "`") {
      out += c; i++;
      while (i < code.length) {
        if (code[i] === "\\") { out += "  "; i += 2; continue; }
        if (code[i] === c) { out += c; i++; break; }
        out += " "; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Érték-helyzetben lévő szabad azonosítók (nem kulcs, nem tag, nem hívás). */
function valueIdentifiers(code) {
  const m = maskStrings(code);
  const found = new Set();
  let i = 0;
  while (i < m.length) {
    const c = m[i];
    if (c === "/" && m[i + 1] === "/") { while (i < m.length && m[i] !== "\n") i++; continue; }
    if (c === "/" && m[i + 1] === "*") { i += 2; while (i < m.length && !(m[i] === "*" && m[i + 1] === "/")) i++; i += 2; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < m.length && /[A-Za-z0-9_$]/.test(m[j])) j++;
      const name = m.slice(i, j);
      let p = i - 1; while (p >= 0 && /\s/.test(m[p])) p--;
      let q = j;     while (q < m.length && /\s/.test(m[q])) q++;
      const prev = p >= 0 ? m[p] : "";
      const next = q < m.length ? m[q] : "";
      const prevIsKw = p >= 0 && /\b(return|typeof|case|void|delete|in|of|new|yield|await|throw|instanceof)\s*$/.test(m.slice(0, p + 1));
      const valuePos = p < 0 || prevIsKw || [":", ",", "[", "(", "{", "=", ";"].includes(prev);
      const notRef = next !== ":" && next !== "(" && next !== "." && next !== "=";
      if (valuePos && notRef && !KEYWORDS.has(name)) found.add(name);
      i = j; continue;
    }
    i++;
  }
  return [...found];
}

/** A chunk-ban `name=` értékadás keresése; visszatérés: az '=' utáni pozíció, vagy -1. */
function findDecl(src, name) {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])\\s*=(?!=)`);
  const m = re.exec(src);
  return m ? m.index + m[0].length : -1;
}

/** Az '=' utáni érték-literal kinyerése (objektum/tömb/string/szám/boolean). */
function literalAt(src, idx) {
  let k = idx;
  while (k < src.length && /\s/.test(src[k])) k++;
  const c = src[k];
  if (c === "{" || c === "[") {
    const close = bracket(src, k);
    return close < 0 ? null : src.slice(k, close + 1);
  }
  if (c === "'" || c === '"' || c === "`") {
    let j = k + 1;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === c) return src.slice(k, j + 1);
      j++;
    }
    return null;
  }
  const m = src.slice(k).match(/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+|true|false|null|undefined|NaN|Infinity)/);
  if (m) return m[0];
  // A kozhang.hu a web/editor környezetet feltételesen választja ki:
  //   `yt=gt()===`web`?`2026-11-03T07:00:00`:void 0`
  // A nyilvános oldal a `web` ágat futtatja, ezért azt vesszük (a dátumot
  // visszaadva, hogy a tartalomtól függő érték is kiderüljön).
  const cond = src.slice(k).match(/^[A-Za-z_$][\w$]*\(\)\s*===?\s*`web`\s*\?\s*(`[^`]+`)\s*:\s*(?:void 0|undefined|null)/);
  return cond ? cond[1] : null;
}

/** Nem oldandó beépített értékek (a Function globális scope-ja amúgy is adja őket). */
const GLOBAL_OK = new Set(("Math JSON Number String Boolean Array Object Date RegExp parseInt parseFloat " +
  "isNaN isFinite Infinity NaN undefined Symbol BigInt Map Set WeakMap WeakSet Promise Intl").split(" "));

/**
 * A scope-ban feloldhatatlan, nem beépített érték-helyzetű azonosítókat `void 0`-ra
 * cseréli (stringeken/kommenteken kívül). Így a minifikátor számított értékei (pl.
 * `So=tt()==='web'?dátum:void 0`) nem viszik el a teljes kiértékelést — a mező egyszerűen
 * undefined lesz, a formai validáció (id + participants) így is ellenőrzi a helyességet.
 */
function rewriteUnresolved(code, scope) {
  let out = "", i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "'" || c === '"' || c === "`") {
      const start = i, q = c; i++;
      while (i < n) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === q) { i++; break; }
        i++;
      }
      out += code.slice(start, i); continue;
    }
    if (c === "/" && code[i + 1] === "/") { const s = i; while (i < n && code[i] !== "\n") i++; out += code.slice(s, i); continue; }
    if (c === "/" && code[i + 1] === "*") { const s = i; i += 2; while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++; i += 2; out += code.slice(s, i); continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$]/.test(code[i])) i++;
      const name = code.slice(s, i);
      let p = s - 1; while (p >= 0 && /\s/.test(code[p])) p--;
      let q2 = i; while (q2 < n && /\s/.test(code[q2])) q2++;
      const prev = p >= 0 ? code[p] : "";
      const next = q2 < n ? code[q2] : "";
      const prevIsKw = p >= 0 && /\b(return|typeof|case|void|delete|in|of|new|yield|await|throw|instanceof)\s*$/.test(code.slice(0, p + 1));
      const valuePos = p < 0 || prevIsKw || [":", ",", "[", "(", "{", "=", ";"].includes(prev);
      const notRef = next !== ":" && next !== "(" && next !== "." && next !== "=";
      const unresolved = valuePos && notRef && !KEYWORDS.has(name) && !GLOBAL_OK.has(name) && !scope.has(name);
      out += unresolved ? "void 0" : name;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Scope-beli értékekkel kiértékel; a feloldhatatlan azonosítók `void 0`-ra cserélve. */
function evalWithScope(code, scope) {
  const src = rewriteUnresolved(code, scope);
  const keys = [...scope.keys()], vals = [...scope.values()];
  return new Function(...keys, `"use strict";return (${src});`)(...vals);
}

/** A szabad azonosítókat a chunk-beli deklarációikból értékké oldja (rekurzívan). */
function buildScope(chunk, names) {
  const scope = new Map();
  const stack = new Set();
  const resolve = (name) => {
    if (scope.has(name) || stack.has(name) || GLOBAL_OK.has(name)) return;
    stack.add(name);
    try {
      const at = findDecl(chunk, name);
      if (at < 0) return;
      const lit = literalAt(chunk, at);
      if (!lit) return;
      if (SUSPICION.test(lit)) throw new Error(`Gyanús token a(z) "${name}" deklarációjában — kiértékelés megtagadva.`);
      for (const sub of valueIdentifiers(lit)) resolve(sub);
      scope.set(name, evalWithScope(lit, scope));
    } finally {
      stack.delete(name);
    }
  };
  for (const n of names) resolve(n);
  return scope;
}

/** Kiértékelés a chunk-beli változók feloldásával; a feloldhatatlan azonosító `void 0`. */
function evalScoped(code, chunk, what) {
  if (SUSPICION.test(code)) {
    throw new Error(`Gyanús token a(z) "${what}" literalban — kiértékelés megtagadva.`);
  }
  const free = valueIdentifiers(code).filter((n) => !GLOBAL_OK.has(n));
  const scope = buildScope(chunk, free);
  try {
    return evalWithScope(code, scope);
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

/**
 * Az egyeztetés-lista kinyerése: `Vo=[{id:`…`}]` formájú tömb (a minifikálás
 * minden buildnél átnevezi: Lo → Vo …), és az index-bundle-ban más `=[{id:`
 * tömbök is szerepelnek elébe rakva (pl. social-ikonok `Glyph:Fp` külső
 * hivatkozással, onboarding-dobozok). Ezért MINDEN chunk minden jelöltjét
 * végigpróbáljuk: a szeletnek tartalmaznia kell `participants:`-t, kiértékelő
 * és formailag is illőnek (id + résztvevő-szám) kell lennie.
 * Visszatérés: { discussions, chunk }.
 */
function extractListing(chunks) {
  const attempts = [];
  for (const c of chunks) {
    for (const decl of c.text.matchAll(/=\[\{id:/g)) {
      const open = decl.index + decl[0].indexOf("[");
      const close = bracket(c.text, open);
      if (close < 0) { attempts.push(`${c.name}@${decl.index}: nincs zárójel`); continue; }
      const raw = c.text.slice(open, close + 1);
      if (!/\bparticipants:\s*\d+/.test(raw)) continue; // nem az egyeztetés-lista
      let arr;
      try { arr = evalScoped(raw, c.text, `egyeztetés-tömb (${c.name})`); }
      catch (e) { attempts.push(`${c.name}@${decl.index}: ${e.message}`); continue; }
      const ok =
        Array.isArray(arr) && arr.length > 3 &&
        arr.every((d) => d && typeof d.id === "string") &&
        arr.filter((d) => typeof d.participants === "number").length >= arr.length / 2;
      if (ok) return { discussions: arr, chunk: c.name };
      attempts.push(`${c.name}@${decl.index}: formailag nem illik (${Array.isArray(arr) ? arr.length + " elem" : typeof arr})`);
    }
  }
  throw new Error(
    `Nem találom az egyeztetés-tömböt. Próbálkozások: ${attempts.join("; ") || "nincs jelölt"}`,
  );
}

/** JSON.parse(`...`) blokkok kinyerése. */
/**
 * A témaszavazás „top ötletek" listája a bundle-ből: az `ideas` tömb objektumokkal
 * (id, title, description, categoryId, photo, support). Ez a NYILVÁNOS, beégetett
 * szavazatszám – a honlapi „top szavazatok" szekció automatikus forrása. (Az élő
 * ötlettár támogatásszámlálói Turnstile mögött vannak, külön pillanatképben.)
 */
function extractTopIdeas(chunks) {
  for (const c of chunks) {
    const i = c.text.indexOf('"ideas":[');
    if (i < 0) continue;
    const start = c.text.indexOf("[", i);
    if (start < 0) continue;
    let depth = 0, end = -1;
    for (let p = start; p < c.text.length; p++) {
      const ch = c.text[p];
      if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) { end = p; break; } }
    }
    if (end < 0) continue;
    try {
      const arr = JSON.parse(c.text.slice(start, end + 1));
      if (Array.isArray(arr) && arr.length && arr[0]?.support !== undefined) {
        return {
          title: c.text.match(/"topTopics":\{"title":"([^"]+)"/)?.[1] ?? null,
          ideas: arr.map((x) => ({
            id: x.id, title: x.title, description: x.description ?? null,
            categoryId: x.categoryId ?? null, photo: x.photo ?? null, support: x.support ?? 0,
          })),
        };
      }
    } catch { /* nem ez a tömb – tovább */ }
  }
  return null;
}

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
 * A részletes téma-objektum `chapters:[` kulcsának helye.
 *
 * A `chapters:[` előfordulás sok témánál egymás mellett van, és a téma
 * azonosítója a *listában* jóval korábbi előfordulás. Ezért nem elég a
 * `chapters:[` kulcsszót keresni: meg kell nézni, hogy az adott blokk
 * ugyanahhoz a témához tartozik-e.
 *
 * A jel: a téma saját objektuma `id:`-vel kezdődik, és a `chapters:[` a
 * `heroTitle`/`heroLead`/`backdrop` mezők UTÁN jön – vagyis a blokk előtti
 * ablakban meg kell lennie a téma `id:` mezőjének (literál vagy a kiemelt
 * változó nevével).
 */
function findDetailChapters(src, fromIdx, id, aliases) {
  const win = 1200;
  let pos = fromIdx;
  while (true) {
    const ci = src.indexOf("chapters:[", pos);
    if (ci < 0) return -1;
    // a blokk előtti ablakban kell lennie a téma saját `id:`-jének
    const before = src.slice(Math.max(0, ci - win), ci);
    const idHit =
      before.includes(`id:\`${id}\``) ||
      [...aliases].some((a) => new RegExp(`id:\\s*${a}\\s*,`).test(before));
    if (idHit) return ci;
    pos = ci + 1;
  }
}

/**
 * A nyitott témák részletes objektumai: `{id:`X`, …, chapters:[{title,minutes,steps}]}`
 * A `steps` lehet inline tömb vagy hivatkozott változó (pl. `steps:Js`).
 *
 * A MEMI-téma két okból különbözik: az azonosítója egy kiemelt változó
 * (`id:b`, ahol `b` a témaazonosító), és a lépései egy `.map()` hívásból
 * jönnek (`steps:bt.map(...)`), ahol a `bt` `[id,hu,en]` sorokból álló tömb.
 * Ezek nélkül a téma 0 fejezettel és 0 lépéssel érkezne.
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

  /**
   * A `.map()`-ból származó lépések: a forrás tömb `[id,hu,en]` sorokból áll,
   * a callback pedig megmondja, melyik lépések illusztrációk (`St.has(id)`)
   * és hány percesek (`r===xt?0:…`). A `kind` és a `minutes` a callbackből
   * olvasható ki, ezért ezeket mintákkal keressük.
   */
  const resolveMappedSteps = (body) => {
    const m = body.match(/\bsteps:\s*([A-Za-z_$][\w$]*)\s*\.\s*map\s*\(/);
    if (!m) return null;
    const rows = resolveVar(m[1]);
    if (!Array.isArray(rows) || !rows.length) return null;

    // az illusztrációk halmaza: `St=new Set([`a`,`b`])`
    const infoIds = new Set();
    const setName = body.match(/\bsteps:[\s\S]{0,400}?([A-Za-z_$][\w$]*)\s*\.\s*has\s*\(/)?.[1];
    if (setName) {
      const sm = src.match(new RegExp(`\\b${setName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
      if (sm) for (const id of sm[1].matchAll(/`([^`]+)`/g)) infoIds.add(id[1]);
    }
    // a hosszabb lépés (törvénytervezet) 6 perc, a többi 2: `e===`x`?6:2`
    const longMatch = body.match(/\be\s*===\s*`([^`]+)`\s*\?\s*(\d+)\s*:\s*(\d+)/);
    const lastIdx = rows.length - 1;

    return rows.map((row, i) => {
      const [id, hu, en] = Array.isArray(row) ? row : [row?.id, row?.title?.hu, row?.title?.en];
      let minutes = longMatch ? Number(longMatch[3]) : 2;
      if (longMatch && id === longMatch[1]) minutes = Number(longMatch[2]);
      if (i === lastIdx) minutes = 0; // a zárólépés (összegzés) nulla perc
      return {
        id,
        title: { hu: hu ?? null, en: en ?? null },
        kind: infoIds.has(id) ? "infographic" : "question",
        minutes,
        index: i,
      };
    });
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
    // Az azonosító lehet literál (`id:`x``) vagy kiemelt változó (`id:b`, ahol
    // `b=`x``). A változós alakot csak akkor fogadjuk el, ha a változó valóban
    // ezt az azonosítót tartalmazza — különben másik téma fejezeteit kapnánk.
    const aliasRe = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*\`${id}\``, "g");
    const aliases = new Set([...src.matchAll(aliasRe)].map((m) => m[1]));
    const idRe = aliases.size
      ? new RegExp(`id:\\s*(?:\`${id}\`|(${aliases.size ? [...aliases].join("|") : "x"}))`, "g")
      : new RegExp(`id:\\s*\`${id}\``, "g");
    for (const m of src.matchAll(idRe)) {
      // A `chapters:[` blokkot a részletes (detail) objektumban keressük, nem a
      // listában – különben egy másik téma fejezeteit kapnánk.
      const ci = findDetailChapters(src, m.index, id, aliases);
      if (ci < 0) continue;
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
        const mapped = resolveMappedSteps(body);
        const sm = body.match(/\bsteps:\s*([A-Za-z_$][\w$]*)/);
        const steps = mapped ?? (sm ? normalizeSteps(resolveVar(sm[1])) : []);
        // az `unlocksAt` lehet literál (`unlocksAt:`2026-11-03``) vagy változó (`unlocksAt:yt`)
        const unlocksAt = body.match(/\bunlocksAt:\s*`([^`]*)`/)?.[1]
          ?? (() => {
            const name = body.match(/\bunlocksAt:\s*([A-Za-z_$][\w$]*)\b(?!\s*:)/)?.[1];
            if (!name) return null;
            const at = findDecl(src, name);
            if (at < 0) return null;
            const lit = literalAt(src, at);
            return lit && /^`[^`]*`$/.test(lit) ? lit.slice(1, -1) : null;
          })();
        return {
          index: idx,
          title: { hu: cm[0].match(/hu:\s*`([^`]*)`/)?.[1] ?? null, en: cm[0].match(/en:\s*`([^`]*)`/)?.[1] ?? null },
          minutes: Number(cm[0].match(/minutes:\s*(\d+)/)?.[1] ?? 0),
          unlocksAt,
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
  const { discussions, chunk: discChunkName } = extractListing(chunks);
  console.log(`egyeztetések: ${discussions.length}  (${discChunkName})`);

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

  // 5b) Témaszavazás „top ötletek" (a bundle-be égetett nyilvános szavazatszámok)
  const topIdeas = extractTopIdeas(chunks);
  if (topIdeas) {
    console.log(`top ötletek: ${topIdeas.ideas.length}  (${topIdeas.ideas.reduce((n, x) => n + x.support, 0)} szavazat)`);
  } else {
    console.warn("  ! nem találom a top ötletek tömbjét a bundle-ben");
  }

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

  /**
   * A kozhang.hu futásidőben számolja a státuszt és a hátralévő napokat
   * (`qa()` a bundle-ben): a lejárt (`closesAt` < most) téma "closed", a
   * `daysLeft` pedig a `closesAt` és a most közötti különbség — nem a
   * buildbe égetett szám. Ugyanezt számoljuk itt is, hogy a lejárt témák
   * ne "nyitott, 14 nap van hátra" felirattal jelenjenek meg.
   */
  const NOW = Date.now();
  const DAY = 86400000;
  const parseLocal = (s) => {
    if (!s) return null;
    // A bundle dátumai helyi (Budapest) időzónában értendők: "2026-11-08T23:59:00".
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? s + "+01:00" : s);
    return Number.isNaN(t) ? null : t;
  };
  const runtimeStatus = (d) => {
    const closes = parseLocal(d.closesAt);
    if (closes !== null && NOW >= closes) return "closed";
    if (d.status !== "open") return d.status;
    const opens = parseLocal(d.opensAt);
    if (opens !== null && NOW < opens) return "soon";
    return "open";
  };
  const runtimeDaysLeft = (d, status) => {
    const closes = parseLocal(d.closesAt);
    if (closes !== null) {
      if (status === "closed") return 0;
      return Math.max(1, Math.floor((closes - NOW) / DAY));
    }
    return d.daysLeft ?? null;
  };

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
    const status = runtimeStatus(d);
    return {
      id: d.id,
      title: d.title,
      description: d.description,
      lead: d.lead,
      category: d.category,
      scope: d.scope ?? "national",
      status,
      locality: d.locality ?? null,
      participants: d.participants ?? 0,
      completionRate: d.completionRate ?? 0,
      daysLeft: runtimeDaysLeft(d, status),
      opensAt: d.opensAt ?? null,
      closesAt: d.closesAt ?? null,
      resultsAt: d.resultsAt ?? null,
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
      closed: items.filter((i) => i.status === "closed").length,
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
    topIdeas,
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
