#!/usr/bin/env node
/**
 * build.mjs — statikus generálás a GitHub Pages-hez
 *
 *   node build.mjs          (vagy: npm run build)
 *
 * Bemenet:
 *   public/data/recommendations.json   extract.mjs adatcsomagja
 *   content/kiemelt.json               kézzel szerkesztett KIEMELT felhívások (opcionális)
 *
 * Kimenet (git-eltől független, CI-ben készül, .gitignore-ban):
 *   public/kategoria/<kategória>/index.html   7 db témaajánló aloldal
 *   public/sitemap.xml, public/robots.txt
 *
 * Hibák (ismeretlen discussionId/stepId, rossz domain) → exit 1, hogy a
 * CI deploy-ja NE fusson le hibás/holt linkű oldalakkal.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, "public");
const OUT = path.join(PUB, "kategoria");
const SITE = "https://madcsaba.github.io/kozhang_ajanlo";

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n == null ? "—" : new Intl.NumberFormat("hu-HU").format(n);
const pickHu = (v) => typeof v === "string" ? v : (v?.hu || v?.en || "");

let DATA;
try {
  DATA = JSON.parse(fs.readFileSync(path.join(PUB, "data/recommendations.json"), "utf8"));
} catch (e) {
  fail(`nem olvasható az adatcsomag (futtasd: node extract.mjs) — ${e.message}`);
}

/**
 * Kategória-sablonok: címke + az irányított bevezető szöveg.
 * EZ A HELY, AHOL A SAJÁT SZÖVEGEID ÁLLNAK — kategóriánként egy-egy.
 */
const CATS = {
  "public-media": {
    label: "Közmédia",
    intro: "A közmédia jövője mindannyiunk ügye. Itt gyűjtjük a közmédiával kapcsolatos egyeztetéseket, a nyitott kérdéseket és a műsorötleteket — szólj hozzá te is, mert egyetlen szavazaton is múlhat, mi kerül képernyőre 2030-ban.",
  },
  "culture": {
    label: "Kultúra",
    intro: "A kultúra, a közös emlékezet és a társadalmi együttélés kérdései szinte mindig szerepelnek a Közhang egyeztetéseiben. Ha neked is van véleményed arról, milyen kulturális témákat érdemes felvenni a napirendre, itt találod a kapcsolódó alkalmakat.",
  },
  "transport": {
    label: "Közlekedés",
    intro: "KRESZ, vasúti közlekedés, kerékpáros nyomvonalak, helyi forgalmi rendek — a közlekedési döntések mindennapjainkat érintik, mégis kevesen szólalnak meg bennük. Válassz témát, és szavazz, hogy merre menjünk.",
  },
  "digital": {
    label: "Digitális",
    intro: "Digitális közigazgatás, közös platformok, adat és nyitottság — a digitális témák gyorsan dőlnek el, mert kevés résztvevő dönt róluk. Érdemes bele szólni, amíg nyitott az ajtó.",
  },
  "economy": {
    label: "Gazdaság",
    intro: "A gazdaság jövője, a helyi vállalkozások és a mezőgazdaság kérdései hosszú távon formálják a környezetedet. Itt találod a nyitott és hamarosan nyíló gazdasági egyeztetéseket — a véleményed még időben számít.",
  },
  "municipality": {
    label: "Önkormányzat",
    intro: "Legyen szó tisztább utcákról, lakhatásról vagy egy tó vízminőségéről: az önkormányzati döntések a te környékedet érintik a legközelebbről. Ezek az egyeztetések gyakran helyi kérdésekről szólnak, ahol egyetlen visszajelzés is irányt mutathat.",
  },
  "climate": {
    label: "Klíma és környezet",
    intro: "Vizek minősége, tópartok, környezetvédelem — a klíma- és természetvédelmi témák most dőlnek el, amikor még van rá idő. Ha fontos neked a környezeted, itt szavazhatsz a megőrzéséről.",
  },
  "legislation": {
    label: "Jogszabályozás",
    intro: "Új intézmények, törvénytervezetek és a szabályok, amelyek alakítják a közös életünket. A jogszabályokról szóló egyeztetésekben a véleményed akkor számít, amikor még van rá idő — szólj hozzá, mielőtt véglegessé válnak.",
  },
};

// ————————————————————————————————————————————————————————— súgók

