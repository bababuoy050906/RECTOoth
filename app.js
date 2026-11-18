/* RECTOoth — Library.zip-driven static catalogue */
(() => {
  "use strict";

  const LIBRARY_ZIP = "Library.zip";

  const USER_CONFIG = window.RECTOOTH_CONFIG || {};
  const CONFIG = Object.assign({
    messengerLink: "",
    currencySymbol: "\u20B1",
    includeFilipinoInMessage: true,
    preorderNotes: []
  }, USER_CONFIG);
  CONFIG.map = Object.assign({
    center: [14.604, 120.9925], zoom: 16, minZoom: 14,
    bounds: [[14.585, 120.965], [14.625, 121.015]]
  }, USER_CONFIG.map || {});

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

  function formatPeso(value) {
    return CONFIG.currencySymbol + Number(value).toLocaleString("en-PH");
  }

  function priceLabel(tooth) {
    if (tooth.status === "marked_sold") return "Sold out";
    if (tooth.price == null) return tooth.status === "sold_copy" ? "Sold" : "Price on request";
    return formatPeso(tooth.price);
  }

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
    sub.className = "tooth-price" + (tooth.status === "available" ? "" : " is-muted");
    sub.textContent = priceLabel(tooth);
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
    slides: [], spacing: 170, width: 700, zoom: 1, zoomIndex: 1,
    pointerId: null, pointerType: "touch", startX: 0, startPos: 0, samples: [],
    shownIndex: -1,
    scrub: { trackW: 0, thumbW: 56, range: 1, left: 0, rectLeft: 0, grab: 0, pointerId: null }
  };

  const ZOOM_LEVELS = [0.8, 1, 1.25, 1.5];
  const step = () => view.spacing * view.zoom;   // pixels per angle at the current zoom
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
    const spacing = step();
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
      const scale = Math.max(.68, 1 - a * .095) * view.zoom;
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

  function setZoomIndex(index, redraw = true) {
    view.zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
    view.zoom = ZOOM_LEVELS[view.zoomIndex];
    carouselWindow.style.setProperty("--zoomh", String(Math.max(1, view.zoom)));
    $("zoomLevel").textContent = `${Math.round(view.zoom * 100)}%`;
    $("zoomOut").disabled = view.zoomIndex === 0;
    $("zoomIn").disabled = view.zoomIndex === ZOOM_LEVELS.length - 1;
    if (redraw) { measure(); requestFrame(); }
  }
  $("zoomIn").addEventListener("click", () => setZoomIndex(view.zoomIndex + 1));
  $("zoomOut").addEventListener("click", () => setZoomIndex(view.zoomIndex - 1));

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
    view.pos = view.startPos - (event.clientX - view.startX) / step();
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
      if (seconds > .01) velocity = -((last.x - first.x) / seconds) / step();
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
    view.pos += (delta / step()) * .6;
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
    $("stagePrice").textContent = priceLabel(tooth);
    updatePreorderButton(tooth);
    setZoomIndex(1, false);
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

  /* ---------- Pre-order ---------- */

  const PIN_SVG = '<svg viewBox="0 0 34 44" width="34" height="44" aria-hidden="true"><path d="M17 43C17 43 3 28.5 3 16.5a14 14 0 0 1 28 0C31 28.5 17 43 17 43z" fill="#b5655a" stroke="#ffffff" stroke-width="2"/><circle cx="17" cy="16.5" r="5.5" fill="#ffffff"/></svg>';
  const preModal = $("preorderModal");
  const pre = {
    tooth: null, map: null, marker: null, pin: null, pinLabel: "",
    edited: false, geoToken: 0, geoTimer: 0, copied: false,
    shotUrl: null, lastNick: "", orderId: ""
  };
  const PIN_HINT = "Tap the map to drop a pin. The address fills in automatically.";

  function updatePreorderButton(tooth) {
    const open = tooth.status === "available";
    $("preorderButton").disabled = !open;
    $("preorderLabel").textContent = open ? "Pre-order this tooth" : "Sold out";
  }

  function toLocalInput(date) {
    const p = (v) => String(v).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function releaseShot() {
    if (pre.shotUrl) URL.revokeObjectURL(pre.shotUrl);
    pre.shotUrl = null;
  }

  function openPreorder() {
    const tooth = state.staged;
    if (!tooth || tooth.status !== "available") return;
    pre.tooth = tooth;
    const info = TYPE_INFO[tooth.typeLetter];
    $("preToothName").textContent = tooth.name;
    $("preToothMeta").textContent = info ? info.label : (tooth.type || "");
    $("prePrice").textContent = priceLabel(tooth);
    $("preNotes").replaceChildren(...(CONFIG.preorderNotes || []).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
    $("preNick").value = pre.lastNick;
    $("preLocation").value = "";
    $("preWhen").value = "";
    const soonest = new Date(Date.now() + 60 * 60 * 1000);
    soonest.setSeconds(0, 0);
    $("preWhen").min = toLocalInput(soonest);
    $("preWhen").max = toLocalInput(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000));
    pre.edited = false;
    clearPin(true);
    $("mapBox").classList.add("hidden");
    $("mapToggle").setAttribute("aria-expanded", "false");
    $("preError").classList.add("hidden");
    $("preResult").classList.add("hidden");
    $("preForm").classList.remove("hidden");
    releaseShot();
    preModal.classList.remove("hidden");
    $("preModalPanel").scrollTop = 0;
  }

  function closePreorder() {
    preModal.classList.add("hidden");
    releaseShot();
  }

  /* Map and pin */
  function initMap() {
    if (pre.map) return true;
    if (!window.L) return false;
    const m = CONFIG.map;
    pre.map = L.map("pinMap", {
      center: m.center, zoom: m.zoom, minZoom: m.minZoom, maxZoom: 19,
      maxBounds: m.bounds, maxBoundsViscosity: .85
    });
    pre.map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(pre.map);
    pre.map.on("click", (event) => setPin(event.latlng.lat, event.latlng.lng));
    return true;
  }

  function setPin(lat, lng) {
    pre.pin = { lat, lng };
    const latlng = [lat, lng];
    if (!pre.marker) {
      pre.marker = L.marker(latlng, {
        draggable: true,
        icon: L.divIcon({ className: "pin-icon", html: PIN_SVG, iconSize: [34, 44], iconAnchor: [17, 42] })
      }).addTo(pre.map);
      pre.marker.on("dragend", () => {
        const p = pre.marker.getLatLng();
        setPin(p.lat, p.lng);
      });
    } else {
      pre.marker.setLatLng(latlng);
    }
    $("pinInfo").textContent = `Pin set at ${lat.toFixed(5)}, ${lng.toFixed(5)}. Looking up the address...`;
    $("pinClear").classList.remove("hidden");
    clearTimeout(pre.geoTimer);
    pre.geoTimer = setTimeout(() => reverseGeocode(lat, lng), 450);   // one lookup per settled pin
  }

  function shortAddress(data, lat, lng) {
    const a = data && data.address;
    if (a) {
      const place = a.amenity || a.building || a.shop || a.tourism || a.office || a.leisure || a.man_made;
      const road = a.road || a.pedestrian || a.footway;
      const area = a.neighbourhood || a.suburb || a.quarter || a.city_district;
      const city = a.city || a.town || a.municipality || "Manila";
      const parts = [place, road, area, city].filter(Boolean);
      const unique = parts.filter((p, i) => parts.indexOf(p) === i);
      if (unique.length) return unique.join(", ");
    }
    if (data && data.display_name) return data.display_name.split(",").slice(0, 3).join(",").trim();
    return `Pinned spot (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
  }

  async function reverseGeocode(lat, lng) {
    const token = ++pre.geoToken;
    let label;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Nominatim returned ${response.status}`);
      label = shortAddress(await response.json(), lat, lng);
    } catch (error) {
      console.warn("Address lookup failed:", error);
      label = `Pinned spot (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
    }
    if (token !== pre.geoToken || !pre.pin) return;
    pre.pinLabel = label;
    $("pinInfo").textContent = `Pin set: ${label}`;
    if (!pre.edited || !$("preLocation").value.trim()) {
      $("preLocation").value = label;   // autofill unless the buyer typed their own place
      pre.edited = false;
    }
  }

  function clearPin(silent) {
    clearTimeout(pre.geoTimer);
    pre.geoToken++;
    if (pre.marker && pre.map) { pre.map.removeLayer(pre.marker); }
    pre.marker = null;
    const autofilled = pre.pin && !pre.edited && $("preLocation").value === pre.pinLabel;
    pre.pin = null;
    pre.pinLabel = "";
    $("pinInfo").textContent = PIN_HINT;
    $("pinClear").classList.add("hidden");
    if (!silent && autofilled) $("preLocation").value = "";
  }

  $("preLocation").addEventListener("input", () => { pre.edited = true; });
  $("pinClear").addEventListener("click", () => clearPin(false));
  $("mapToggle").addEventListener("click", () => {
    const box = $("mapBox");
    const opening = box.classList.contains("hidden");
    box.classList.toggle("hidden", !opening);
    $("mapToggle").setAttribute("aria-expanded", String(opening));
    if (!opening) return;
    if (!initMap()) {
      $("pinMap").classList.add("hidden");
      $("pinInfo").textContent = "The map could not load. You can still type your meetup place.";
      return;
    }
    setTimeout(() => pre.map.invalidateSize(), 60);
  });

  /* Message */
  function buildMessage({ nick, place, when, orderId }) {
    const t = pre.tooth;
    const info = TYPE_INFO[t.typeLetter];
    const price = t.price != null ? formatPeso(t.price) : "to be confirmed";
    const whenText = when.toLocaleString("en-PH", {
      weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
    const lines = [
      `RECTOoth PRE-ORDER ${orderId}`,
      `Tooth: ${t.name} (${info ? info.label : t.type})`,
      `Price: ${price}`,
      `Nickname: ${nick}`,
      `Meetup place: ${place}`
    ];
    if (pre.pin) lines.push(`Map pin: https://www.google.com/maps?q=${pre.pin.lat.toFixed(6)},${pre.pin.lng.toFixed(6)}`);
    lines.push(`Pick-up offer: ${whenText}`);
    if (pre.pin) lines.push("(Map screenshot attached.)");
    if (CONFIG.includeFilipinoInMessage) {
      lines.push("", `Kumusta po! Gusto kong mag-pre-order ng ${t.name} (${price}). Lugar ng meetup: ${place}. Petsa at oras: ${whenText}. Salamat po!`);
    }
    return { text: lines.join("\n"), whenText };
  }

  /* Map screenshot drawn on a canvas from OpenStreetMap tiles */
  function loadTile(z, x, y) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timer = setTimeout(() => resolve(null), 7000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    });
  }

  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "...").width > maxWidth) t = t.slice(0, -1);
    return t + "...";
  }

  function drawShotPin(ctx, x, y) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.3)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = "#b5655a";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - 10, y - 16, x - 24, y - 30, x - 24, y - 46);
    ctx.arc(x, y - 46, 24, Math.PI, 0);
    ctx.bezierCurveTo(x + 24, y - 30, x + 10, y - 16, x, y);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y - 46, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  async function buildMapShot({ lat, lng, place, orderId, toothName, whenText }) {
    const W = 960, MAP_H = 480, BAND = 140, Z = 17, TILE = 256;
    const n = Math.pow(2, Z);
    const px = (lng + 180) / 360 * n * TILE;
    const rad = lat * Math.PI / 180;
    const py = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n * TILE;
    const left = px - W / 2, top = py - MAP_H / 2;
    const tiles = [];
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + MAP_H) / TILE); ty++) {
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
        tiles.push({ tx, ty, img: null });
      }
    }
    await Promise.all(tiles.map(async (t) => { t.img = await loadTile(Z, t.tx, t.ty); }));

    const paint = (withTiles) => {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = MAP_H + BAND;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e3e1db";
      ctx.fillRect(0, 0, W, canvas.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, MAP_H);
      ctx.clip();
      if (withTiles) {
        tiles.forEach((t) => { if (t.img) ctx.drawImage(t.img, t.tx * TILE - left, t.ty * TILE - top, TILE, TILE); });
      } else {
        ctx.strokeStyle = "#d2d0ca";
        for (let gx = 0; gx < W; gx += 60) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, MAP_H); ctx.stroke(); }
        for (let gy = 0; gy < MAP_H; gy += 60) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
      }
      ctx.restore();
      drawShotPin(ctx, W / 2, MAP_H / 2);

      ctx.font = '600 12px "DM Sans", sans-serif';
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillRect(W - 236, MAP_H - 20, 236, 20);
      ctx.fillStyle = "#444";
      ctx.fillText("\u00A9 OpenStreetMap contributors", W - 8, MAP_H - 6);

      ctx.fillStyle = "#f1efe9";
      ctx.fillRect(0, MAP_H, W, BAND);
      ctx.textAlign = "left";
      ctx.fillStyle = "#282c31";
      ctx.font = '800 24px Manrope, "DM Sans", sans-serif';
      ctx.fillText(fitText(ctx, `RECTOoth meetup  |  ${orderId}  |  ${toothName}`, W - 48), 24, MAP_H + 40);
      ctx.font = '600 20px "DM Sans", sans-serif';
      ctx.fillStyle = "#4a4f52";
      ctx.fillText(fitText(ctx, place, W - 48), 24, MAP_H + 74);
      ctx.font = '500 16px "DM Sans", sans-serif';
      ctx.fillStyle = "#6b706d";
      ctx.fillText(fitText(ctx, `${lat.toFixed(5)}, ${lng.toFixed(5)}  |  Pick-up offer: ${whenText}`, W - 48), 24, MAP_H + 104);
      if (!withTiles) {
        ctx.fillStyle = "#8a4a42";
        ctx.fillText("Map tiles could not be loaded. Use the coordinates above.", 24, 30);
      }
      return canvas;
    };

    const toBlob = (canvas) => new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("empty image"))), "image/png");
      } catch (error) { reject(error); }
    });

    try {
      return await toBlob(paint(true));
    } catch (error) {
      console.warn("Map tiles blocked the screenshot, using a plain card:", error);
      return toBlob(paint(false));
    }
  }

  /* Copy and chat steps */
  function setCopied(flag) {
    pre.copied = flag;
    $("step1").classList.toggle("done", flag);
    $("step2").classList.toggle("is-locked", !flag);
    $("chatLink").setAttribute("aria-disabled", String(!flag));
    $("copyLabel").textContent = flag ? "Copied. Copy again" : "Copy message";
  }

  async function copyMessage() {
    const box = $("messageBox");
    let ok = false;
    try { await navigator.clipboard.writeText(box.value); ok = true; } catch (_) { /* fall back below */ }
    if (!ok) {
      box.focus();
      box.select();
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    }
    if (ok) { setCopied(true); showToast("Message copied. Now open the chat and paste it."); }
    else showToast("Could not copy automatically. Select the message and copy it by hand.");
  }

  function showPreorderResult({ nick, place, when }) {
    const orderId = "RT-" + Date.now().toString(36).toUpperCase().slice(-5);
    pre.orderId = orderId;
    const { text, whenText } = buildMessage({ nick, place, when, orderId });
    $("preOrderId").textContent = orderId;
    $("messageBox").value = text;
    $("chatLink").href = CONFIG.messengerLink || "#";
    setCopied(false);
    releaseShot();
    $("shotImg").removeAttribute("src");
    const hasPin = !!pre.pin;
    $("step3").classList.toggle("hidden", !hasPin);
    $("shotDownload").classList.add("is-locked");
    $("shotDownload").removeAttribute("href");
    $("shotLoading").textContent = "Preparing map image...";
    $("shotLoading").classList.remove("hidden");
    $("preForm").classList.add("hidden");
    $("preResult").classList.remove("hidden");
    $("preModalPanel").scrollTop = 0;

    if (hasPin) {
      const snapshot = { lat: pre.pin.lat, lng: pre.pin.lng, place, orderId, toothName: pre.tooth.name, whenText };
      buildMapShot(snapshot).then((blob) => {
        if (pre.orderId !== orderId || preModal.classList.contains("hidden")) return;
        pre.shotUrl = URL.createObjectURL(blob);
        $("shotImg").src = pre.shotUrl;
        $("shotLoading").classList.add("hidden");
        const link = $("shotDownload");
        link.href = pre.shotUrl;
        link.download = `RECTOoth-${orderId}-${pre.tooth.name}.png`;
        link.classList.remove("is-locked");
      }).catch((error) => {
        console.warn("Could not build the map image:", error);
        $("shotLoading").textContent = "The map image could not be created. The map link in your message still shows your pin.";
      });
    }
  }

  $("preorderButton").addEventListener("click", openPreorder);
  $("preClose").addEventListener("click", closePreorder);
  $("preBackdrop").addEventListener("click", closePreorder);
  $("preDone").addEventListener("click", closePreorder);
  $("copyBtn").addEventListener("click", copyMessage);
  $("messageBox").addEventListener("copy", () => setCopied(true));
  $("chatLink").addEventListener("click", (event) => {
    if (!pre.copied) {
      event.preventDefault();
      showToast("Copy the message first (step 1).");
      return;
    }
    if (!CONFIG.messengerLink || /YOUR_/i.test(CONFIG.messengerLink)) {
      event.preventDefault();
      showToast("The seller's chat link is not set yet. Edit config.js.");
    }
  });
  $("shotDownload").addEventListener("click", (event) => {
    if (!pre.shotUrl) event.preventDefault();
  });

  $("preForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const nick = $("preNick").value.trim();
    const place = $("preLocation").value.trim();
    const whenValue = $("preWhen").value;
    const err = $("preError");
    const fail = (message) => { err.textContent = message; err.classList.remove("hidden"); };
    if (!nick) return fail("Please enter a nickname or alias.");
    if (place.length < 2) return fail("Please type where you want to meet, or drop a pin on the map.");
    if (!whenValue) return fail("Please choose a pick-up date and time.");
    const when = new Date(whenValue);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now()) return fail("Please pick a date and time that is still ahead.");
    err.classList.add("hidden");
    pre.lastNick = nick;
    showPreorderResult({ nick, place, when });
  });

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
    if (!$("preorderModal").classList.contains("hidden")) {
      if (event.key === "Escape") closePreorder();
      return;
    }
    if (stage.classList.contains("hidden")) return;
    if (event.key === "Escape") closeStage();
    if (event.key === "ArrowRight") moveCarousel(1);
    if (event.key === "ArrowLeft") moveCarousel(-1);
  });

  loadLibrary();
})();
