#!/usr/bin/env node
/**
 * Statikus kimenetek az adatcsomagból (public/data/recommendations.json):
 *
 *   public/tema/<id>/index.html   témánként megosztható oldal OpenGraph-kártyával
 *   public/feed.xml               Atom-hírcsatorna: új témák és megnyílt fejezetek
 *   public/naptar.ics             naptár: témanyitások és fejezet-nyitások
 *   public/sitemap.xml           (projektoldalon a robots.txt hatástalan – Search Console-ba beküldhető)
 *
 * A kimenet determinisztikus (csak az adatcsomagból számol, nem az órából),
 * és nincs verziókezelve: a deploy-pages.yml a kiadás előtt legenerálja.
 *
 * Használat:
 *   node build-pages.mjs                       → https://madcsaba.github.io/kozhang_ajanlo
 *   SITE_URL=https://pelda.hu node build-pages.mjs
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, "public");
const SITE = (process.env.SITE_URL || "https://madcsaba.github.io/kozhang_ajanlo").replace(/\/+$/, "");

const CAT = {
  "public-media": "Közmédia", culture: "Kultúra", transport: "Közlekedés",
  digital: "Digitális", economy: "Gazdaság", municipality: "Önkormányzat",
  climate: "Klíma és környezet", environment: "Környezet", health: "Egészség",
  education: "Oktatás", family: "Család", living: "Lakhatás", safety: "Közbiztonság",
  society: "Társadalom",
};
// A lépések típusjelölései (kérdés, infografika, videó…) szándékosan nem jelennek meg a témaoldalon.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hu = (v) => (typeof v === "string" ? v : v?.hu || v?.en || "");
const fmt = (n) => new Intl.NumberFormat("hu-HU").format(n ?? 0);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// A kozhang.hu időpontjai zóna nélküliek (pl. `2026-09-07T07:00:00`): budapesti helyi időnek vesszük.
const local = (ts) => (ts && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ts) ? ts.slice(0, 19) : null);
const huDate = (ts) => {
  const m = local(ts)?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "";
  const months = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
  return `${m[1]}. ${months[Number(m[2]) - 1]} ${Number(m[3])}. ${m[4]}:${m[5]}`;
};
// Atom-hoz: budapesti helyi idő → UTC ISO (CET/CEST: március utolsó vasárnapjától október utolsó vasárnapjáig +2)
function budapestToIso(ts) {
  const l = local(ts);
  if (!l) return null;
  const [y, mo, d, h, mi] = l.match(/\d+/g).map(Number);
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const t = Date.UTC(y, mo - 1, d, h, mi);
  const dstStart = Date.UTC(y, 2, lastSunday(2), 2);
  const dstEnd = Date.UTC(y, 9, lastSunday(9), 3);
  const offset = t >= dstStart && t < dstEnd ? 2 : 1;
  return new Date(t - offset * 3600e3).toISOString().replace(".000Z", "Z");
}

// ─────────────────────────────────────────────────────────── adatok ──

const DATA = JSON.parse(await readFile(path.join(PUB, "data", "recommendations.json"), "utf8"));
// kiemelt felhívások (build.mjs írja; ha nincs, kihagyjuk)
const PROMOS = await (async () => {
  try { return JSON.parse(await readFile(path.join(PUB, "data", "kiemelt.json"), "utf8")); }
  catch { return []; }
})();
const GEN = DATA.generatedAt;
const discussions = DATA.discussions;
const firstSeen = (d) => d.firstSeen || GEN;

/** Háttéranyag egy témához: közvetlen hivatkozás vagy azonos kategória. */
function knowledgeFor(d) {
  return DATA.knowledge.filter((k) => k.discussionId === d.id || (!k.discussionId && (k.categories || []).includes(d.category)));
}

/** Kapcsolódó témák: azonos megye, aztán azonos kategória; a nyitottak elöl. */
function related(d) {
  const rank = (x) =>
    (d.locality?.region && x.locality?.region === d.locality.region ? 2 : 0) + (x.category === d.category ? 1 : 0);
  return discussions
    .filter((x) => x.id !== d.id && rank(x) > 0)
    .sort((a, b) => rank(b) - rank(a) || (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1))
    .slice(0, 3);
}

// ───────────────────────────────────────────────────── témaoldalak ──

