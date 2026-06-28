# Metawipe

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
---

## Részletes API leírás (magyar)

### Alapok

- **Base URL**: ahol a Flask app fut, pl. `http://localhost:5000`. Önálló
  hosztoláskor ez a saját domained lesz.
- **Hitelesítés**: nincs. Ez egy MVP — production előtt érdemes API-key-t
  vagy rate limitet bevezetni, lásd a Roadmap résznél.
- **CORS**: minden `/api/*` végpont `Access-Control-Allow-Origin: *`-tal
  felel — bármely origin-ről hívható böngészőből is.
- **Méretkorlát**: kérésenként **30 MB** (`MAX_CONTENT_LENGTH`). Ha
  túllépi, `413`-at kapsz.
- **Támogatott formátum**: JPEG és PNG. A formátumot a szerver a fájl
  bájtjaiból (magic bytes) ismeri fel, nem a fájlnévből vagy a
  `Content-Type`-ból — tehát egy rosszul elnevezett, de valódi JPEG is
  helyesen lesz felismerve.

### `GET /api/v1/health`

Életjel-ellenőrzés.

**Válasz — `200 OK`**
```json
{ "status": "ok", "version": "1.0.0" }
```

### `POST /api/v1/inspect`

Megmutatja, milyen metaadatot talált a képben — **törlés nélkül**.

**Kérés** — `multipart/form-data`

| Mező | Kötelező | Leírás |
|---|---|---|
| `file` | igen | a kép (JPEG vagy PNG) |

**Válasz — `200 OK`, JPEG esetén**
```json
{
  "filename": "photo.jpg",
  "format": "JPEG",
  "width": 4032,
  "height": 3024,
  "has_icc_profile": true,
  "has_xmp": true,
  "has_thumbnail": true,
  "has_gps": true,
  "gps": {
    "lat": 47.497912,
    "lon": 19.040235,
    "maps_url": "https://www.google.com/maps?q=47.497912,19.040235"
  },
  "camera": {
    "make": "Apple",
    "model": "iPhone 14 Pro",
    "software": "17.4.1",
    "date_taken": "2026:03:12 14:22:01",
    "modified_date": "2026:03:12 14:22:01",
    "lens": "iPhone 14 Pro back triple camera 6.765mm f/1.78",
    "artist": "Teszt Elek",
    "copyright": "(c) 2026 Teszt Elek"
  },
  "has_iptc": false,
  "iptc": {}
}
```
A `camera` és `gps` objektum csak azokat a kulcsokat tartalmazza, amik
tényleg megtalálhatók voltak a fájlban — ha nincs GPS, `"has_gps": false`
és `"gps": {}`.

**Válasz — `200 OK`, PNG esetén**
```json
{
  "filename": "screenshot.png",
  "format": "PNG",
  "width": 1920,
  "height": 1080,
  "has_icc_profile": false,
  "has_exif_chunk": false,
  "exif": {},
  "has_xmp": false,
  "has_iptc": false,
  "text_chunks": {
    "Software": "Adobe Photoshop 25.0",
    "Author": "Jane Doe",
    "Copyright": "(c) 2026 Jane Doe"
  }
}
```
A `text_chunks` a PNG `tEXt`/`iTXt` chunkjait adja vissza kulcs-érték
formában (a kulcs neve attól függ, mit írt bele az eredeti szoftver —
gyakori: `Software`, `Author`, `Copyright`, `Description`,
`XML:com.adobe.xmp`).

### `POST /api/v1/strip`

Egy fájl megtisztítása. **Alapból minden metaadatot töröl.**

**Kérés** — `multipart/form-data`

| Mező | Kötelező | Alapérték | Leírás |
|---|---|---|---|
| `file` | igen | — | a kép |
| `keep_copyright` | nem | `"false"` | `"true"` esetén megtartja a Copyright mezőt, *ha* az eredeti fájlban megvolt |
| `keep_artist` | nem | `"false"` | `"true"` esetén megtartja a Készítő/Artist mezőt, *ha* megvolt |

