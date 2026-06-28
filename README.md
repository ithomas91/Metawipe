# metawipe

Privacy eszköz: GPS, kamera/eszköz adatok, IPTC, XMP és ICC metaadatok
eltávolítása JPEG/PNG képekből.

Két, tudatosan elválasztott rész:

- **`frontend/`** — kliens-oldali tisztító. Minden feldolgozás a böngészőben
  fut (canvas re-encode + a `piexifjs`/saját PNG-chunk logika a szelektív
  megtartáshoz). A fájl soha nem hagyja el az eszközt ezen az úton.
- **`backend/`** — Flask REST API ugyanahhoz a logikához, Python oldalon
  (Pillow + piexif). Ez egy *külön, explicit* bizalmi döntés: aki ezt hívja,
  tudatosan elfogadja, hogy a fájl felmegy egy szerverre (memóriában
  fut, nincs lemezre írás, nincs logolás). A böngésző-felület "API" füle
  ezt dokumentálja, kód-példákkal (curl / Python / JavaScript / PHP).

## Indítás

```bash
cd backend
pip install -r requirements.txt
python app.py
```

A szerver `http://localhost:5000`-en indul, és **egyszerre szolgálja ki**
a frontendet (`frontend/index.html`-től) és a REST API-t (`/api/v1/...`),
ugyanazon az origin-en — így az "API" fülön a kód-példák base URL-je is
automatikusan a futó instance címére áll be.

A `frontend/` mappa önmagában, backend nélkül is megnyitható (pl. egy
statikus host-on) — ekkor csak a Tisztító fül funkcionál, az API
dokumentáció URL-jei a saját origin-t fogják mutatni, üresen, amíg nincs
hova hívni őket.

## Funkciók, amiket a hasonló (kép-only, all-or-nothing) eszközök
többnyire kihagynak

- **Szelektív megtartás**: nem csak "törölj mindent" — a Copyright és/vagy
  Artist mező megtartható, miközben GPS/eszköz/szoftver adat törlődik.
- **"Mit találtunk" előnézet** törlés előtt, mezőnként (GPS térkép-linkkel,
  IPTC creator/copyright/caption, beágyazott thumbnail jelzése — ez utóbbi
  azért fontos, mert sok eszköz a fő EXIF-et törli, de a kép belsejébe
  ágyazott előnézeti kép régi EXIF-jét otthagyja).
- **Batch mód + ZIP letöltés**, kliens oldalon is.
- **Fejlesztői REST API**, ugyanazzal a logikával, élő, futtatható kód-
  példákkal a böngészőben.

## Roadmap (nincs benne ebben az MVP-ben)

- Videó (MP4/MOV — QuickTime GPS atom), audio (ID3/Vorbis comment),
  PDF és Office dokumentum (DOCX/XLSX/PPTX) támogatás.
- HEIC/HEIF, WebP, RAW formátumok.
- Böngésző-extension csomagolás ("jobb klikk → tisztítás" feltöltés előtt).

## Egy tudatos döntés a C2PA / AI-eredet jelölésről

Ez az eszköz a **személyes adatokat** (GPS, eszköznév, szoftver, IPTC)
távolítja el — ez nem törli, és nem áll szándékában törölni, a C2PA
Content Credentials / AI-eredet jelölést. Ez utóbbi más kategória:
annak eltávolítása megtévesztésre használható (AI-tartalom emberi
alkotásként feltüntetése), ezért ez tudatosan nincs a feature-listán.