const PAGE_CSS = `
/* témaoldal – a főoldal designja (site.css) + pár saját szabály */
.t-tags{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 0}
.t-tags .tag{font-size:12.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:5px 11px;border-radius:99px;
  border:1px solid var(--line);background:var(--surface);color:var(--muted)}
.t-tags .tag.open{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.t-tags .tag.soon{color:var(--due);border-color:var(--due-soft);background:var(--due-soft)}
.lead{margin:0;font-size:17.5px;color:var(--muted);max-width:64ch}
.note{margin:14px 0 0;font-size:14.5px;color:var(--muted);max-width:82ch}
.ch{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:14px}
.ch h3{margin:0 0 4px;font-family:var(--display);font-weight:800;font-size:20px;line-height:1.2}
.ch .m{font-size:13.5px;color:var(--muted)}
.ch ol{margin:10px 0 0;padding-left:22px;font-size:15px;line-height:1.6;display:flex;flex-direction:column;gap:4px}
.t-panel{padding:4px 20px}
.hero-fig{margin:0;border-radius:var(--radius);overflow:hidden;border:1px solid var(--line);background:var(--surface2);aspect-ratio:16/7}
.hero-fig img{width:100%;height:100%;object-fit:cover;display:block}
`;

function topicPage(d) {
  const title = hu(d.title);
  const desc = hu(d.description) || hu(d.lead);
  const place = d.locality ? String(d.locality.label?.hu || d.locality.town).replace(/vármegye/g, "megye") : "Országos";
  const promo = PROMOS.find((p) => p.discussionId === d.id);
  const img = d.hero || d.photo;
  const url = `${SITE}/tema/${d.id}/`;
  const status = d.status === "open" ? "Nyitott" : d.status === "soon" ? "Hamarosan" : "Lezárult";
  const kb = knowledgeFor(d);
  const rel = related(d);

  const stats = [];
  if (d.participants) stats.push(`<span><b>${fmt(d.participants)}</b> ${d.status === "open" ? "résztvevő" : "érdeklődő"}</span>`);
  if (d.chapterCount) stats.push(`<span><b>${d.chapterCount}</b> fejezet</span>`);
  if (d.stepCount) stats.push(`<span><b>${d.stepCount}</b> lépés</span>`);
  if (d.totalMinutes) stats.push(`<span>kb. <b>${d.totalMinutes}</b> perc</span>`);
  if (d.opensAt) stats.push(`<span>nyílt: <b>${esc(huDate(d.opensAt))}</b></span>`);

  // a már megnyílt (elmúlt) fejezetnél ne mutassuk a „nyílik:” feliratot
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 19);
  const chapters = d.chapters
    .map((ch) => {
      const qs = d.questions.filter((q) => q.chapterIndex === ch.index);
      const unlock = ch.unlocksAt && ch.unlocksAt > nowLocal ? ` · nyílik: ${esc(huDate(ch.unlocksAt))}` : "";
      return `<div class="ch" id="fejezet-${ch.index + 1}">
  <h3>${ch.index + 1}. ${esc(hu(ch.title))}</h3>
  <div class="m">${ch.minutes ? `kb. ${ch.minutes} perc` : ""}${ch.stepCount ? ` · ${ch.stepCount} lépés` : ""}${unlock}</div>
  ${qs.length ? `<ol>${qs.map((q) => `<li>${esc(q.title || q.id)}</li>`).join("")}</ol>` : ""}
</div>`;
    })
    .join("\n");

  const shareText = `${title} – szólj hozzá a kozhang.hu-n`;

  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – Közhang témaajánló</title>
<meta name="description" content="${esc(clip(desc, 200))}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="https://kozhang.hu/favicon.svg">
<link rel="alternate" type="application/atom+xml" title="Közhang témaajánló – új témák" href="../../feed.xml">
<meta property="og:type" content="article">
<meta property="og:locale" content="hu_HU">
<meta property="og:site_name" content="Közhang témaajánló (nem hivatalos)">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(clip(desc, 200))}">
<meta property="og:url" content="${esc(url)}">
${img ? `<meta property="og:image" content="${esc(img)}">\n<meta name="twitter:image" content="${esc(img)}">` : ""}
<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Public+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="../../assets/site.css">
<style>${PAGE_CSS}</style>
</head>
<body>