const megye = (s) => String(s).replace(/vármegye/g, "megye"); // felirat: „Heves vármegye” → „Heves megye”
const place = (d) => d.locality ? megye(d.locality.label?.hu || d.locality.town) : "Országos";
const EXT = `target="_blank" rel="noopener"`;
const ARROW = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>`;

// nyitott egyeztetés: határidő-blokk + leírás + részvételi oldalsáv (mint a főoldalon)
const openRow = (d) => {
  const label = CATS[d.category]?.label ?? d.category;
  const facts = [];
  if (d.chapterCount) facts.push(`${d.chapterCount} fejezet`);
  if (d.stepCount) facts.push(`${d.stepCount} lépés`);
  if (d.totalMinutes) facts.push(`kb. ${d.totalMinutes} perc`);
  if (d.knowledgeCount) facts.push(`${d.knowledgeCount} háttércikk`);
  const rate = d.completionRate || 0;
  return `<article class="panel open-row">
    <div class="days"><b>${d.daysLeft ?? "—"}</b><span>nap van hátra</span></div>
    <div class="open-body">
      <span class="kicker">${esc(label)} · ${esc(place(d))}</span>
      <h3><a href="${esc(d.url)}" ${EXT}>${esc(pickHu(d.title))}</a></h3>
      <p>${esc(pickHu(d.description))}</p>
      ${facts.length ? `<span class="facts">${facts.join(" · ")}</span>` : ""}
    </div>
    <div class="side">
      <span>${d.participants ? `<b>${fmt(d.participants)}</b> résztvevő` : `<b>Most indult</b> – légy az elsők között`}</span>
      ${rate ? `<div class="meter" role="img" aria-label="${rate}% végig is ment"><i style="width:${rate}%"></i></div><small>${rate}% végig is ment</small>` : ""}
      <a class="btn primary" href="${esc(d.url)}" ${EXT}>Részt veszek</a>
    </div>
  </article>`;
};

// közelgő egyeztetés: táblázatsor
const soonRow = (d) => `<div class="t-row">
    <span class="c-when">${d.daysLeft != null ? `<b>${d.daysLeft} nap</b><span>múlva nyílik</span>` : `<b>Hamarosan</b>`}</span>
    <span class="c-title">
      <a href="${esc(d.url)}" ${EXT}>${esc(pickHu(d.title))}</a>
      <span>${esc(pickHu(d.description))}</span>
    </span>
    <span class="c-place">${esc(place(d))}</span>
    <span class="c-people">${d.participants ? `${fmt(d.participants)} érdeklődő` : "Új téma"}</span>
    <span class="c-act"><a class="btn small" href="${esc(d.url)}" ${EXT}>Megnézem</a></span>
  </div>`;

const kitem = (k) => {
  const d = k.date ? new Date(k.date + "T00:00:00") : null;
  const dateTxt = d && !isNaN(d) ? d.toLocaleDateString("hu-HU", { month: "short", day: "numeric" }) : "";
  const src = k.source ? (typeof k.source === "string" ? k.source : pickHu(k.source.name ?? k.source)) : "";
  const lead = pickHu(k.lead);
  const sub = src || (lead.slice(0, 110) + (lead.length > 110 ? "…" : ""));
  return `<a class="k-item" href="${esc(k.url)}" ${EXT}>
    <span class="k-date">${esc(dateTxt)}</span>
    <span class="k-text"><span class="k-title">${esc(pickHu(k.title))}</span><span class="k-src">${esc(sub)}</span></span>
  </a>`;
};

// ——————————————————————————————————————————— kiemelt felhívások (content/kiemelt.json)

function loadPromo() {
  const f = path.join(HERE, "content", "kiemelt.json");
  if (!fs.existsSync(f)) return [];
  let list;
  try { list = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { fail(`content/kiemelt.json nem értelmezhető — ${e.message}`); }
  if (!Array.isArray(list)) fail("content/kiemelt.json: tömböt várunk");

  return list.map((item, i) => {
    const where = `kiemelt.json[${i}]`;
    if (!item.discussionId) fail(`${where}: hiányzik a discussionId`);
    const d = DATA.discussions.find(x => x.id === item.discussionId);
    if (!d) fail(`${where}: ismeretlen discussionId „${item.discussionId}”`);

    let url = item.url || null;
    let how = "az egyeztetés főoldala";
    if (!url && item.stepId) {
      const q = (d.questions || []).find(q => q.id === item.stepId);
      if (!q) fail(`${where}: ismeretlen stepId „${item.stepId}” a(z) ${d.id} egyeztetésben`);
      url = q.url; how = `közvetlen lépés: ${pickHu(q.title)}`;
    } else if (!url && item.useIdeas) {
      if (!d.ideasUrl) fail(`${where}: a(z) ${d.id} egyeztetésnek nincs ideasUrl-je`);
      url = d.ideasUrl; how = "az ötletek listája";
    }
    if (!url) { url = d.url; }
    if (!/^https:\/\/kozhang\.hu\//.test(url)) fail(`${where}: csak kozhang.hu URL engedélyezett (kapott: ${url})`);
    if (!CATS[d.category]) fail(`${where}: a(z) ${d.category} kategóriához nincs sablon (CATS)`);
    return { ...item, discussion: d, url, target: how };
  });
}

const promoHtml = (p) => {
  const d = p.discussion;
  return `<section id="kiemelt">
  <div class="panel promo">
    <span class="tag">${esc(p.label || "Kiemelt felhívás")}</span>
    <h3>${esc(p.title)}</h3>
    <p>${esc(p.pitch)}</p>
    ${p.preferred ? `<p class="pref"><b>Ajánlott választás:</b> ${esc(p.preferred)}</p>` : ""}
    <div class="acts">
      <a class="btn primary" href="${esc(p.url)}" ${EXT}>${esc(p.cta || "Irány a szavazás")} ${ARROW}</a>
      <a class="btn" href="${esc(d.url)}" ${EXT}>A teljes egyeztetés</a>
    </div>
    <p class="discl">Kiemelt szervezői ajánlás (irányított) – a döntés a tiéd. Cél: ${esc(p.target)}. Adat: kozhang.hu</p>
  </div>
