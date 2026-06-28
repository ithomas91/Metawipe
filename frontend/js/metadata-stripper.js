/* metawipe — client-side metadata stripper
 *
 * Default path: redraw onto a <canvas> and re-encode. A canvas only ever
 * knows about pixels, so the re-encoded file carries no EXIF/IPTC/XMP/ICC
 * by construction — no library needed for the "strip everything" case.
 *
 * Selective retention (keep just Copyright / Artist) is the one thing
 * most competing tools don't offer: full strip or nothing. To support it
 * we re-insert a minimal metadata block containing only the field the
 * person chose to keep.
 */
window.MetaWipe = window.MetaWipe || {};

(function (NS) {
  'use strict';

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  function canvasRedraw(img, mime, quality) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.toBlob((blob) => resolve(blob), mime, quality);
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataUrl, mime) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // --- bit-by-bit CRC32, needed to hand-write a valid PNG tEXt chunk ---
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function addPngTextChunk(uint8arr, keyword, text) {
    const enc = new TextEncoder();
    const keyBytes = enc.encode(keyword);
    const textBytes = enc.encode(text);
    const data = new Uint8Array(keyBytes.length + 1 + textBytes.length);
    data.set(keyBytes, 0);
    data[keyBytes.length] = 0;
    data.set(textBytes, keyBytes.length + 1);

    const typeBytes = enc.encode('tEXt');
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, data.length, false);

    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, typeBytes.length);
    const crcBytes = new Uint8Array(4);
    new DataView(crcBytes.buffer).setUint32(0, crc32(crcInput), false);

    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    chunk.set(lenBytes, 0);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    chunk.set(crcBytes, 8 + data.length);

    const insertPos = 33; // 8-byte signature + IHDR (4 len + 4 type + 13 data + 4 crc), IHDR is always first/fixed-size
    const result = new Uint8Array(uint8arr.length + chunk.length);
    result.set(uint8arr.subarray(0, insertPos), 0);
    result.set(chunk, insertPos);
    result.set(uint8arr.subarray(insertPos), insertPos + chunk.length);
    return result;
  }

  async function stripJpeg(file, found, opts) {
    const img = await loadImageElement(file);
    const cleanBlob = await canvasRedraw(img, 'image/jpeg', 0.92);

    const wantsCopyright = opts.keepCopyright && found.camera && found.camera.copyright;
    const wantsArtist = opts.keepArtist && found.camera && found.camera.artist;
    if (!wantsCopyright && !wantsArtist) return cleanBlob;

    const zeroth = {};
    if (wantsCopyright) zeroth[piexif.ImageIFD.Copyright] = found.camera.copyright;
    if (wantsArtist) zeroth[piexif.ImageIFD.Artist] = found.camera.artist;
    const exifBytes = piexif.dump({ '0th': zeroth, Exif: {}, GPS: {}, '1st': {}, Interop: {} });

    const dataUrl = await blobToDataURL(cleanBlob);
    const withExif = piexif.insert(exifBytes, dataUrl);
    return dataURLToBlob(withExif, 'image/jpeg');
  }

  async function stripPng(file, found, opts) {
    const img = await loadImageElement(file);
    const cleanBlob = await canvasRedraw(img, 'image/png', 1);

    const tc = found.text_chunks || {};
    const wantsCopyright = opts.keepCopyright && (tc.Copyright || tc.copyright);
    const wantsArtist = opts.keepArtist && (tc.Author || tc.Artist);
    if (!wantsCopyright && !wantsArtist) return cleanBlob;

    let bytes = new Uint8Array(await cleanBlob.arrayBuffer());
    if (wantsCopyright) bytes = addPngTextChunk(bytes, 'Copyright', tc.Copyright || tc.copyright);
    if (wantsArtist) bytes = addPngTextChunk(bytes, 'Author', tc.Author || tc.Artist);
    return new Blob([bytes], { type: 'image/png' });
  }

  async function strip(file, found, opts) {
    const fmt = found && found.format;
    if (fmt === 'JPEG') return stripJpeg(file, found, opts);
    if (fmt === 'PNG') return stripPng(file, found, opts);
    throw new Error('Nem támogatott formátum.');
  }

  NS.strip = strip;
})(window.MetaWipe);