<header class="site-head">
  <div class="wrap">
    <a class="brand" href="../../">
      <span class="brand-mark"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h3l3-7 4 14 3-7h3"/></svg></span>
      <span class="brand-name"><b>Témaajánló</b><span>független segédlet a kozhang.hu egyeztetéseihez</span></span>
    </a>
    <nav class="site-nav" aria-label="Fő navigáció">
      <a href="../../#nyitott">Most nyitott</a>
      <a href="../../#hamarosan">Hamarosan</a>
      <a href="../../#temak">Témaszavazás</a>
      <a href="../../#tudaster">Tudástér</a>
      <a href="../../feed.xml">Hírcsatorna</a>
    </nav>
  </div>
</header>

<div class="hero">
  <div class="wrap">
    <div class="hero-main">
      <p class="crumbs"><a href="../../">Főoldal</a> › <a href="../../kategoria/${esc(d.category)}/">${esc(CAT[d.category] || d.category)}</a> › <b>${esc(title)}</b></p>
      <div class="t-tags">
        <span class="tag ${esc(d.status)}">${status}</span>
        <span class="tag">📍 ${esc(place)}</span>
      </div>
      <h1>${esc(title)}</h1>
      <p class="lead">${esc(desc)}</p>
      ${d.lead && hu(d.lead) !== desc ? `<p class="note">${esc(hu(d.lead))}</p>` : ""}
      <div class="acts">
        <a class="btn primary" href="${esc(d.url)}" target="_blank" rel="noopener">${d.status === "open" ? "Részvétel a kozhang.hu-n →" : "Megnézem a kozhang.hu-n →"}</a>
        <button class="btn" id="share" type="button" data-url="${esc(url)}" data-text="${esc(shareText)}">Megosztás</button>
      </div>
    </div>
    ${img ? `<figure class="hero-fig"><img src="${esc(img)}" alt="" onerror="this.closest('.hero-fig').remove()"></figure>` : ""}
  </div>
</div>

<div class="statline" aria-label="Számok">
  <div class="wrap">${stats.join("")}</div>
</div>

<main class="wrap">
${promo ? `<section id="kiemelt" aria-label="Kiemelt felhívás">
  <div class="panel promo">
    <span class="tag">${esc(promo.label || "Kiemelt felhívás")}</span>
    <h3>${esc(promo.title)}</h3>
    <p>${esc(promo.pitch)}</p>
    ${promo.preferred ? `<p class="pref"><b>Ajánlott választás:</b> ${esc(promo.preferred)}</p>` : ""}
    <div class="acts">
      <a class="btn primary" href="${esc(promo.url)}" target="_blank" rel="noopener">${esc(promo.cta || "Irány a szavazás")} →</a>
      <a class="btn" href="${esc(promo.discussionUrl)}" target="_blank" rel="noopener">A teljes egyeztetés</a>
    </div>
    <p class="discl">Kiemelt szervezői ajánlás (irányított) – a döntés a tiéd. Cél: ${esc(promo.target)}. Adat: kozhang.hu</p>
  </div>
</section>` : ""}
<section id="fejezetek">
  <div class="sec-head">
    <div>
      <h2 class="sec">Fejezetek és lépések</h2>
      <span class="hint">${chapters ? `${d.chapterCount || d.chapters.length} fejezet${d.stepCount ? ` · ${d.stepCount} lépés` : ""}` : "a részletes fejezetlista a téma megnyílásakor lesz elérhető"}</span>
    </div>
  </div>
  <p class="note">Az ajánló azt segít eldönteni, <b>miről</b> érdemes véleményt mondanod – azt soha, hogy <b>mit</b>. A válaszadás a kozhang.hu-n, bejelentkezés után történik.</p>
  ${chapters || `<p class="note">A részletes fejezetlista a téma megnyílásakor lesz elérhető.</p>`}
</section>

${kb.length ? `<section id="tudaster-tema">
  <div class="sec-head">
    <div>
      <h2 class="sec">Háttéranyagok a Tudástérben</h2>
      <span class="hint">${kb.length} cikk ehhez a témához</span>
    </div>
    <a class="btn small" href="https://kozhang.hu/tudaster" target="_blank" rel="noopener">A Tudástér a kozhang.hu-n</a>
  </div>
  <div class="panel t-panel">
    ${kb.map((k) => {
      const dt = k.date ? new Date(k.date + "T00:00:00") : null;
      const dateTxt = dt && !isNaN(dt) ? dt.toLocaleDateString("hu-HU", { month: "short", day: "numeric" }) : "";
      const src = k.source ? (typeof k.source === "string" ? k.source : hu(k.source.name ?? k.source)) : "";
      const sub = src || clip(hu(k.lead), 110);
      return `<a class="k-item" href="${esc(k.url)}" target="_blank" rel="noopener">
      <span class="k-date">${esc(dateTxt)}</span>
      <span class="k-text"><span class="k-title">${esc(hu(k.title))}</span><span class="k-src">${esc(sub)}</span></span>
    </a>`;
    }).join("\n    ")}
  </div>
</section>` : ""}

