# Közhang témaajánló

A [kozhang.hu](https://kozhang.hu) nyilvános egyeztéseinek **statisztika-alapú témaajánlója** –
nem hivatalos, a Közhang nem készítette.

**Élő oldal:** https://madcsaba.github.io/kozhang_ajanlo/

## Mit csinál

- **Napi adatfrissítés** a kozhang.hu nyilvános adataiból (egyeztetések, fejezetek, kérdések,
  Tudástér-cikkek, taxonómia, videó-beszélők).
- **Valós határidők és státuszok**: a lejárt témák `closed` státuszúak, a hátralévő napok
  futásidőben, a `closesAt`/`resultsAt` dátumokból számítva – nem a buildbe égetett számokból.
- **Keresés és szűrés** a főoldalon: kategória, megye, rendezés, szabad szöveges keresés
  (a szűkített nézet megosztható `?q=…` URL-lel).
- **Naptár** (`naptar.ics`) a témanyitásokról, lezárásokról, eredményekről és
  fejezetnyitásokról; **hírcsatorna** (`feed.xml`) Atom formában.
- **Témaoldalak** (`tema/<id>/`) OpenGraph-kártyával, megoszthatóan.

## Miért van rá szükség

A kozhang.hu egy Vite+React SPA: nincs nyilvános tartalom-API, nincs sitemap, az adatok a
JavaScript bundle-ökbe vannak égetve, és a böngészőoldali lekérést a CORS tiltja. Ezért az
adatot szerveroldalon nyerjük ki a bundle-ökből, és saját JSON-csomagot gyártunk belőle.

## Fájlok

| Fájl | Szerep |
|---|---|
| `extract.mjs` | adatnyerés a bundle-ökből → `public/data/recommendations.json` |
| `check.mjs` | adatcsomag-ellenőrzés (a CI kapuja) |
| `build.mjs` | kategória-aloldalak + kiemelt felhívás + `sitemap.xml`/`robots.txt` |
| `build-pages.mjs` | témaoldalak, hírcsatorna, naptár, `sitemap.xml` |
| `data/` | a verziókevelt tartalom és a kép-adatok |
| `public/` | a generált oldalak |

## Működtetés

```bash
npm run check    # kinyerés + ellenőrzés + próbaépítés
npm run serve    # építés és helyi előnézet a 8787-es porton
```

A `data/` mappa verziókevelt; a napi frissítést a `.github/workflows/refresh.yml` végzi,
a közzétételt a `deploy-pages.yml`.

## Jogszabályi megjegyzés

A tartalom és a témaadatok a **Közhang Nonprofit Kft.** tulajdona. Ez az oldal csak
nyilvánosan elérhető adatokat rendez újra, és minden kártya a forráshoz visz. Nem hivatalos
oldal – a válaszadás mindig a kozhang.hu-n történik.
