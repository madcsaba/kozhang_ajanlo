# kozhang-ajanlo

Statisztika-alapú témaajánló a **kozhang.hu** egyeztetéseihez — nem hivatalos, a Közhang nem készítette.

Egyetlen statikus oldal, ami saját JSON-adatcsomagból dolgozik: rendez, szűr, keres, és minden
kártya a kozhang.hu megfelelő oldalára visz.

## Miért van rá szükség

A kozhang.hu egy Vite+React SPA, és:

- nincs nyilvános tartalom-API (`ane.kozhang.app/api/v4.0/Content` → 401)
- nincs `robots.txt`-szerű tartalomtérkép, sitemap vagy RSS
- a tartalom a JavaScript bundle-ökbe van égetve
- a böngészőoldali lekérést a **CORS tiltja** (`kozhang.hu/assets/*.js` → `TypeError`)
- a résztvevő- és szavazatszámok is a bundle-ban vannak, build-időben rögzítve

Ezért az adatot **szerveroldalon** nyerjük ki a bundle-ökből, és saját JSON-t gyártunk belőle.

## Használat

```bash
node extract.mjs          # adatcsomag → public/data/recommendations.json
node build.mjs            # kategória-aloldalak + sitemap/robots → public/
node build-pages.mjs      # témaoldalak, hírcsatorna, naptár, sitemap → public/
npm run check             # kinyerés + adatcsomag-ellenőrzés + próbaépítés
npm run serve             # építés, majd http://localhost:8787
npm start                 # kinyerés, építés, majd szerver
```

Nincs függőség, csak Node 18+ (beépített `fetch`).

## Amit kinyer

| Adat | Mennyiség | Honnan |
|---|---|---|
| Egyeztetések | 12 (1 nyitott, 8 hamarosan, 3 lezárt) | `Lo=[{id:…}]` tömb |
| Fejezetek + kérdések | a nyitott/lejárt témáknál fejezetenként | `chapters:[{steps:…}]` a részletes objektumokban |
| Tudástér-cikkek | 19 | `JSON.parse(\`…\`)` blokk |
| Téma-taxonómia | 12 fő téma × 10 altéma = 120 | `"education-1":"…"` párok |
| Videó-beszélők | 8 | `contentByDiscussion` cinema blokkok |
| Képek | 28 | `.jpg` → `.webp` átalakítással ellenőrizve |

### Státusz és határidők – futásidőben

A kozhang.hu a státuszt és a hátralévő napokat **futásidőben** számítja, nem a
buildbe égetett számokból. Az extractor ugyanezt teszi:

- `closesAt` a lezárás, `resultsAt` az eredmények megjelenésének ideje — mindkettő
  a bundle-ben megvan, és az adatcsomagba is bekerül;
- a lejárt (`closesAt` < most) téma státusza `closed`, a még nem nyílt (`opensAt`
  a jövőben) `soon`, egyébként `open`;
- a `daysLeft` a `closesAt` és a most közötti különbség — nem a bundle számai.

A `daysLeft` a buildbe égetett érték **napok alatt elavul**, ezért a főoldal a
`closesAt`-ből újraszámolja a hátralévő napokat (lejárt témánál az
`resultsAt`-ig számol, ahogy a kozhang.hu is).

A dátumok a kozhang.hu saját, helyi (Budapest) időzónájú formátumában érkeznek
(`"2026-11-08T23:59:00"`), ezért helyi időként értelmezzük őket.

### A MEMI-téma különleges esete

Két okból tér el a többitől, és mindkettőre külön kezelés kell:

- az azonosítója egy kiemelt változó (`id:b`, ahol `b=`memi-tarsadalmi-reszvetel``);
- a lépései egy `.map()` hívásból jönnek (`steps:bt.map(...)`), ahol a `bt`
  `[id,hu,en]` sorokból álló tömb.

Ezek nélkül a téma 0 fejezettel és 0 lépéssel érkezne.

## Az ajánlási pontszám

```
score = 0.20·népszerűség + 0.24·frissesség + 0.14·sürgősség
      + 0.14·a te érdeklődésed + 0.10·a te megyéd + 0.06·kevés hang
      + 0.06·korábban megnézted + 0.06·tartalmi mélység
```

- **népszerűség** — `log10(résztvevők+1) / log10(40000)`, hogy a 32 457 és a 0 közötti
  nagy különbség ne nyomja el a többit
- **frissesség** — nyitott téma + hátralévő napok; a rövid határidő sürget
- **sürgősség** — kevés hátralévő nap → magasabb
- **a te érdeklődésed** — a „Mi érdekel?” részben bejelölt kategóriák egyezése az egyeztetés
  kategóriájával
