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
    angleIndex: 0, dragX: null, dragOffset: 0,
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

  function openStage(tooth) {
    state.staged = tooth;
    state.angles = [...(tooth.top || []).map(path => ({ path, surface: "Top" })),
                    ...(tooth.bottom || []).map(path => ({ path, surface: "Bottom" }))];
    state.angleIndex = 0;
    state.dragOffset = 0;
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
    renderCarousel();
    loadAngleImages();
    preloadAngles(tooth);
  }

  function closeStage() {
    stage.classList.add("hidden");
    document.body.style.overflow = "";
    state.staged = null;
    if (state.activeType) catalogView.classList.remove("hidden");
  }

  function wrappedDistance(index, center, length) {
    let d = index - center;
    if (d > length / 2) d -= length;
    if (d < -length / 2) d += length;
    return d;
  }

  function renderCarousel() {
    const orbit = $("carouselOrbit");
    orbit.replaceChildren();
    const angles = state.angles;
    if (!angles.length) {
      const empty = document.createElement("div");
      empty.className = "angle-slide";
      empty.style.transform = "translate(-50%,-50%)";
      empty.innerHTML = '<span class="angle-placeholder">No angle images available</span>';
      orbit.append(empty);
      $("surfaceIndicator").textContent = "NO ANGLES";
      $("anglePosition").textContent = "— / —";
      $("angleDots").replaceChildren();
      return;
    }
    const length = angles.length;
    const width = $("carouselWindow").clientWidth || 700;
    angles.forEach((angle, index) => {
      const distance = wrappedDistance(index, state.angleIndex, length) - state.dragOffset;
      if (Math.abs(distance) > 3.2) return;
      const abs = Math.abs(distance);
      const slide = document.createElement("div");
      slide.className = "angle-slide";
      const x = distance * Math.min(170, width * .235);
      const scale = Math.max(.68, 1 - abs * .095);
      slide.style.transform = `translate(calc(-50% + ${x}px), -50%) scale(${scale})`;
      slide.style.zIndex = String(20 - Math.round(abs * 4));
      slide.style.opacity = String(Math.max(.16, 1 - abs * .23));
      slide.style.filter = `blur(${Math.min(7, abs * 2.1)}px)`;
      const img = document.createElement("img");
      img.alt = `${state.staged.name}, ${angle.surface.toLowerCase()} angle ${index + 1}`;
      img.draggable = false;
      img.dataset.anglePath = angle.path;
      const known = state.display.get(angle.path);
      if (known) { img.src = known; img.dataset.loaded = "true"; }
      slide.append(img);
      orbit.append(slide);
    });
    const current = angles[state.angleIndex];
    $("surfaceIndicator").textContent = `${current.surface.toUpperCase()} VIEW`;
    $("anglePosition").textContent = `${String(state.angleIndex + 1).padStart(2, "0")} / ${String(length).padStart(2, "0")}`;
    $("angleDots").replaceChildren(...angles.map((_, i) => {
      const dot = document.createElement("span");
      if (i === state.angleIndex) dot.classList.add("active");
      return dot;
    }));
  }

  function loadAngleImages() {
    if (!state.staged) return;
    $("carouselOrbit").querySelectorAll("img[data-angle-path]").forEach((img) => {
      if (img.dataset.loaded === "true") return;
      loadImage(img, img.dataset.anglePath, state.staged.modified);
    });
  }

  // Loads the remaining angles one at a time so dragging stays smooth.
  async function preloadAngles(tooth) {
    for (const angle of state.angles.slice()) {
      if (state.staged !== tooth) return;
      if (state.display.has(angle.path)) continue;
      await new Promise((resolve) => {
        const img = new Image();
        loadImage(img, angle.path, tooth.modified, null, resolve);
      });
      if (state.staged === tooth && state.dragX === null) renderCarousel();
    }
  }

  function moveCarousel(delta) {
    if (!state.angles.length) return;
    const len = state.angles.length;
    state.angleIndex = ((state.angleIndex + delta) % len + len) % len;
    state.dragOffset = 0;
    renderCarousel();
    loadAngleImages();
  }

  const carouselWindow = $("carouselWindow");
  carouselWindow.addEventListener("pointerdown", (event) => {
    if (!state.angles.length) return;
    state.dragX = event.clientX;
    state.dragOffset = 0;
    carouselWindow.classList.add("dragging");
    carouselWindow.setPointerCapture(event.pointerId);
  });
  carouselWindow.addEventListener("pointermove", (event) => {
    if (state.dragX === null || !state.angles.length) return;
    const dx = event.clientX - state.dragX;
    const step = Math.max(75, carouselWindow.clientWidth * .22);
    state.dragOffset = Math.max(-.95, Math.min(.95, -dx / step));
    renderCarousel();
  });
  function finishDrag(event) {
    if (state.dragX === null) return;
    const dx = event.clientX - state.dragX;
    const step = Math.max(75, carouselWindow.clientWidth * .22);
    const steps = Math.round(Math.abs(dx) / step);
    if (Math.abs(dx) > 22) moveCarousel(dx < 0 ? Math.max(1, steps) : -Math.max(1, steps));
    else { state.dragOffset = 0; renderCarousel(); }
    state.dragX = null;
    carouselWindow.classList.remove("dragging");
    loadAngleImages();
  }
  carouselWindow.addEventListener("pointerup", finishDrag);
  carouselWindow.addEventListener("pointercancel", finishDrag);
  window.addEventListener("resize", () => { if (!stage.classList.contains("hidden")) renderCarousel(); });

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