A `keep_*` mezők string `"true"`/`"false"` értéket várnak, nem JSON
boolean-t (mert multipart form data). Ha a mező hiányzik, az alapérték
`false`.

**Válasz — `200 OK`**
Bináris fájl, `Content-Type: image/jpeg` vagy `image/png`,
`Content-Disposition: attachment; filename="<eredeti_név>_clean.<jpg|png>"`.

Ha a kért mező (pl. copyright) nem is volt benne az eredeti fájlban, a
`keep_copyright=true` egyszerűen nem csinál semmit — nem hibázik.

### `POST /api/v1/strip/batch`

Mint a `/strip`, csak több fájlra egyszerre.

**Kérés** — `multipart/form-data`

| Mező | Kötelező | Leírás |
|---|---|---|
| `files` | igen | egy vagy több fájl, **ugyanazon a mezőnéven** (`files`) feltöltve |
| `keep_copyright` | nem | mint fent, az összes fájlra érvényes |
| `keep_artist` | nem | mint fent, az összes fájlra érvényes |

**Válasz — `200 OK`**
`Content-Type: application/zip`, `metawipe_clean.zip` néven. A nem
támogatott formátumú fájlokat a batch **csendben kihagyja** (nem dobja el
az egész kérést egy rossz fájl miatt). Azonos nevű fájlok a ZIP-ben
`_clean_1.jpg`, `_clean_2.jpg` stb. utótagot kapnak, hogy ne írják felül
egymást.

### Hibák

Minden hiba egységes formában jön: `{"error": "<leírás>"}`.

| Kód | Mikor | Példa body |
|---|---|---|
| `400` | hiányzik a `file` / `files` mező | `{"error": "Missing 'file' field in multipart form data."}` |
| `413` | a kérés mérete > 30 MB | `{"error": "The data value transmitted exceeds the capacity limit."}` |
| `415` | nem JPEG/PNG fájl | `{"error": "Unsupported file type. Supported: JPEG, PNG."}` |

### Gyors curl-példák

```bash
# inspect
curl -X POST http://localhost:5000/api/v1/inspect -F "file=@photo.jpg"

# strip, copyright megtartásával
curl -X POST http://localhost:5000/api/v1/strip \
  -F "file=@photo.jpg" -F "keep_copyright=true" \
  -o photo_clean.jpg

# batch, két fájl
curl -X POST http://localhost:5000/api/v1/strip/batch \
  -F "files=@a.jpg" -F "files=@b.png" \
  -o clean.zip
```
Python / JavaScript / PHP példák a futó app "API" fülén élesben is
kipróbálhatók, automatikusan a saját base URL-leddel kitöltve.

---

## Detailed API Reference (English)

### Basics

- **Base URL**: wherever the Flask app runs, e.g. `http://localhost:5000`.
- **Auth**: none. This is an MVP — add an API key or rate limiting before
  any production use (see Roadmap).
- **CORS**: every `/api/*` route responds with
  `Access-Control-Allow-Origin: *` — callable from any browser origin.
- **Size limit**: **30 MB** per request (`MAX_CONTENT_LENGTH`). Exceeding
  it returns `413`.
- **Supported formats**: JPEG and PNG. Format is detected from the file's
  magic bytes server-side, not from the filename or `Content-Type` header
  — so a real JPEG with a wrong extension is still detected correctly.

### `GET /api/v1/health`

Liveness check.

**Response — `200 OK`**
```json
{ "status": "ok", "version": "1.0.0" }
```

### `POST /api/v1/inspect`

Reports what metadata was found in the image — **without stripping it**.

**Request** — `multipart/form-data`

| Field | Required | Description |
|---|---|---|
| `file` | yes | the image (JPEG or PNG) |

