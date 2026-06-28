/* metawipe — app shell */
(function () {
  'use strict';

  const MW = window.MetaWipe;
  let seq = 0;
  const items = new Map(); // id -> { file, found, cleanedBlob, cardEl }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      const target = btn.dataset.tab;
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `${target}-panel`));
    });
  });

  // ---------- helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtCoord(n) {
    return n.toFixed(5);
  }

  function badgesFor(found) {
    const badges = [];
    if (!found) return [{ cls: 'neutral', html: 'Ismeretlen formátum' }];

    if (found.format === 'JPEG') {
      if (found.has_gps) {
        badges.push({ cls: 'flag', html: `GPS &middot; <a href="${found.gps.maps_url}" target="_blank" rel="noopener">${fmtCoord(found.gps.lat)}, ${fmtCoord(found.gps.lon)}</a>` });
      }
      const cam = found.camera || {};
      if (cam.make || cam.model) badges.push({ cls: 'flag', html: `Eszköz &middot; ${escapeHtml([cam.make, cam.model].filter(Boolean).join(' '))}` });
      if (cam.date_taken || cam.modified_date) badges.push({ cls: 'flag', html: `Dátum &middot; ${escapeHtml(cam.date_taken || cam.modified_date)}` });
      if (cam.software) badges.push({ cls: 'flag', html: `Szoftver &middot; ${escapeHtml(cam.software)}` });
      if (cam.lens) badges.push({ cls: 'flag', html: `Objektív &middot; ${escapeHtml(cam.lens)}` });
      if (cam.artist) badges.push({ cls: 'neutral', html: `Készítő &middot; ${escapeHtml(cam.artist)}` });
      if (cam.copyright) badges.push({ cls: 'neutral', html: `Copyright &middot; ${escapeHtml(cam.copyright)}` });
      if (found.has_icc_profile) badges.push({ cls: 'flag', html: 'ICC színprofil' });
      if (found.has_xmp) badges.push({ cls: 'flag', html: 'XMP adat' });
      if (found.has_thumbnail) badges.push({ cls: 'flag', html: 'Beágyazott előnézeti kép' });
      const iptc = found.iptc || {};
      if (iptc.creator) badges.push({ cls: 'neutral', html: `IPTC készítő &middot; ${escapeHtml(iptc.creator)}` });
      if (iptc.copyright_notice) badges.push({ cls: 'neutral', html: `IPTC copyright &middot; ${escapeHtml(iptc.copyright_notice)}` });
      if (iptc.caption) badges.push({ cls: 'flag', html: `IPTC leírás &middot; ${escapeHtml(iptc.caption)}` });
      if (iptc.keywords && iptc.keywords.length) badges.push({ cls: 'flag', html: `IPTC kulcsszavak &middot; ${escapeHtml(iptc.keywords.join(', '))}` });
    } else if (found.format === 'PNG') {
      if (found.has_icc_profile) badges.push({ cls: 'flag', html: 'ICC színprofil' });
      if (found.has_xmp) badges.push({ cls: 'flag', html: 'XMP adat' });
      if (found.has_exif_chunk) badges.push({ cls: 'flag', html: 'EXIF chunk (eXIf)' });
      const tc = found.text_chunks || {};
      Object.keys(tc).forEach((key) => {
        const lower = key.toLowerCase();
        const isAttribution = lower === 'copyright' || lower === 'author' || lower === 'artist';
        badges.push({ cls: isAttribution ? 'neutral' : 'flag', html: `${escapeHtml(key)} &middot; ${escapeHtml(tc[key])}` });
      });
    }

    if (badges.length === 0) badges.push({ cls: 'clean', html: 'Nem találtunk metaadatot — a fájl már tiszta' });
    return badges;
  }

  function hasKeepableCopyright(found) {
    if (!found) return false;
    if (found.format === 'JPEG') return !!(found.camera && found.camera.copyright);
    if (found.format === 'PNG') return !!(found.text_chunks && (found.text_chunks.Copyright || found.text_chunks.copyright));
    return false;
  }
  function hasKeepableArtist(found) {
    if (!found) return false;
    if (found.format === 'JPEG') return !!(found.camera && found.camera.artist);
    if (found.format === 'PNG') return !!(found.text_chunks && (found.text_chunks.Author || found.text_chunks.Artist));
    return false;
  }

  // ---------- queue / cards ----------
  const queueEl = document.getElementById('queue');
  const optionsEl = document.getElementById('globalOptions');
  const stripAllBtn = document.getElementById('stripAllBtn');
  const optKeepCopyright = document.getElementById('optKeepCopyright');
  const optKeepArtist = document.getElementById('optKeepArtist');

  function buildCard(id, file) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = id;
    const previewUrl = URL.createObjectURL(file);
    card.innerHTML = `
      <div class="thumb-wrap">
        <img src="${previewUrl}" alt="">
        <div class="scanline"></div>
      </div>
      <div class="card-body">
        <div class="card-head">
          <span class="filename">${escapeHtml(file.name)}</span>
          <span class="status">vizsgálat&hellip;</span>
        </div>
        <div class="found-list"></div>
        <div class="card-actions"></div>
      </div>`;
    return card;
  }

  async function addFile(file) {
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type) &&
        !/\.(jpe?g|png)$/i.test(file.name)) {
      return;
    }
    const id = `f${seq++}`;
    const card = buildCard(id, file);
    queueEl.appendChild(card);
    items.set(id, { file, found: null, cleanedBlob: null, cardEl: card });

    let found = null;
    try {
      found = await MW.inspect(file);
    } catch (e) {
      found = null;
    }
    const entry = items.get(id);
    entry.found = found;

    const statusEl = card.querySelector('.status');
    const foundListEl = card.querySelector('.found-list');
    const badges = badgesFor(found);
    foundListEl.innerHTML = badges.map((b) => `<span class="badge ${b.cls}">${b.html}</span>`).join('');
    statusEl.textContent = found ? `${badges.length} mező` : 'nem támogatott';

    optionsEl.classList.remove('hidden');
    stripAllBtn.disabled = false;
  }

  function handleFiles(fileList) {
    Array.from(fileList).forEach(addFile);
  }

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  stripAllBtn.addEventListener('click', async () => {
    stripAllBtn.disabled = true;
    stripAllBtn.textContent = 'Tisztítás…';
    const opts = { keepCopyright: optKeepCopyright.checked, keepArtist: optKeepArtist.checked };

    for (const [id, entry] of items) {
      if (entry.cleanedBlob) continue; // already done
      const card = entry.cardEl;
      const statusEl = card.querySelector('.status');
      const actionsEl = card.querySelector('.card-actions');
      try {
        const blob = await MW.strip(entry.file, entry.found, opts);
        entry.cleanedBlob = blob;
        const base = entry.file.name.replace(/\.[^.]+$/, '');
        const ext = entry.found.format === 'PNG' ? 'png' : 'jpg';
        const cleanName = `${base}_clean.${ext}`;
        const url = URL.createObjectURL(blob);
        statusEl.textContent = 'tiszta';
        statusEl.classList.add('clean');
        actionsEl.innerHTML = `<a class="btn ghost small" href="${url}" download="${cleanName}">Letöltés</a>`;
      } catch (e) {
        statusEl.textContent = 'hiba';
      }
    }

    stripAllBtn.textContent = 'Összes tisztítása';
    stripAllBtn.disabled = false;

    if (items.size > 1) {
      let zipBtn = document.getElementById('zipAllBtn');
      if (!zipBtn) {
        zipBtn = document.createElement('button');
        zipBtn.id = 'zipAllBtn';
        zipBtn.className = 'btn ghost';
        zipBtn.textContent = 'Mind letöltése (.zip)';
        optionsEl.insertBefore(zipBtn, stripAllBtn);
      }
      zipBtn.onclick = async () => {
        const zip = new JSZip();
        for (const [, entry] of items) {
          if (!entry.cleanedBlob) continue;
          const base = entry.file.name.replace(/\.[^.]+$/, '');
          const ext = entry.found.format === 'PNG' ? 'png' : 'jpg';
          zip.file(`${base}_clean.${ext}`, entry.cleanedBlob);
        }
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'metawipe_clean.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    }
  });

  // ---------- API panel: base URL + code tabs + copy buttons ----------
  document.querySelectorAll('.base-url').forEach((el) => { el.textContent = window.location.origin; });

  document.querySelectorAll('.code-block').forEach((block) => {
    const tabs = block.querySelectorAll('.code-tab');
    const panels = block.querySelectorAll('.code-panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        panels.forEach((p) => p.classList.toggle('active', p.dataset.lang === tab.dataset.lang));
      });
    });
  });

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.parentElement.querySelector('pre').innerText;
      navigator.clipboard.writeText(code).then(() => {
        const original = btn.textContent;
        btn.textContent = 'másolva';
        setTimeout(() => { btn.textContent = original; }, 1400);
      });
    });
  });
})();