</section>`;
};

// —————————————————————————————————————————————————————— aloldal-sablon

function page(catKey, discs, knos, promos) {
  const { label, intro } = CATS[catKey];
  const openList = discs.filter(d => d.status === "open").sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));
  const soonList = discs.filter(d => d.status !== "open").sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));
  const questions = discs.reduce((n, d) => n + (d.questions?.length || 0), 0);
  const desc = `${intro} ${discs.length} egyeztetés, ${questions} kérdés – a kozhang.hu nyilvános adataiból.`;
  const gen = new Date(DATA.generatedAt || Date.now());
  const genTxt = isNaN(gen) ? "" : gen.toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" });

  const others = Object.keys(CATS)
    .filter(k => k !== catKey)
    .map(k => `<a class="chip" href="../${k}/">${esc(CATS[k].label)}</a>`).join("");

  const statline = `<div class="statline" aria-label="Számok"><div class="wrap">
    <span><b>${discs.length}</b> egyeztetés</span>
    <span><b>${openList.length}</b> most nyitott</span>
    <span><b>${soonList.length}</b> hamarosan</span>
    <span><b>${questions || "—"}</b> lépés</span>
    <span><b>${knos.length || "—"}</b> háttércikk</span>
    <span class="src">Frissítve: ${esc(genTxt)} · forrás: kozhang.hu</span>
  </div></div>`;

  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(label)} – miben érdemes részt venned? | Közhang témaajánló</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/kategoria/${catKey}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Közhang témaajánló">
<meta property="og:title" content="${esc(label)} – miben érdemes részt venned?">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/kategoria/${catKey}/">
<meta name="twitter:card" content="summary">
<link rel="icon" href="https://kozhang.hu/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Public+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="../../assets/site.css">
</head>
<body>

<header class="site-head">
  <div class="wrap">
    <a class="brand" href="../../">
      <span class="brand-mark"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h3l3-7 4 14 3-7h3"/></svg></span>
      <span class="brand-name"><b>Témaajánló</b><span>független segédlet a kozhang.hu egyeztetéseihez</span></span>
    </a>
    <nav class="site-nav" aria-label="Fő navigáció">
      ${openList.length ? `<a href="#nyitott">Most nyitott</a>` : ""}
      ${soonList.length ? `<a href="#hamarosan">Hamarosan</a>` : ""}
      ${knos.length ? `<a href="#tudaster">Tudástér</a>` : ""}
      <a href="../../">Minden téma</a>
    </nav>
  </div>
</header>
<div class="notice">
  <div class="wrap">
    <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
    <span>Nem hivatalos oldal. A válaszadás mindig a <b>kozhang.hu</b>-n történik – mi csak rendezzük és ajánljuk a nyilvános témákat.</span>
  </div>
</div>

<div class="hero">
  <div class="wrap" style="grid-template-columns:1fr">
    <div class="hero-main">
      <nav class="crumbs" aria-label="Morzsamenü"><a href="../../">Főoldal</a> <span>›</span> <span>Kategória</span> <span>›</span> <b>${esc(label)}</b></nav>
      <h1>${esc(label)} – miben érdemes részt venned?</h1>
      <p class="sub" style="max-width:72ch">${esc(intro)}</p>
    </div>
  </div>
</div>
${statline}

<main class="wrap">
${promos.map(promoHtml).join("\n")}

${openList.length ? `<section id="nyitott">
  <div class="sec-head"><div>
    <h2 class="sec">Most nyitott</h2>
    <span class="hint">Határidő szerint – ami hamarabb zárul, előrébb van</span>
  </div></div>
  <div class="open-list">${openList.map(openRow).join("")}</div>
