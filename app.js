/* RECTOoth — manifest-driven static catalogue */
(() => {
  "use strict";

  const TYPE_INFO = {
    i: { label: "Incisor", plural: "Incisors" },
    c: { label: "Canine", plural: "Canines" },
    p: { label: "Premolar", plural: "Premolars" },
    m: { label: "Molar", plural: "Molars" }
  };

  const $ = (id) => document.getElementById(id);
  const state = {
    manifest: null, activeType: null, staged: null, angles: [],
    angleIndex: 0, dragX: null, dragOffset: 0, converted: new Map(),
    imageObservers: null, toastTimer: null
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

  function imageUrl(relativePath, modified) {
    if (!relativePath) return "";
    const version = Number(modified || (state.manifest && state.manifest.version) || 0);
    return `Library/${relativePath}?v=${encodeURIComponent(version)}`;
  }

  function supportsHeicNative() {
    // Test the browser's native decoder with a tiny HEIC data URL.
    // If this browser cannot decode it, the normal image-error path invokes heic2any.
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      img.onload = () => finish(img.naturalWidth > 0);
      img.onerror = () => finish(false);
      img.src = "data:image/heic;base64,AAAAHGZ0eXBtaWYxaGVpYwAAAAxtaWYxbWlhZgAA";
      setTimeout(() => finish(false), 700);
    });
  }

  let nativeHeic = false;
  supportsHeicNative().then((supported) => { nativeHeic = supported; });

  async function getDisplayUrl(path, modified) {
    const original = imageUrl(path, modified);
    if (!path || !/\.heic(?:\?|$)/i.test(path) || nativeHeic) return original;
    const cacheKey = `${path}|${modified || state.manifest.version}`;
    if (state.converted.has(cacheKey)) return state.converted.get(cacheKey);
    if (!window.heic2any) throw new Error("HEIC decoder has not loaded");
    const response = await fetch(original);
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    const blob = await response.blob();
    const converted = await window.heic2any({ blob, toType: "image/jpeg", quality: 0.88 });
    const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
    const objectUrl = URL.createObjectURL(jpegBlob);
    state.converted.set(cacheKey, objectUrl);
    return objectUrl;
  }

  function loadImage(img, path, modified, placeholder) {
    if (!path) {
      img.removeAttribute("src");
      if (placeholder) placeholder.textContent = "Image unavailable";
      return;
    }
    img.dataset.path = path;
    img.dataset.modified = String(modified || "");
    img.dataset.loaded = "false";
    img.src = imageUrl(path, modified);
    img.onerror = async () => {
      if (img.dataset.fallbackTried === "true") {
        if (placeholder) placeholder.textContent = "Preview unavailable";
        return;
      }
      if (!/\.heic(?:\?|$)/i.test(path)) {
        if (placeholder) placeholder.textContent = "Preview unavailable";
        return;
      }
      img.dataset.fallbackTried = "true";
      try {
        const url = await getDisplayUrl(path, modified);
        img.src = url;
      } catch (error) {
        console.warn("Could not decode HEIC image:", path, error);
        if (placeholder) placeholder.textContent = "HEIC preview unavailable";
      }
    };
    img.onload = () => {
      img.dataset.loaded = "true";
      if (placeholder) placeholder.textContent = "";
    };
  }

  function createImageElement(path, modified, alt, className) {
    const img = document.createElement("img");
    img.alt = alt || "";
    if (className) img.className = className;
    if (path) loadImage(img, path, modified);
    return img;
  }

  function observeLazyImages(root) {
    if (!("IntersectionObserver" in window)) {
      root.querySelectorAll("img[data-path]").forEach((img) => loadImage(img, img.dataset.path, img.dataset.modified));
      return;
    }
    if (!state.imageObservers) {
      state.imageObservers = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const img = entry.target;
          observer.unobserve(img);
          const path = img.dataset.path;
          const modified = Number(img.dataset.modified) || undefined;
          // First attempt the exact manifest URL. HEIC conversion happens only after a native-load failure.
          loadImage(img, path, modified);
        });
      }, { rootMargin: "180px" });
    }
    root.querySelectorAll("img[data-lazy='true']").forEach((img) => state.imageObservers.observe(img));
  }

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
    img.loading = "lazy";
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
      card.addEventListener("click", () => openCatalog(letter), { once: true });
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
      .sort((a,b) => a.number - b.number);
    const sold = all.filter(t => t.status === "sold_copy")
      .sort((a,b) => a.number - b.number || (a.romanIndex || 0) - (b.romanIndex || 0));
    $("catalogSubtitle").textContent = `${main.filter(t => t.status === "available").length} available specimens`;
    $("catalogTotal").textContent = `${main.length} ${main.length === 1 ? "piece" : "pieces"}`;
    const grid = $("toothGrid");
    grid.replaceChildren(...main.map(makeToothCard));
    $("emptyState").classList.toggle("hidden", main.length !== 0);
    const soldSection = $("soldSection");
    soldSection.classList.toggle("hidden", sold.length === 0);
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
    thumb.onerror = null;
    if (tooth.thumbnail) loadImage(thumb, tooth.thumbnail, tooth.modified);
    else { thumb.removeAttribute("src"); }
    stage.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    renderCarousel();
    loadAngleImages();
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
      slide.append(img);
      orbit.append(slide);
    });
    const current = angles[state.angleIndex];
    $("surfaceIndicator").textContent = `${current.surface.toUpperCase()} VIEW`;
    $("anglePosition").textContent = `${String(state.angleIndex + 1).padStart(2,"0")} / ${String(length).padStart(2,"0")}`;
    const dots = $("angleDots");
    dots.replaceChildren(...angles.map((_,i) => {
      const dot = document.createElement("span");
      if (i === state.angleIndex) dot.classList.add("active");
      return dot;
    }));
  }

  function loadAngleImages() {
    const slides = $("carouselOrbit").querySelectorAll("img[data-angle-path]");
    slides.forEach((img) => {
      const angle = state.angles.find(a => a.path === img.dataset.anglePath);
      if (!angle || img.dataset.loaded === "true") return;
      img.dataset.loaded = "true";
      loadImage(img, angle.path, state.staged.modified);
    });
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

  async function loadManifest() {
    $("totalCount").textContent = "Loading library…";
    try {
      const response = await fetch(`Library/manifest.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`manifest request returned ${response.status}`);
      const manifest = await response.json();
      if (!manifest || !Array.isArray(manifest.teeth)) throw new Error("manifest does not contain a teeth array");
      if (Number(manifest.schema) > 1) {
        showToast(`Library schema ${manifest.schema} is newer than this site supports.`);
      } else if (Number(manifest.schema) !== 1) {
        throw new Error(`unsupported library schema: ${manifest.schema}`);
      }
      state.manifest = manifest;
      // Each refresh is a complete snapshot. No data is merged with previous state.
      state.converted.forEach(url => URL.revokeObjectURL(url));
      state.converted.clear();
      renderHome();
      if (state.activeType) openCatalog(state.activeType);
    } catch (error) {
      console.error(error);
      $("totalCount").textContent = "Library unavailable";
      showToast("Could not load Library/manifest.json. Check the repo folder and file name.");
      $("typeGrid").querySelectorAll(".type-count").forEach(el => { el.textContent = "Library unavailable"; });
    }
  }

  $("backHome").addEventListener("click", returnHome);
  $("homeBrand").addEventListener("click", (event) => { event.preventDefault(); returnHome(); });
  $("closeStage").addEventListener("click", closeStage);
  $("stageBackdrop").addEventListener("click", closeStage);
  $("refreshButton").addEventListener("click", loadManifest);
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

  loadManifest();
})();