${rel.length ? `<section id="kapcsolodo">
  <div class="sec-head">
    <div><h2 class="sec">Kapcsolódó témák</h2></div>
  </div>
  <div class="panel t-panel">
    ${rel.map((x) => `<a class="k-item" href="../${esc(x.id)}/">
      <span class="k-date">${x.status === "open" ? "nyitott" : "hamarosan"}</span>
      <span class="k-text"><span class="k-title">${esc(hu(x.title))}</span><span class="k-src">${esc(x.locality ? String(x.locality.label?.hu || x.locality.town).replace(/vármegye/g, "megye") : "Országos")}</span></span>
    </a>`).join("\n    ")}
  </div>
</section>` : ""}
</main>

<footer class="site-foot">
  <div class="wrap">
    <div>
      <span class="brand-foot">Témaajánló</span>
      <span>Nem hivatalos, nem a Közhang terméke. A tartalom és a témaadatok a <a href="https://kozhang.hu" target="_blank" rel="noopener">Közhang Nonprofit Kft.</a> tulajdona.</span>
    </div>
    <div>
      <b>Adatok</b>
      <span>Forrás: <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url.replace("https://", ""))}</a> · frissítve: ${esc(huDate(GEN.slice(0, 19)) || GEN)} · build ${esc(DATA.sourceBuild || "—")}</span>
      <span>Kövesd az új témákat és fejezetnyitásokat: <a href="../../feed.xml">hírcsatorna (Atom)</a> · <a href="../../naptar.ics">naptár (.ics)</a></span>
    </div>
    <div>
      <b>Kapcsolat</b>
      <a href="mailto:info@kozhang.hu">info@kozhang.hu</a>
      <a href="https://kozhang.hu/egyeztetesek" target="_blank" rel="noopener">kozhang.hu/egyeztetesek</a>
    </div>
  </div>
</footer>
<script>
document.getElementById("share").addEventListener("click", async (e) => {
  const b = e.currentTarget, url = b.dataset.url, text = b.dataset.text;
  try {
    if (navigator.share) { await navigator.share({ title: document.title, text, url }); return; }
    await navigator.clipboard.writeText(url);
    b.textContent = "Link másolva ✓";
  } catch { /* a felhasználó megszakította */ }
});
</script>
</body>
</html>
`;
}

// ──────────────────────────────────────────────────────── események ──

/** Időrendi események a hírcsatornához és a naptárhoz – csak valódi időpontokból. */
const events = [];
for (const d of discussions) {
  const title = hu(d.title);
  events.push({
    kind: "new", id: `tema:${d.id}`, when: firstSeen(d), page: `${SITE}/tema/${d.id}/`, d,
    title: `${d.status === "open" ? "Nyitott" : "Hamarosan"}: ${title}`,
    summary: hu(d.description),
  });
  if (d.opensAt) {
    events.push({
      kind: "open", id: `nyitas:${d.id}`, local: local(d.opensAt), when: budapestToIso(d.opensAt),
      page: `${SITE}/tema/${d.id}/`, d,
      title: `Megnyílt: ${title}`, summary: hu(d.description),
    });
  }
  for (const ch of d.chapters) {
    if (!ch.unlocksAt) continue;
    events.push({
      kind: "chapter", id: `fejezet:${d.id}:${ch.index + 1}`, local: local(ch.unlocksAt), when: budapestToIso(ch.unlocksAt),
      page: `${SITE}/tema/${d.id}/#fejezet-${ch.index + 1}`, d,
      title: `Új fejezet – ${title}: ${ch.index + 1}. ${hu(ch.title)}`,
      summary: `${ch.minutes ? `kb. ${ch.minutes} perc, ` : ""}${ch.stepCount} lépés. ${hu(d.description)}`,
    });
  }
}