</section>` : ""}

${soonList.length ? `<section id="hamarosan">
  <div class="sec-head"><div>
    <h2 class="sec">Hamarosan nyílik</h2>
    <span class="hint">${soonList.length} egyeztetés – a megnyitás előtt is megnézheted őket</span>
  </div></div>
  <div class="panel table">
    <div class="t-head" aria-hidden="true">
      <span class="c-when">Nyílik</span><span class="c-title">Egyeztetés</span><span class="c-place">Hely</span><span class="c-people">Érdeklődő</span><span class="c-act"></span>
    </div>
    ${soonList.map(soonRow).join("")}
  </div>
</section>` : ""}

${knos.length ? `<section id="tudaster">
  <div class="sec-head"><div>
    <h2 class="sec">Mielőtt válaszolsz: Tudástér</h2>
    <span class="hint">${knos.length} háttércikk a kozhang.hu-ról</span>
  </div></div>
  <div class="panel k-group">${[...knos].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).map(kitem).join("")}</div>
</section>` : ""}

<section id="tovabbi">
  <div class="sec-head"><div>
    <h2 class="sec">További témák</h2>
    <span class="hint">Minden kategóriának saját aloldala van</span>
  </div></div>
  <div class="chips">${others}</div>
  <p style="margin:24px 0 0"><a class="btn" href="../../">← Minden téma és szűrő a főoldalon</a></p>
</section>
</main>

<footer class="site-foot">
  <div class="wrap">
    <div>
      <span class="brand-foot">Témaajánló</span>
      <span>Nem hivatalos, nem a Közhang terméke. A tartalom és a témaadatok a <a href="https://kozhang.hu" ${EXT}>Közhang Nonprofit Kft.</a> tulajdona.</span>
    </div>
    <div>
      <b>Adatok</b>
      <span>A kozhang.hu nyilvános JavaScript bundle-jeiből, mert nincs nyilvános tartalom-API, és a böngészőoldali lekérést a CORS tiltja.</span>
      <span>Adatfrissítés: ${esc(genTxt)}</span>
    </div>
    <div>
      <b>Kapcsolat</b>
      <a href="mailto:info@kozhang.hu">info@kozhang.hu</a>
      <a href="https://kozhang.hu/egyeztetesek" ${EXT}>kozhang.hu/egyeztetesek</a>
    </div>
  </div>
</footer>
</body>
</html>
`;
}

// ——————————————————————————————————————————————————————————— fő

const promo = loadPromo();

// a főoldal és a témaoldalak is le tudják tölteni a kiemelt felhívásokat
fs.mkdirSync(path.join(PUB, "data"), { recursive: true });
fs.writeFileSync(
  path.join(PUB, "data", "kiemelt.json"),
  JSON.stringify(
    promo.map((p) => ({
      discussionId: p.discussionId, label: p.label, title: p.title, pitch: p.pitch,
      preferred: p.preferred, cta: p.cta, url: p.url, target: p.target,
      discussionUrl: p.discussion.url,
    })),
    null, 2
  ) + "\n"
);

fs.rmSync(OUT, { recursive: true, force: true });

let pageCount = 0;
for (const key of Object.keys(CATS)) {
  const discs = DATA.discussions.filter(d => d.category === key);
  if (!discs.length) { console.error(`·  „${key}” üres – kihagyva`); continue; }
  const knos = DATA.knowledge.filter(k => (k.categories || []).includes(key));
  const promos = promo.filter(p => p.discussion.category === key);

  const dir = path.join(OUT, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), page(key, discs, knos, promos));
  pageCount++;
  console.log(`✓  kategoria/${key}/index.html  — ${discs.length} egyeztetés, ${knos.length} cikk, ${promos.length} kiemelt`);
}

// sitemap + robots
const lastmod = (() => {
  const d = new Date(DATA.generatedAt || Date.now());
  return isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
})();
const urls = [`${SITE}/`, ...Object.keys(CATS).map(k => `${SITE}/kategoria/${k}/`)];
fs.writeFileSync(path.join(PUB, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n") + `\n</urlset>\n`);
fs.writeFileSync(path.join(PUB, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`✓  sitemap.xml + robots.txt  — ${urls.length} URL, lastmod ${lastmod}`);
console.log(`Kész: ${pageCount} kategóriaaloldal.`);
