"""
MetaWipe REST API
------------------
A small, self-contained API for inspecting and stripping metadata
(EXIF / GPS / IPTC / XMP / ICC / embedded thumbnail) from JPEG and PNG
images.

Design notes (read this before extending):
- This API is the OPT-IN, developer/automation path. The browser tool at
  "/" does all of its default work client-side in JavaScript — files
  dropped there never touch this server. Calling this API is a separate,
  explicit trust decision a developer makes for their own integration
  (batch jobs, CI pipelines, server-side automation, etc).
- Nothing uploaded here is written to disk or logged. Everything happens
  in memory for the duration of the request and is discarded after the
  response is sent.
- Default behaviour is "strip everything". Selective retention
  (keep_copyright / keep_artist) is opt-in per request — most competing
  tools only offer all-or-nothing stripping.
"""

import io
import os
import zipfile
from typing import Optional

import piexif
from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS
from PIL import Image
from PIL.PngImagePlugin import PngInfo

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app, resources={r"/api/*": {"origins": "*"}})
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024  # 30 MB per request

SUPPORTED_TYPES = {"image/jpeg", "image/jpg", "image/png"}

API_VERSION = "1.0.0"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _decode(value):
    """piexif returns ASCII tag values as raw bytes — decode + trim."""
    if isinstance(value, bytes):
        return value.decode(errors="replace").rstrip("\x00").strip()
    return value


def _dms_to_decimal(dms, ref) -> Optional[float]:
    try:
        degrees = dms[0][0] / dms[0][1]
        minutes = dms[1][0] / dms[1][1]
        seconds = dms[2][0] / dms[2][1]
        decimal = degrees + minutes / 60 + seconds / 3600
        ref = ref.decode() if isinstance(ref, bytes) else ref
        if ref in ("S", "W"):
            decimal = -decimal
        return round(decimal, 6)
    except Exception:
        return None


# Common IPTC IIM (legacy "newsroom") dataset numbers we surface in reports.
_IPTC_FIELD_NAMES = {
    80: "creator",
    116: "copyright_notice",
    120: "caption",
    101: "country",
    25: "keywords",
}


def _parse_iptc_iim(data: bytes) -> dict:
    """Minimal parser for the legacy IPTC-IIM block embedded in JPEG APP13
    (Photoshop) segments. Good enough to surface the handful of fields
    that matter for attribution (creator, copyright, caption)."""
    fields: dict = {}
    i = 0
    n = len(data)
    while i < n - 5:
        if data[i] == 0x1C:
            record = data[i + 1]
            dataset = data[i + 2]
            length = (data[i + 3] << 8) | data[i + 4]
            start = i + 5
            if start + length > n:
                break
            value = data[start:start + length]
            if record == 2 and dataset in _IPTC_FIELD_NAMES:
                try:
                    text = value.decode("utf-8", errors="replace")
                except Exception:
                    text = None
                name = _IPTC_FIELD_NAMES[dataset]
                if dataset == 25:
                    fields.setdefault("keywords", []).append(text)
                else:
                    fields[name] = text
            i = start + length
        else:
            i += 1
    return fields