- **a te megyéd** — helyi egyeztetés a választott megyében (a kiválasztott megyében
  megjelenő téma listája a nyitó blokkban is látszik)
- **kevés hang** — nyitott téma kevesebb mint 1000 résztvevővel; ellensúlyozza a népszerűséget,
  hogy a helyi témák ne essenek ki
- **korábban megnézted** — a böngésződ `localStorage`-jába tárolt kattintásaid
- **tartalmi mélység** — kérdések és háttércikkek száma

A kategóriák, a megye és a kattintások csak a böngészőben tárolódnak, nem hagyják el a gépet.
Minden ajánlásnál a **„Miért ajánljuk?”** sor a 3 legerősebb okot mutatja; a sorra mutatva látszik
a teljes pontszám-bontás. Az ajánló azt segít eldönteni, *miről* érdemes véleményt mondanod –
soha nem azt, hogy *mit*: a pontszámba nem számít bele, hogy egy téma melyik álláspont felé hajlik.

A **nap ajánlása** mindig a legmagasabb pontszámú téma; a mellette lévő két hely a top 6-ból
dátumhoz kötött (de determinisztikus) véletlenszerű forgás, így napközben stabil, de minden nap más.

## Aloldalak, hírcsatorna, naptár

Két generátor készít oldalakat az adatcsomagból:

**`build.mjs`** — a 7 kategória ajánló aloldala (`kategoria/<kulcs>/`), a `content/kiemelt.json`
szerinti kiemelt felhívás, valamint `sitemap.xml` és `robots.txt`.

**`build-pages.mjs`** — további megosztható kimenetek:

| Kimenet | Tartalom |
|---|---|
| `tema/<id>/` | témánként saját oldal OpenGraph-kártyával (Facebookon, Messengeren előnézettel osztható), fejezetekkel, lépésekkel, Tudástér-anyagokkal és kapcsolódó témákkal |
| `feed.xml` | Atom-hírcsatorna: új témák (`firstSeen`), fejezetnyitások, lezárások és eredmények |
| `naptar.ics` | feliratkozható naptár: témanyitások (`opensAt`), lezárások (`closesAt`), eredmények (`resultsAt`) és fejezetnyitások (`unlocksAt`), Europe/Budapest időzónában |
| `sitemap.xml` | a főoldal, a 7 kategória-aloldal és a témaoldalak – a `build-pages.mjs` írja felülre, ezért mindig az ő teljes sitemapje érvényes |

A kimenetet nem verziókezeljük: a `deploy-pages.yml` minden kiadás előtt mindkettőt legenerálja.
Az abszolút URL-ek a Pages címéből jönnek (`SITE_URL`). A naptárba csak valódi időpont kerül; a
`daysLeft` a bundle-ba égetett szám, abból határidőt nem számolunk.

A főoldal szűrői az URL-ben is megjelennek (`?hely=local&rend=score&q=tó`),
így egy szűrt nézet is megosztható.

## Frissítés

A `refresh.yml` a `GITHUB_TOKEN`-nel commitol, ami nem indít push-eseményt, ezért a
`deploy-pages.yml` a frissítő sikeres lefutása után (`workflow_run`) is élesít — így a napi
adatfrissítés után az oldal is frissül.

Az adat a kozhang.hu build-jéhez kötött (`version.json`), ezért az `extract.mjs` minden futásnál
újraolvassa a bundle-öket, és a `sourceBuild` mezőben jelzi, melyik buildből származik. Ha a
kozhang.hu frissül, egy újrafuttatás frissíti az adatcsomagot.

A `sourceBuild` jelenleg a fő bundle hash-e (`index-XXXXXXXX.js`), mert a Cloudflare a
`/version.json` mögé kihívást tesz.

## Jogszabályi megjegyzés

A tartalom és a témaadatok a **Közhang Nonprofit Kft.** (1089 Budapest, Visi Imre u. 12.,
`info@kozhang.hu`) tulajdona. A `robots.txt` hiánya nem jelent engedélyt. Ez az oldal csak
nyilvánosan elérhető adatokat rendez újra, és minden kártya a forráshoz visz. Ha a Közhang
kérte a eltávolítását, tedd meg — és érdemes előbb egyeztetni: `info@kozhang.hu`.

## Fájlok

```
extract.mjs              adatnyerés a bundle-ökből
build.mjs                kategória-aloldalak + kiemelt felhívás + sitemap.xml/robots.txt
build-pages.mjs          témaoldalak, feed.xml, naptar.ics, sitemap.xml
public/index.html        a főoldal (inline JS)
public/assets/site.css   a megosztott stílus (főoldal + az aloldalak)
public/data/recommendations.json   generált adatcsomag
```
