/* RECTOoth — Library.zip-driven static catalogue */
(() => {
  "use strict";

  const LIBRARY_ZIP = "Library.zip";

  const TYPE_INFO = {
    i: { label: "Incisor", plural: "Incisors" },
    c: { label: "Canine", plural: "Canines" },
    p: { label: "Premolar", plural: "Premolars" },
    m: { label: "Molar", plural: "Molars" }
  };

  const $ = (id) => document.getElementById(id);
  const state = {
    manifest: null, activeType: null, staged: null, angles: [],
        zip: null, prefix: "",
    raw: new Map(),        // path -> Promise<blob URL straight from the ZIP>
    converted: new Map(),  // path -> JPEG blob URL made by heic2any
    display: new Map(),    // path -> URL that is known to display correctly
    loading: false, toastTimer: null
  };

  const homeView = $("homeView");
  const catalogView = $("catalogView");
  const stage = $("stage");

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  /* ---------- ZIP access ---------- */

  function mimeFor(path) {
    return /\.heic$/i.test(path) ? "image/heic" : "image/jpeg";
  }

  async function readBlob(path) {
    const entry = state.zip && state.zip.file(state.prefix + path);
    if (!entry) throw new Error(`Not found in ${LIBRARY_ZIP}: ${path}`);
    const data = await entry.async("arraybuffer");
    return new Blob([data], { type: mimeFor(path) });
  }

  function getRawUrl(path) {
    if (!state.raw.has(path)) {
      const promise = readBlob(path)
        .then((blob) => URL.createObjectURL(blob))
        .catch((error) => { state.raw.delete(path); throw error; });
      state.raw.set(path, promise);
    }
    return state.raw.get(path);
  }

  async function getConvertedUrl(path) {
    if (state.converted.has(path)) return state.converted.get(path);
    if (!window.heic2any) throw new Error("HEIC decoder has not loaded");
    const blob = await readBlob(path);
    const converted = await window.heic2any({ blob, toType: "image/jpeg", quality: 0.88 });
    const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
    const url = URL.createObjectURL(jpegBlob);
    state.converted.set(path, url);
    return url;
  }

  function releaseUrls() {
    state.raw.forEach((promise) => promise.then((url) => URL.revokeObjectURL(url), () => {}));
    state.raw.clear();
    state.converted.forEach((url) => URL.revokeObjectURL(url));
    state.converted.clear();
    state.display.clear();
  }

  /* ---------- Image loading ---------- */

  function loadImage(img, path, modified, placeholder, onSettled) {
    const settle = (ok) => { if (onSettled) onSettled(ok); };
    if (!path) {
      img.removeAttribute("src");
      if (placeholder) placeholder.textContent = "Image unavailable";
      settle(false);
      return;
    }
    const current = () => img.dataset.path === path;
    const fail = (message) => {
      if (placeholder) placeholder.textContent = message;
      settle(false);
    };
    img.dataset.path = path;
    img.dataset.modified = String(modified || "");
    img.dataset.loaded = "false";
    img.dataset.fallbackTried = "false";

    img.onload = () => {
      img.dataset.loaded = "true";
      if (current()) state.display.set(path, img.src);
      if (placeholder) placeholder.textContent = "";
      settle(true);
    };
    img.onerror = () => {
      if (!current()) return;
      if (img.dataset.fallbackTried === "true" || !/\.heic$/i.test(path)) {
        fail("Preview unavailable");
        return;
      }
      // This browser cannot display HEIC natively: convert it to JPEG.
      img.dataset.fallbackTried = "true";
      getConvertedUrl(path)
        .then((url) => { if (current()) img.src = url; })
        .catch((error) => {
          console.warn("Could not decode HEIC image:", path, error);
          fail("HEIC preview unavailable");
        });
    };

    const known = state.display.get(path);
    if (known) { img.src = known; return; }
    getRawUrl(path)
      .then((url) => { if (current()) img.src = url; })
      .catch((error) => {
        console.warn("Could not read image from ZIP:", path, error);
        fail("Image missing");
      });
  }

  function observeLazyImages(root) {
    const images = root.querySelectorAll("img[data-lazy='true']");
    if (!("IntersectionObserver" in window)) {
      images.forEach((img) => loadImage(img, img.dataset.path, img.dataset.modified));
      return;
    }
    if (!state.imageObserver) {
      state.imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const img = entry.target;
          observer.unobserve(img);
          loadImage(img, img.dataset.path, Number(img.dataset.modified) || undefined);
        });
      }, { rootMargin: "180px" });
    }
    images.forEach((img) => state.imageObserver.observe(img));
  }

  /* ---------- Catalogue ---------- */

  function makeToothCard(tooth) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tooth-card${tooth.status === "marked_sold" ? " is-sold" : ""}`;
    button.setAttribute("aria-label", `Inspect ${tooth.name}${tooth.status === "marked_sold" ? ", sold out" : ""}`);
    if (tooth.status === "marked_sold") {
      const marker = document.createElement("span");
      marker.className = "sold-mark";
      marker.textContent = "Sold out";
      button.append(marker);
    }
    const imageWrap = document.createElement("span");
    imageWrap.className = "tooth-image-wrap";
    const img = document.createElement("img");
    img.alt = `${tooth.name} tooth thumbnail`;
    img.dataset.lazy = "true";
    img.dataset.path = tooth.thumbnail || "";
    img.dataset.modified = String(tooth.modified || "");
    imageWrap.append(img);
    const footer = document.createElement("span");
    footer.className = "tooth-card-footer";
    const name = document.createElement("span");
    name.className = "tooth-name";
    name.textContent = tooth.name;
    const sub = document.createElement("span");
    sub.className = "tooth-sub";
    sub.textContent = tooth.status === "marked_sold" ? "Unavailable" : "View specimen";
    footer.append(name, sub);
    button.append(imageWrap, footer);
    button.addEventListener("click", () => openStage(tooth));
    return button;
  }

  function renderHome() {
    const teeth = state.manifest.teeth || [];
    $("totalCount").textContent = `${state.manifest.counts?.available ?? teeth.filter(t => t.status === "available").length} available`;
    document.querySelectorAll(".type-card").forEach((card) => {
      const letter = card.dataset.type;
      const count = teeth.filter(t => t.typeLetter === letter && t.status === "available").length;
      card.querySelector(".type-count").textContent = `${count} available`;
    });
  }

  function openCatalog(letter) {
    state.activeType = letter;
    const info = TYPE_INFO[letter];
    if (!info) return;
    homeView.classList.add("hidden");
    catalogView.classList.remove("hidden");
    stage.classList.add("hidden");
    $("catalogTitle").textContent = info.plural;
    const all = (state.manifest.teeth || []).filter(t => t.typeLetter === letter);
    const main = all.filter(t => t.status === "available" || t.status === "marked_sold")
      .sort((a, b) => a.number - b.number);
    const sold = all.filter(t => t.status === "sold_copy")
      .sort((a, b) => a.number - b.number || (a.romanIndex || 0) - (b.romanIndex || 0));
    $("catalogSubtitle").textContent = `${main.filter(t => t.status === "available").length} available specimens`;
    $("catalogTotal").textContent = `${main.length} ${main.length === 1 ? "piece" : "pieces"}`;
    $("toothGrid").replaceChildren(...main.map(makeToothCard));
    $("emptyState").classList.toggle("hidden", main.length !== 0);
    $("soldSection").classList.toggle("hidden", sold.length === 0);
    $("soldToggleLabel").textContent = `Sold out versions (${sold.length})`;
    $("soldToggle").setAttribute("aria-expanded", "false");
    $("soldGrid").classList.add("hidden");
    $("soldGrid").replaceChildren(...sold.map(makeToothCard));
    observeLazyImages(catalogView);
  }

  function returnHome() {
    state.activeType = null;
    catalogView.classList.add("hidden");
    homeView.classList.remove("hidden");
    stage.classList.add("hidden");
  }

  /* ---------- Stage ---------- */
  // The 12 angle slides are built once per tooth. While panning, only transform, opacity and a
  // few discrete blur steps are written, once per animation frame, so nothing is re-created.

  const BLUR_PX = [0, 2, 4, 6.5];
  const carouselWindow = $("carouselWindow");
  const scrubTrack = $("scrubTrack");
  const scrubThumb = $("scrubThumb");
  const scrubTicks = $("scrubTicks");
  const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  // Gesture feel per input device (touch tracks the finger 1:1 and glides longest).
  const FEEL = {
    touch: { friction: 3.4, minVelocity: 1.2 },
    pen:   { friction: 4.5, minVelocity: 1.4 },
    mouse: { friction: 6.0, minVelocity: 1.8 }
  };

  const view = {
    pos: 0, vel: 0, mode: "idle",            // idle | drag | inertia | snap
    target: 0, friction: 4, raf: 0, last: 0,
    slides: [], spacing: 170, width: 700,
    pointerId: null, pointerType: "touch", startX: 0, startPos: 0, samples: [],
    shownIndex: -1,
    scrub: { trackW: 0, thumbW: 56, range: 1, left: 0, rectLeft: 0, grab: 0, pointerId: null }
  };

  const mod = (value, n) => ((value % n) + n) % n;
  const pad2 = (value) => String(value).padStart(2, "0");

  function measure() {
    view.width = carouselWindow.clientWidth || 700;
    // One step of spacing equals one angle, so the front image follows the finger 1:1.
    // Narrow screens use tighter spacing, so a full swipe still travels through several angles.
    view.spacing = Math.max(64, Math.min(170, view.width * .235));
    const s = view.scrub;
    s.trackW = scrubTrack.clientWidth || 300;
    s.thumbW = scrubThumb.offsetWidth || 56;
    s.range = Math.max(1, s.trackW - s.thumbW);
    layoutTicks();
  }

  function layoutTicks() {
    const s = view.scrub;
    const kids = scrubTicks.children;
    for (let i = 0; i < kids.length; i++) {
      const frac = Number(kids[i].dataset.frac) || 0;
      kids[i].style.left = (s.thumbW / 2 + frac * s.range) + "px";
    }
  }

  function buildTicks() {
    scrubTicks.replaceChildren();
    const n = state.angles.length;
    state.angles.forEach((angle, i) => {
      const tick = document.createElement("span");
      tick.className = `scrub-tick ${angle.surface === "Top" ? "top" : "bottom"}`;
      tick.dataset.frac = String(n > 1 ? i / (n - 1) : 0);
      scrubTicks.append(tick);
    });
    const topCount = state.angles.filter(a => a.surface === "Top").length;
    if (n > 1 && topCount > 0 && topCount < n) {
      const divider = document.createElement("span");
      divider.className = "scrub-divider";
      divider.dataset.frac = String((topCount - .5) / (n - 1));
      scrubTicks.append(divider);
    }
  }

  function buildCarousel() {
    const orbit = $("carouselOrbit");
    orbit.replaceChildren();
    view.slides = [];
    scrubTicks.replaceChildren();
    view.shownIndex = -1;
    if (!state.angles.length) {
      const empty = document.createElement("div");
      empty.className = "angle-slide";
      empty.style.transform = "translate(-50%,-50%)";
      empty.innerHTML = '<span class="angle-placeholder">No angle images available</span>';
      orbit.append(empty);
      $("surfaceIndicator").textContent = "NO ANGLES";
      $("anglePosition").textContent = "— / —";
      $("scrub").classList.add("hidden");
      return;
    }
    $("scrub").classList.remove("hidden");
    state.angles.forEach((angle, index) => {
      const el = document.createElement("div");
      el.className = "angle-slide";
      el.style.visibility = "hidden";
      const img = document.createElement("img");
      img.alt = `${state.staged.name}, ${angle.surface.toLowerCase()} angle ${index + 1}`;
      img.draggable = false;
      img.decoding = "async";
      el.append(img);
      orbit.append(el);
      view.slides.push({ el, img, hidden: true, level: -1, z: null });
    });
    buildTicks();
    measure();
    render();
  }

  function render() {
    const n = view.slides.length;
    if (!n) return;
    const p = mod(view.pos, n);
    const spacing = view.spacing;
    for (let i = 0; i < n; i++) {
      const s = view.slides[i];
      let d = i - p;
      if (d > n / 2) d -= n;
      if (d < -n / 2) d += n;
      const a = Math.abs(d);
      if (a > 3.4) {
        if (!s.hidden) { s.el.style.visibility = "hidden"; s.hidden = true; }
        continue;
      }
      if (s.hidden) { s.el.style.visibility = "visible"; s.hidden = false; }
      const scale = Math.max(.68, 1 - a * .095);
      s.el.style.transform = `translate3d(${(d * spacing).toFixed(1)}px,0,0) translate(-50%,-50%) scale(${scale.toFixed(3)})`;
      s.el.style.opacity = Math.max(.16, 1 - a * .23).toFixed(3);
      const z = 20 - Math.round(a * 4);
      if (s.z !== z) { s.z = z; s.el.style.zIndex = String(z); }
      const level = a < .5 ? 0 : a < 1.5 ? 1 : a < 2.5 ? 2 : 3;
      if (s.level !== level) {
        s.level = level;
        s.el.style.filter = level ? `blur(${BLUR_PX[level]}px)` : "none";
      }
    }
    const idx = Math.round(p) % n;
    if (idx !== view.shownIndex) {
      view.shownIndex = idx;
      const angle = state.angles[idx];
      $("surfaceIndicator").textContent = `${angle.surface.toUpperCase()} VIEW`;
      $("anglePosition").textContent = `${pad2(idx + 1)} / ${pad2(n)}`;
      scrubTrack.setAttribute("aria-valuenow", String(idx + 1));
      scrubTrack.setAttribute("aria-valuetext", `${angle.surface} view, ${idx + 1} of ${n}`);
    }
    const sc = view.scrub;
    const frac = n > 1 ? Math.min(p, n - 1) / (n - 1) : 0;
    sc.left = frac * sc.range;
    scrubThumb.style.transform = `translate3d(${sc.left.toFixed(1)}px,0,0)`;
  }

  function requestFrame() {
    if (view.raf) return;
    view.last = performance.now();
    view.raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    view.raf = 0;
    const dt = Math.min(.05, Math.max(.001, (now - view.last) / 1000));
    view.last = now;
    if (view.mode === "inertia") {
      view.pos += view.vel * dt;
      view.vel *= Math.exp(-view.friction * dt);
      if (Math.abs(view.vel) < .7) { view.mode = "snap"; view.target = Math.round(view.pos); }
    }
    if (view.mode === "snap") {
      view.pos += (view.target - view.pos) * (1 - Math.exp(-16 * dt));
      if (Math.abs(view.target - view.pos) < .003) {
        const n = state.angles.length || 1;
        view.pos = mod(view.target, n);
        view.mode = "idle";
      }
    }
    render();
    if (view.mode === "inertia" || view.mode === "snap") requestFrame();
  }

  function startSnap(target) {
    if (reduceMotion.matches) {
      const n = state.angles.length || 1;
      view.pos = mod(target, n);
      view.mode = "idle";
      requestFrame();
      return;
    }
    view.mode = "snap";
    view.target = target;
    requestFrame();
  }

  function moveCarousel(delta) {
    if (!state.angles.length) return;
    const base = view.mode === "snap" ? view.target : Math.round(view.pos);
    startSnap(base + delta);
  }

  /* Dragging the images */
  carouselWindow.addEventListener("pointerdown", (event) => {
    if (!state.angles.length || view.pointerId !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    view.pointerId = event.pointerId;
    view.pointerType = FEEL[event.pointerType] ? event.pointerType : "mouse";
    view.mode = "drag";
    view.vel = 0;
    view.startX = event.clientX;
    view.startPos = view.pos;
    view.samples = [{ t: event.timeStamp, x: event.clientX }];
    carouselWindow.classList.add("dragging");
    try { carouselWindow.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
  });

  carouselWindow.addEventListener("pointermove", (event) => {
    if (event.pointerId !== view.pointerId) return;
    view.pos = view.startPos - (event.clientX - view.startX) / view.spacing;
    view.samples.push({ t: event.timeStamp, x: event.clientX });
    while (view.samples.length > 2 && event.timeStamp - view.samples[0].t > 100) view.samples.shift();
    requestFrame();
  });

  function endDrag(event) {
    if (event.pointerId !== view.pointerId) return;
    view.pointerId = null;
    carouselWindow.classList.remove("dragging");
    const feel = FEEL[view.pointerType] || FEEL.mouse;
    const first = view.samples[0];
    const last = view.samples[view.samples.length - 1];
    let velocity = 0;
    if (first && last && last !== first && event.timeStamp - last.t < 80) {
      const seconds = (last.t - first.t) / 1000;
      if (seconds > .01) velocity = -((last.x - first.x) / seconds) / view.spacing;
    }
    velocity = Math.max(-16, Math.min(16, velocity));
    if (!reduceMotion.matches && Math.abs(velocity) >= feel.minVelocity) {
      view.mode = "inertia";
      view.vel = velocity;
      view.friction = feel.friction;
      requestFrame();
    } else {
      startSnap(Math.round(view.pos));
    }
  }
  carouselWindow.addEventListener("pointerup", endDrag);
  carouselWindow.addEventListener("pointercancel", endDrag);

  /* Mouse wheel and trackpad */
  let wheelTimer = 0;
  carouselWindow.addEventListener("wheel", (event) => {
    if (!state.angles.length || event.ctrlKey) return;
    let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= view.width;
    if (view.pointerId === null) view.mode = "drag";
    view.pos += (delta / view.spacing) * .6;
    requestFrame();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      if (view.pointerId === null && view.scrub.pointerId === null) startSnap(Math.round(view.pos));
    }, 130);
  }, { passive: false });

  /* The scrub bar: a horizontal scrollbar-style handle under the images */
  function scrubValue(clientX) {
    const s = view.scrub;
    const left = clientX - s.rectLeft - s.grab;
    const frac = Math.min(1, Math.max(0, left / s.range));
    return frac * (state.angles.length - 1);
  }

  scrubTrack.addEventListener("pointerdown", (event) => {
    const s = view.scrub;
    if (!state.angles.length || s.pointerId !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = scrubTrack.getBoundingClientRect();
    s.rectLeft = rect.left;
    s.pointerId = event.pointerId;
    scrubTrack.classList.add("dragging");
    view.vel = 0;
    const onThumb = event.target === scrubThumb;
    if (onThumb) {
      s.grab = event.clientX - (rect.left + s.left);   // thumb stays exactly under the finger
      view.mode = "drag";
    } else {
      s.grab = s.thumbW / 2;                           // tap on the track: glide to that angle
      const n = state.angles.length;
      startSnap(view.pos + (Math.round(scrubValue(event.clientX)) - mod(view.pos, n)));
    }
    try { scrubTrack.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
  });

  scrubTrack.addEventListener("pointermove", (event) => {
    const s = view.scrub;
    if (event.pointerId !== s.pointerId) return;
    view.mode = "drag";
    view.pos = scrubValue(event.clientX);
    requestFrame();
  });

  function endScrub(event) {
    const s = view.scrub;
    if (event.pointerId !== s.pointerId) return;
    s.pointerId = null;
    scrubTrack.classList.remove("dragging");
    if (view.mode === "drag") startSnap(Math.round(view.pos));
  }
  scrubTrack.addEventListener("pointerup", endScrub);
  scrubTrack.addEventListener("pointercancel", endScrub);

  window.addEventListener("resize", () => {
    if (stage.classList.contains("hidden")) return;
    measure();
    requestFrame();
  });

  function openStage(tooth) {
    state.staged = tooth;
    state.angles = [...(tooth.top || []).map(path => ({ path, surface: "Top" })),
                    ...(tooth.bottom || []).map(path => ({ path, surface: "Bottom" }))];
    $("stageName").textContent = tooth.name;
    $("stageType").textContent = `${tooth.type || "TOOTH"} SPECIMEN`;
    $("stageCounter").textContent = tooth.soldOutCopy ? "ARCHIVED SOLD COPY" : "SPECIMEN DETAIL";
    $("stageStatus").textContent = tooth.status === "marked_sold" || tooth.status === "sold_copy" ? "Sold out" : "Available";
    $("stageStatus").classList.toggle("sold", tooth.status !== "available");
    const thumb = $("stageThumb");
    if (tooth.thumbnail) loadImage(thumb, tooth.thumbnail, tooth.modified);
    else thumb.removeAttribute("src");
    stage.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    view.mode = "idle";
    view.pos = 0;
    view.vel = 0;
    view.pointerId = null;
    view.scrub.pointerId = null;
    buildCarousel();
    preloadAngles(tooth);
  }

  function closeStage() {
    stage.classList.add("hidden");
    document.body.style.overflow = "";
    state.staged = null;
    view.mode = "idle";
    if (view.raf) { cancelAnimationFrame(view.raf); view.raf = 0; }
    if (state.activeType) catalogView.classList.remove("hidden");
  }

  // Loads the 12 images one at a time, starting with the front image and its neighbours.
  async function preloadAngles(tooth) {
    const n = state.angles.length;
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => Math.min(a, n - a) - Math.min(b, n - b));
    for (const i of order) {
      if (state.staged !== tooth) return;
      const slide = view.slides[i];
      if (!slide) continue;
      await new Promise((resolve) => {
        loadImage(slide.img, state.angles[i].path, tooth.modified, null, resolve);
      });
    }
  }

  /* ---------- Loading Library.zip ---------- */

  async function downloadZip(onProgress) {
    const response = await fetch(`${LIBRARY_ZIP}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${LIBRARY_ZIP} request returned ${response.status}`);
    const total = Number(response.headers.get("content-length")) || 0;
    if (!response.body || !response.body.getReader) return response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes.buffer;
  }

  function progressText(received, total) {
    if (total > 0) return `Downloading library… ${Math.min(99, Math.round(received / total * 100))}%`;
    return `Downloading library… ${(received / 1048576).toFixed(1)} MB`;
  }

  async function loadLibrary() {
    if (state.loading) return;
    state.loading = true;
    $("totalCount").textContent = "Loading library…";
    try {
      if (!window.JSZip) throw new Error("JSZip has not loaded");
      const buffer = await downloadZip((received, total) => {
        $("totalCount").textContent = progressText(received, total);
      });
      $("totalCount").textContent = "Opening library…";
      const zip = await window.JSZip.loadAsync(buffer);

      // Find manifest.json (normally Library/manifest.json), ignoring macOS metadata folders.
      const candidates = zip.file(/(^|\/)manifest\.json$/).filter(f => !f.name.startsWith("__MACOSX/"));
      if (!candidates.length) throw new Error(`manifest.json not found inside ${LIBRARY_ZIP}`);
      candidates.sort((a, b) => a.name.length - b.name.length);
      const manifestEntry = candidates[0];
      const prefix = manifestEntry.name.slice(0, manifestEntry.name.length - "manifest.json".length);
      const manifest = JSON.parse(await manifestEntry.async("string"));

      if (!manifest || !Array.isArray(manifest.teeth)) throw new Error("manifest does not contain a teeth array");
      if (Number(manifest.schema) > 1) {
        showToast(`Library schema ${manifest.schema} is newer than this site supports.`);
      } else if (Number(manifest.schema) !== 1) {
        throw new Error(`unsupported library schema: ${manifest.schema}`);
      }

      // Each load is a complete snapshot. Nothing is merged with the previous library.
      if (!stage.classList.contains("hidden")) closeStage();
      releaseUrls();
      state.zip = zip;
      state.prefix = prefix;
      state.manifest = manifest;
      renderHome();
      if (state.activeType) openCatalog(state.activeType);
    } catch (error) {
      console.error(error);
      if (state.manifest) {
        showToast("Could not refresh the library. Showing the previous version.");
        renderHome();
      } else {
        $("totalCount").textContent = "Library unavailable";
        showToast(`Could not load ${LIBRARY_ZIP}. Check that it is in the repo root.`);
        $("typeGrid").querySelectorAll(".type-count").forEach(el => { el.textContent = "Library unavailable"; });
      }
    } finally {
      state.loading = false;
    }
  }

  $("typeGrid").addEventListener("click", (event) => {
    const card = event.target.closest(".type-card");
    if (card && state.manifest) openCatalog(card.dataset.type);
  });
  $("backHome").addEventListener("click", returnHome);
  $("homeBrand").addEventListener("click", (event) => { event.preventDefault(); returnHome(); });
  $("closeStage").addEventListener("click", closeStage);
  $("stageBackdrop").addEventListener("click", closeStage);
  $("refreshButton").addEventListener("click", loadLibrary);
  $("soldToggle").addEventListener("click", () => {
    const button = $("soldToggle");
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    $("soldGrid").classList.toggle("hidden", expanded);
    if (!expanded) observeLazyImages($("soldGrid"));
  });
  document.addEventListener("keydown", (event) => {
    if (stage.classList.contains("hidden")) return;
    if (event.key === "Escape") closeStage();
    if (event.key === "ArrowRight") moveCarousel(1);
    if (event.key === "ArrowLeft") moveCarousel(-1);
  });

  loadLibrary();
})();
