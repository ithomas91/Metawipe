/* metawipe — client-side metadata reader
 *
 * Everything here runs in the browser. No network request, no upload.
 * Mirrors the logic in backend/app.py so the local tool and the REST API
 * report the same fields for the same file.
 */
window.MetaWipe = window.MetaWipe || {};

(function (NS) {
  'use strict';

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  function detectFormat(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'PNG';
    return null;
  }

  function dmsToDecimal(dms, ref) {
    try {
      const deg = dms[0][0] / dms[0][1];
      const min = dms[1][0] / dms[1][1];
      const sec = dms[2][0] / dms[2][1];
      let dec = deg + min / 60 + sec / 3600;
      if (ref === 'S' || ref === 'W') dec = -dec;
      return Math.round(dec * 1e6) / 1e6;
    } catch (e) {
      return null;
    }
  }

  // --- minimal IPTC-IIM parser (legacy newsroom fields in the APP13/Photoshop segment) ---
  const IPTC_FIELDS = { 80: 'creator', 116: 'copyright_notice', 120: 'caption', 101: 'country', 25: 'keywords' };

  function parseIptcIim(bytes, start, end) {
    const fields = {};
    let i = start;
    while (i < end - 5) {
      if (bytes[i] === 0x1c) {
        const record = bytes[i + 1];
        const dataset = bytes[i + 2];
        const length = (bytes[i + 3] << 8) | bytes[i + 4];
        const dataStart = i + 5;
        if (dataStart + length > end) break;
        if (record === 2 && IPTC_FIELDS[dataset]) {
          const text = new TextDecoder('utf-8').decode(bytes.slice(dataStart, dataStart + length));
          if (dataset === 25) {
            fields.keywords = fields.keywords || [];
            fields.keywords.push(text);
          } else {
            fields[IPTC_FIELDS[dataset]] = text;
          }
        }
        i = dataStart + length;
      } else {
        i += 1;
      }
    }
    return fields;
  }

  function findIptcInJpeg(bytes) {
    let i = 2; // skip SOI
    while (i < bytes.length - 4) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda) break; // start of scan — no more header segments follow
      const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker === 0xed) { // APP13
        const segStart = i + 4;
        const segEnd = i + 2 + segLen;
        const sig = new TextDecoder('latin1').decode(bytes.slice(segStart, segStart + 13));
        if (sig.startsWith('Photoshop 3.0')) {
          let p = segStart + 14;
          while (p < segEnd - 8) {
            const tag = new TextDecoder('latin1').decode(bytes.slice(p, p + 4));
            if (tag !== '8BIM') break;
            const resourceId = (bytes[p + 4] << 8) | bytes[p + 5];
            const nameLen = bytes[p + 6];
            const nameSize = nameLen % 2 === 0 ? nameLen + 2 : nameLen + 1;
            const q = p + 7 + nameSize - 1;
            const dataSize = (bytes[q] << 24) | (bytes[q + 1] << 16) | (bytes[q + 2] << 8) | bytes[q + 3];
            const dataStart = q + 4;
            if (resourceId === 0x0404) return parseIptcIim(bytes, dataStart, dataStart + dataSize);
            const padded = dataSize % 2 === 0 ? dataSize : dataSize + 1;
            p = dataStart + padded;
          }
        }
        i = segEnd;
        continue;
      }
      i += 2 + segLen;
    }
    return {};
  }

  function hasXmpSignature(bytes) {
    const slice = bytes.slice(0, Math.min(bytes.length, 200000));
    return new TextDecoder('latin1').decode(slice).indexOf('ns.adobe.com/xap') !== -1;
  }

  function hasIccSignature(bytes) {
    const slice = bytes.slice(0, Math.min(bytes.length, 65536));
    return new TextDecoder('latin1').decode(slice).indexOf('ICC_PROFILE') !== -1;
  }

  async function inspectJpeg(file, bytes) {
    const report = {
      format: 'JPEG', camera: {}, gps: {}, has_gps: false, has_thumbnail: false,
      has_icc_profile: hasIccSignature(bytes), has_xmp: hasXmpSignature(bytes),
      iptc: {}, has_iptc: false,
    };

    try {
      const dataUrl = await readAsDataURL(file);
      const exif = piexif.load(dataUrl);
      const zeroth = exif['0th'] || {};
      const exifIfd = exif['Exif'] || {};
      const gpsIfd = exif['GPS'] || {};
      const firstIfd = exif['1st'] || {};

      const dec = (v) => (typeof v === 'string' ? v.replace(/\u0000+$/, '').trim() : v);
      if (piexif.ImageIFD.Make in zeroth) report.camera.make = dec(zeroth[piexif.ImageIFD.Make]);
      if (piexif.ImageIFD.Model in zeroth) report.camera.model = dec(zeroth[piexif.ImageIFD.Model]);
      if (piexif.ImageIFD.Software in zeroth) report.camera.software = dec(zeroth[piexif.ImageIFD.Software]);
      if (piexif.ImageIFD.Artist in zeroth) report.camera.artist = dec(zeroth[piexif.ImageIFD.Artist]);
      if (piexif.ImageIFD.Copyright in zeroth) report.camera.copyright = dec(zeroth[piexif.ImageIFD.Copyright]);
      if (piexif.ImageIFD.DateTime in zeroth) report.camera.modified_date = dec(zeroth[piexif.ImageIFD.DateTime]);
      if (piexif.ExifIFD.DateTimeOriginal in exifIfd) report.camera.date_taken = dec(exifIfd[piexif.ExifIFD.DateTimeOriginal]);
      if (piexif.ExifIFD.LensModel in exifIfd) report.camera.lens = dec(exifIfd[piexif.ExifIFD.LensModel]);

      const lat = gpsIfd[piexif.GPSIFD.GPSLatitude];
      const latRef = gpsIfd[piexif.GPSIFD.GPSLatitudeRef];
      const lon = gpsIfd[piexif.GPSIFD.GPSLongitude];
      const lonRef = gpsIfd[piexif.GPSIFD.GPSLongitudeRef];
      if (lat && lon && latRef && lonRef) {
        const latDec = dmsToDecimal(lat, latRef);
        const lonDec = dmsToDecimal(lon, lonRef);
        if (latDec !== null && lonDec !== null) {
          report.gps = { lat: latDec, lon: lonDec, maps_url: `https://www.google.com/maps?q=${latDec},${lonDec}` };
          report.has_gps = true;
        }
      }
      report.has_thumbnail = Object.keys(firstIfd).length > 0;
    } catch (e) {
      // No Exif segment at all — that's a legitimately clean file, not an error.
    }

    try {
      report.iptc = findIptcInJpeg(bytes);
      report.has_iptc = Object.keys(report.iptc).length > 0;
    } catch (e) {
      report.iptc = {};
    }

    return report;
  }

  function readPngChunks(bytes) {
    const chunks = [];
    let i = 8; // skip the 8-byte PNG signature
    while (i < bytes.length - 8) {
      const length = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
      const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      const dataStart = i + 8;
      chunks.push({ type, start: dataStart, length });
      i = dataStart + length + 4;
      if (type === 'IEND') break;
    }
    return chunks;
  }

  function inspectPng(bytes) {
    const report = {
      format: 'PNG', text_chunks: {}, has_icc_profile: false,
      has_xmp: false, has_exif_chunk: false, has_iptc: false,
    };
    for (const c of readPngChunks(bytes)) {
      if (c.type === 'iCCP') report.has_icc_profile = true;
      if (c.type === 'eXIf') report.has_exif_chunk = true;
      if (c.type === 'tEXt') {
        const raw = bytes.slice(c.start, c.start + c.length);
        const nul = raw.indexOf(0);
        if (nul !== -1) {
          const key = new TextDecoder('latin1').decode(raw.slice(0, nul));
          report.text_chunks[key] = new TextDecoder('latin1').decode(raw.slice(nul + 1));
        }
      }
      if (c.type === 'iTXt') {
        const raw = bytes.slice(c.start, c.start + c.length);
        const nul = raw.indexOf(0);
        if (nul !== -1) {
          const key = new TextDecoder('latin1').decode(raw.slice(0, nul));
          if (key.toLowerCase().indexOf('xmp') !== -1) report.has_xmp = true;
          if (!(key in report.text_chunks)) report.text_chunks[key] = '(iTXt mező — érték az API /inspect híváson keresztül kérhető le)';
        }
      }
    }
    return report;
  }

  async function inspect(file) {
    const buf = await readAsArrayBuffer(file);
    const bytes = new Uint8Array(buf);
    const fmt = detectFormat(bytes);
    if (fmt === 'JPEG') return await inspectJpeg(file, bytes);
    if (fmt === 'PNG') return inspectPng(bytes);
    return null;
  }

  NS.detectFormat = detectFormat;
  NS.readAsDataURL = readAsDataURL;
  NS.readAsArrayBuffer = readAsArrayBuffer;
  NS.inspect = inspect;
})(window.MetaWipe);