// a főoldali Naptár szekció adatfájlja (legutóbbi 2 hét + közelgő események)
const calCutoff = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
await writeFile(
  path.join(PUB, "data", "esemenyek.json"),
  JSON.stringify(
    events
      .filter((e) => e.local && e.local.slice(0, 10) >= calCutoff)
      .map((e) => ({
        date: e.local.slice(0, 10), time: e.local.slice(11, 16) || null, kind: e.kind,
        title: e.title, page: e.page, cat: CAT[e.d.category] || e.d.category,
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""))
      .slice(0, 40),
    null, 2
  ) + "\n"
);

// ─────────────────────────────────────────────────────────── Atom ──

function atom() {
  // A hírcsatornába csak a már bekövetkezett események kerülnek.
  const past = events.filter((e) => e.when && e.when <= GEN).sort((a, b) => b.when.localeCompare(a.when)).slice(0, 50);
  const updated = past[0]?.when || GEN;
  const host = new URL(SITE).host;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="hu">
  <title>Közhang témaajánló – új témák és fejezetek</title>
  <subtitle>Nem hivatalos hírcsatorna a kozhang.hu nyilvános egyeztetéseiről</subtitle>
  <id>tag:${host},2026:feed</id>
  <link rel="self" href="${esc(SITE)}/feed.xml"/>
  <link rel="alternate" href="${esc(SITE)}/"/>
  <updated>${updated}</updated>
  <author><name>Közhang témaajánló</name></author>
${past
  .map(
    (e) => `  <entry>
    <id>tag:${host},2026:${esc(e.id)}</id>
    <title>${esc(e.title)}</title>
    <link rel="alternate" href="${esc(e.page)}"/>
    <updated>${e.when}</updated>
    <category term="${esc(e.d.category)}" label="${esc(CAT[e.d.category] || e.d.category)}"/>
    <summary>${esc(e.summary)}</summary>
  </entry>`,
  )
  .join("\n")}
</feed>
`;
}

// ───────────────────────────────────────────────────────────── ICS ──

const icsEsc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** RFC 5545: 75 oktettnél hosszabb sorok tördelése. */
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > (out.length ? 74 : 75)) { out.push(cur); cur = ""; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const icsLocal = (l) => l.replace(/[-:]/g, "").slice(0, 15); // 2026-09-07T07:00:00 → 20260907T070000
const icsUtc = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z";

function ics() {
  const host = new URL(SITE).host;
  const dated = events.filter((e) => e.local).sort((a, b) => a.local.localeCompare(b.local));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//kozhang-ajanlo//HU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Közhang – nyitások (nem hivatalos)",
    "X-WR-TIMEZONE:Europe/Budapest",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Budapest",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  for (const e of dated) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id.replace(/:/g, "-")}@${host}`,
      `DTSTAMP:${icsUtc(GEN)}`,
      `DTSTART;TZID=Europe/Budapest:${icsLocal(e.local)}`,
      "DURATION:PT30M",
      `SUMMARY:${icsEsc(e.title)}`,
      `DESCRIPTION:${icsEsc(`${e.summary}\n\nRészvétel: ${e.d.url}`)}`,
      `URL:${e.page}`,
      `CATEGORIES:${icsEsc(CAT[e.d.category] || e.d.category)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ───────────────────────────────────────────────────────── sitemap ──

function sitemap() {
  const day = GEN.slice(0, 10);
  const cats = Object.keys(DATA.categories || {}).map((k) => `${SITE}/kategoria/${k}/`);
  const urls = [`${SITE}/`, ...cats, ...discussions.map((d) => `${SITE}/tema/${d.id}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${day}</lastmod></url>`).join("\n")}
</urlset>
`;
}

// ───────────────────────────────────────────────────────────── main ──

await rm(path.join(PUB, "tema"), { recursive: true, force: true });
for (const d of discussions) {
  if (!/^[a-z0-9-]+$/.test(d.id)) throw new Error(`Váratlan téma-azonosító: ${d.id}`);
  const dir = path.join(PUB, "tema", d.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), topicPage(d));
}
await writeFile(path.join(PUB, "feed.xml"), atom());
await writeFile(path.join(PUB, "naptar.ics"), ics());
await writeFile(path.join(PUB, "sitemap.xml"), sitemap());

const dated = events.filter((e) => e.local).length;
console.log(
  `✓ ${discussions.length} témaoldal · feed.xml (${events.filter((e) => e.when && e.when <= GEN).length} bejegyzés) · ` +
    `naptar.ics (${dated} esemény) · sitemap.xml — ${SITE}`,
);