**Response — `200 OK`, for a JPEG**
```json
{
  "filename": "photo.jpg",
  "format": "JPEG",
  "width": 4032,
  "height": 3024,
  "has_icc_profile": true,
  "has_xmp": true,
  "has_thumbnail": true,
  "has_gps": true,
  "gps": {
    "lat": 47.497912,
    "lon": 19.040235,
    "maps_url": "https://www.google.com/maps?q=47.497912,19.040235"
  },
  "camera": {
    "make": "Apple",
    "model": "iPhone 14 Pro",
    "software": "17.4.1",
    "date_taken": "2026:03:12 14:22:01",
    "modified_date": "2026:03:12 14:22:01",
    "lens": "iPhone 14 Pro back triple camera 6.765mm f/1.78",
    "artist": "Teszt Elek",
    "copyright": "(c) 2026 Teszt Elek"
  },
  "has_iptc": false,
  "iptc": {}
}
```
`camera` and `gps` only include keys that were actually present in the
file — if there's no GPS data, you get `"has_gps": false` and `"gps": {}`.

**Response — `200 OK`, for a PNG**
```json
{
  "filename": "screenshot.png",
  "format": "PNG",
  "width": 1920,
  "height": 1080,
  "has_icc_profile": false,
  "has_exif_chunk": false,
  "exif": {},
  "has_xmp": false,
  "has_iptc": false,
  "text_chunks": {
    "Software": "Adobe Photoshop 25.0",
    "Author": "Jane Doe",
    "Copyright": "(c) 2026 Jane Doe"
  }
}
```
`text_chunks` returns the PNG's `tEXt`/`iTXt` chunks as key-value pairs —
the key names depend on what the original software wrote (common ones:
`Software`, `Author`, `Copyright`, `Description`, `XML:com.adobe.xmp`).

### `POST /api/v1/strip`

Cleans a single file. **Strips everything by default.**

**Request** — `multipart/form-data`

| Field | Required | Default | Description |
|---|---|---|---|
| `file` | yes | — | the image |
| `keep_copyright` | no | `"false"` | if `"true"`, keeps the Copyright field, *if* the original had one |
| `keep_artist` | no | `"false"` | if `"true"`, keeps the Artist/Creator field, *if* the original had one |

The `keep_*` fields expect the string `"true"`/`"false"`, not a JSON
boolean (this is multipart form data). A missing field defaults to
`false`.

**Response — `200 OK`**
Binary file, `Content-Type: image/jpeg` or `image/png`,
`Content-Disposition: attachment; filename="<original_name>_clean.<jpg|png>"`.

If the requested field (e.g. copyright) wasn't present in the original
file, `keep_copyright=true` simply has no effect — it doesn't error.

### `POST /api/v1/strip/batch`

Same as `/strip`, for multiple files at once.

**Request** — `multipart/form-data`

| Field | Required | Description |
|---|---|---|
| `files` | yes | one or more files, all under **the same field name** (`files`) |
| `keep_copyright` | no | same as above, applied to every file |
| `keep_artist` | no | same as above, applied to every file |

**Response — `200 OK`**
`Content-Type: application/zip`, named `metawipe_clean.zip`. Unsupported
files inside the batch are **silently skipped** rather than failing the
whole request. Files that share a name get suffixed `_clean_1.jpg`,
`_clean_2.jpg`, etc. inside the zip to avoid collisions.

### Errors

Every error has the same shape: `{"error": "<description>"}`.

| Code | When | Example body |
|---|---|---|
| `400` | missing `file` / `files` field | `{"error": "Missing 'file' field in multipart form data."}` |
| `413` | request size > 30 MB | `{"error": "The data value transmitted exceeds the capacity limit."}` |
| `415` | not a JPEG/PNG | `{"error": "Unsupported file type. Supported: JPEG, PNG."}` |

### Quick curl examples

```bash
# inspect
curl -X POST http://localhost:5000/api/v1/inspect -F "file=@photo.jpg"

# strip, keeping copyright
curl -X POST http://localhost:5000/api/v1/strip \
  -F "file=@photo.jpg" -F "keep_copyright=true" \
  -o photo_clean.jpg

# batch, two files
curl -X POST http://localhost:5000/api/v1/strip/batch \
  -F "files=@a.jpg" -F "files=@b.png" \
  -o clean.zip
```
Python / JavaScript / PHP examples are available live on the running
app's "API" tab, pre-filled with your actual base URL.