def _sniff_format(raw: bytes, content_type: str) -> Optional[str]:
    if raw[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if "png" in (content_type or ""):
        return "PNG"
    if "jpeg" in (content_type or "") or "jpg" in (content_type or ""):
        return "JPEG"
    return None


# ---------------------------------------------------------------------------
# Inspection
# ---------------------------------------------------------------------------

def inspect_jpeg(raw: bytes) -> dict:
    img = Image.open(io.BytesIO(raw))
    img.load()

    report: dict = {
        "format": "JPEG",
        "width": img.width,
        "height": img.height,
        "has_icc_profile": "icc_profile" in img.info,
    }

    camera: dict = {}
    gps: dict = {}
    has_thumbnail = False

    try:
        exif_dict = piexif.load(raw)
        zeroth = exif_dict.get("0th", {})
        exif_ifd = exif_dict.get("Exif", {})
        gps_ifd = exif_dict.get("GPS", {})
        thumb = exif_dict.get("thumbnail")
        has_thumbnail = bool(thumb)

        tag_map = [
            (piexif.ImageIFD.Make, zeroth, "make"),
            (piexif.ImageIFD.Model, zeroth, "model"),
            (piexif.ImageIFD.Software, zeroth, "software"),
            (piexif.ImageIFD.Artist, zeroth, "artist"),
            (piexif.ImageIFD.Copyright, zeroth, "copyright"),
            (piexif.ImageIFD.DateTime, zeroth, "modified_date"),
            (piexif.ExifIFD.DateTimeOriginal, exif_ifd, "date_taken"),
            (piexif.ExifIFD.LensModel, exif_ifd, "lens"),
        ]
        for tag, ifd, key in tag_map:
            if tag in ifd:
                camera[key] = _decode(ifd[tag])

        lat = gps_ifd.get(piexif.GPSIFD.GPSLatitude)
        lat_ref = gps_ifd.get(piexif.GPSIFD.GPSLatitudeRef)
        lon = gps_ifd.get(piexif.GPSIFD.GPSLongitude)
        lon_ref = gps_ifd.get(piexif.GPSIFD.GPSLongitudeRef)
        if lat and lon and lat_ref and lon_ref:
            lat_dec = _dms_to_decimal(lat, lat_ref)
            lon_dec = _dms_to_decimal(lon, lon_ref)
            if lat_dec is not None and lon_dec is not None:
                gps = {
                    "lat": lat_dec,
                    "lon": lon_dec,
                    "maps_url": f"https://www.google.com/maps?q={lat_dec},{lon_dec}",
                }
    except Exception:
        pass

    report["camera"] = camera
    report["gps"] = gps
    report["has_gps"] = bool(gps)
    report["has_thumbnail"] = has_thumbnail
    report["has_xmp"] = b"ns.adobe.com/xap" in raw[:200000]

    iptc = {}
    try:
        photoshop = img.info.get("photoshop")
        if photoshop and 1028 in photoshop:
            iptc = _parse_iptc_iim(photoshop[1028])
    except Exception:
        pass
    report["iptc"] = iptc
    report["has_iptc"] = bool(iptc)

    return report


def inspect_png(raw: bytes) -> dict:
    img = Image.open(io.BytesIO(raw))
    img.load()

    text_chunks = dict(img.text) if hasattr(img, "text") else {}
    has_xmp = any("xmp" in k.lower() for k in text_chunks.keys())

    exif_data = {}
    has_exif = False
    try:
        exif = img.getexif()
        if exif and len(exif) > 0:
            has_exif = True
            from PIL.ExifTags import TAGS
            exif_data = {TAGS.get(k, str(k)): str(v) for k, v in exif.items()}
    except Exception:
        pass

    return {
        "format": "PNG",
        "width": img.width,
        "height": img.height,
        "has_icc_profile": "icc_profile" in img.info,
        "has_exif_chunk": has_exif,
        "exif": exif_data,
        "text_chunks": text_chunks,
        "has_xmp": has_xmp,
        "has_iptc": False,
    }


def inspect_image(raw: bytes, fmt: str) -> dict:
    return inspect_jpeg(raw) if fmt == "JPEG" else inspect_png(raw)


# ---------------------------------------------------------------------------
# Stripping
# ---------------------------------------------------------------------------

def strip_jpeg(raw: bytes, keep_copyright: bool, keep_artist: bool) -> bytes:
    img = Image.open(io.BytesIO(raw))
    img.load()

    exif_bytes = None
    if keep_copyright or keep_artist:
        try:
            original = piexif.load(raw)
            zeroth = original.get("0th", {})
            new_zeroth = {}
            if keep_copyright and piexif.ImageIFD.Copyright in zeroth:
                new_zeroth[piexif.ImageIFD.Copyright] = zeroth[piexif.ImageIFD.Copyright]
            if keep_artist and piexif.ImageIFD.Artist in zeroth:
                new_zeroth[piexif.ImageIFD.Artist] = zeroth[piexif.ImageIFD.Artist]
            if new_zeroth:
                exif_bytes = piexif.dump({
                    "0th": new_zeroth, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None,
                })
        except Exception:
            exif_bytes = None

    out = io.BytesIO()
    save_kwargs = {"format": "JPEG", "quality": 92}
    if exif_bytes:
        save_kwargs["exif"] = exif_bytes
    img.convert("RGB").save(out, **save_kwargs)
    return out.getvalue()


def strip_png(raw: bytes, keep_copyright: bool, keep_artist: bool) -> bytes:
    img = Image.open(io.BytesIO(raw))
    img.load()

    pnginfo = None
    if keep_copyright or keep_artist:
        existing = dict(img.text) if hasattr(img, "text") else {}
        pnginfo = PngInfo()
        wrote_anything = False
        if keep_copyright:
            cr = existing.get("Copyright") or existing.get("copyright")
            if cr:
                pnginfo.add_text("Copyright", cr)
                wrote_anything = True
        if keep_artist:
            ar = existing.get("Author") or existing.get("Artist")
            if ar:
                pnginfo.add_text("Author", ar)
                wrote_anything = True
        if not wrote_anything:
            pnginfo = None

    out = io.BytesIO()
    save_kwargs = {"format": "PNG", "optimize": True}
    if pnginfo:
        save_kwargs["pnginfo"] = pnginfo
    img.save(out, **save_kwargs)
    return out.getvalue()


def strip_image(raw: bytes, fmt: str, keep_copyright: bool, keep_artist: bool) -> bytes:
    if fmt == "JPEG":
        return strip_jpeg(raw, keep_copyright, keep_artist)
    return strip_png(raw, keep_copyright, keep_artist)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/v1/health")
def health():
    return jsonify({"status": "ok", "version": API_VERSION})


@app.post("/api/v1/inspect")
def api_inspect():
    if "file" not in request.files:
        abort(400, description="Missing 'file' field in multipart form data.")
    f = request.files["file"]
    raw = f.read()
    fmt = _sniff_format(raw, f.mimetype)
    if fmt is None:
        abort(415, description="Unsupported file type. Supported: JPEG, PNG.")
    report = inspect_image(raw, fmt)
    report["filename"] = f.filename
    return jsonify(report)


@app.post("/api/v1/strip")
def api_strip():
    if "file" not in request.files:
        abort(400, description="Missing 'file' field in multipart form data.")
    f = request.files["file"]
    raw = f.read()
    fmt = _sniff_format(raw, f.mimetype)
    if fmt is None:
        abort(415, description="Unsupported file type. Supported: JPEG, PNG.")

    keep_copyright = request.form.get("keep_copyright", "false").lower() == "true"
    keep_artist = request.form.get("keep_artist", "false").lower() == "true"

    cleaned = strip_image(raw, fmt, keep_copyright, keep_artist)
    mimetype = "image/jpeg" if fmt == "JPEG" else "image/png"
    ext = "jpg" if fmt == "JPEG" else "png"
    base = (f.filename or "image").rsplit(".", 1)[0]

    return send_file(
        io.BytesIO(cleaned),
        mimetype=mimetype,
        as_attachment=True,
        download_name=f"{base}_clean.{ext}",
    )


@app.post("/api/v1/strip/batch")
def api_strip_batch():
    files = request.files.getlist("files")
    if not files:
        abort(400, description="Missing 'files' field (one or more files) in multipart form data.")

    keep_copyright = request.form.get("keep_copyright", "false").lower() == "true"
    keep_artist = request.form.get("keep_artist", "false").lower() == "true"

    zip_buffer = io.BytesIO()
    used_names: dict = {}
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            raw = f.read()
            fmt = _sniff_format(raw, f.mimetype)
            if fmt is None:
                continue  # skip unsupported files rather than failing the whole batch
            cleaned = strip_image(raw, fmt, keep_copyright, keep_artist)
            ext = "jpg" if fmt == "JPEG" else "png"
            base = (f.filename or "image").rsplit(".", 1)[0]
            name = f"{base}_clean.{ext}"
            if name in used_names:
                used_names[name] += 1
                name = f"{base}_clean_{used_names[name]}.{ext}"
            else:
                used_names[name] = 0
            zf.writestr(name, cleaned)

    zip_buffer.seek(0)
    return send_file(
        zip_buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name="metawipe_clean.zip",
    )


@app.errorhandler(400)
@app.errorhandler(413)
@app.errorhandler(415)
def handle_error(e):
    return jsonify({"error": e.description}), e.code


@app.get("/")
def index():
    return app.send_static_file("index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
