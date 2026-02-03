(() => {
  // =========================
  // FinDee v0.4.5 (MV3)
  // - v0.4.4 base
  // - FIX: diacritics folding mapping -> boundary map (RegExp indices are code-unit offsets)
  //   This fixes "highlight shifted left", especially for 1-char queries.
  // =========================

  const OVERLAY_Z = 2147483647;
  const STORAGE_KEY = "__findee_settings_v1";
  const NAV_IDLE_MS = 300;
  const CACHE_INVALIDATE_DEBOUNCE_MS = 120;

  // ---- Performance guardrails ----
  const REBUILD_BUDGET_MS = 12;
  const MAX_TEXT_NODES = 4500;
  const MAX_MATCHES = 2500;
  const MAX_TOTAL_CHARS = 900000;

  // ---------- Defaults ----------
  const DEFAULTS = {
    activationMode: "direct", // "direct" | "slash"
    activateTextKey: "/",
    activateLinksKey: "'",
    smoothScroll: true,
    resetMs: 900,
    maxBuffer: 80,

    foldDiacritics: true,
    smartCase: true,
    whitespaceFlexible: true,

    nKeysNavigate: true,

    blacklistHosts: [],

    hud: { opacity: 0.92, fontSize: 12, corner: 8 },

    highlight: {
      outlineHex: "#ffcc00",
      outlineAlpha: 0.95,
      fillHex: "#ffcc00",
      fillAlpha: 0.20,
      outlineWidth: 2,
      corner: 3
    },

    keys: {
      toggleSettings: "F2",
      clear: "Escape",
      next: "Enter",
      prev: "Shift+Enter",
      openLink: "Ctrl+Enter",
      openLinkNewTab: "Ctrl+Shift+Enter",
      backspaceEditsQuery: true
    },

    hudPos: null
  };

  // ---------- State ----------
  let S = structuredClone(DEFAULTS);

  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

  function deepMerge(dst, src) {
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) {
        if (!dst[k] || typeof dst[k] !== "object") dst[k] = {};
        deepMerge(dst[k], src[k]);
      } else {
        dst[k] = src[k];
      }
    }
    return dst;
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY]);
      const saved = data?.[STORAGE_KEY];
      if (saved && typeof saved === "object") {
        S = deepMerge(structuredClone(DEFAULTS), saved);
      } else {
        S = structuredClone(DEFAULTS);
      }
      sanitizeSettings();
    } catch {
      S = structuredClone(DEFAULTS);
      sanitizeSettings();
    }
  }

  async function saveSettings() {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: S }); } catch {}
  }

  function sanitizeSettings() {
    if (S.activationMode !== "direct" && S.activationMode !== "slash") S.activationMode = "direct";
    S.activateTextKey = safeSingleChar(S.activateTextKey, "/");
    S.activateLinksKey = safeSingleChar(S.activateLinksKey, "'");
    if (!Array.isArray(S.blacklistHosts)) S.blacklistHosts = [];
    S.blacklistHosts = Array.from(new Set(S.blacklistHosts.map(x => String(x || "").trim()).filter(Boolean)));

    if (!S.keys || typeof S.keys !== "object") S.keys = structuredClone(DEFAULTS.keys);
    S.keys.toggleSettings = String(S.keys.toggleSettings || DEFAULTS.keys.toggleSettings);
    S.keys.clear = String(S.keys.clear || DEFAULTS.keys.clear);
    S.keys.next = String(S.keys.next || DEFAULTS.keys.next);
    S.keys.prev = String(S.keys.prev || DEFAULTS.keys.prev);
    S.keys.openLink = String(S.keys.openLink || DEFAULTS.keys.openLink);
    S.keys.openLinkNewTab = String(S.keys.openLinkNewTab || DEFAULTS.keys.openLinkNewTab);
    if (typeof S.keys.backspaceEditsQuery !== "boolean") S.keys.backspaceEditsQuery = !!DEFAULTS.keys.backspaceEditsQuery;
  }

  function safeSingleChar(v, fallback) {
    const s = String(v ?? "").trim();
    if (!s) return fallback;
    return Array.from(s)[0];
  }

  // ---------- Diacritics folding ----------
  function foldDiacritics(s) {
    return String(s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  // FIX: fold with BOUNDARY map (folded boundary index -> raw code-unit index)
  // bmap length = foldedText.length + 1
  function foldWithBoundaryMap(raw, caseSensitive) {
    const s = String(raw ?? "");
    let out = "";
    const bmap = [0]; // boundary 0 -> raw index 0

    let rawIndex = 0; // raw code-unit index
    for (const ch of s) {
      const chLen = ch.length; // 1 or 2 code units
      const decomp = ch.normalize("NFD");

      // Keep only non-diacritic code points from decomposition
      let kept = "";
      for (const d of decomp) {
        if (/[\u0300-\u036f]/.test(d)) continue;
        kept += d;
      }

      if (kept) {
        if (!caseSensitive) kept = kept.toLowerCase();
        out += kept;

        // For each code-unit boundary inside kept, map to a boundary inside the original char span
        // NOTE: rawIndex..rawIndex+chLen is the span of the original grapheme (1 or 2 code units).
        for (let j = 1; j <= kept.length; j++) {
          bmap.push(rawIndex + Math.min(chLen, j));
        }
      }

      rawIndex += chLen;
    }

    // Ensure final boundary exists and equals raw length
    if (bmap.length !== out.length + 1) {
      // normalize defensively (should not happen)
      while (bmap.length < out.length + 1) bmap.push(s.length);
      bmap.length = out.length + 1;
    }
    bmap[bmap.length - 1] = s.length;

    return { text: out, bmap };
  }

  // ---------- Key combo parsing ----------
  function matchCombo(e, comboStr) {
    if (!comboStr) return false;
    const parts = comboStr.split("+").map(p => p.trim()).filter(Boolean);
    const want = {
      ctrl: parts.some(p => /^ctrl$/i.test(p)),
      shift: parts.some(p => /^shift$/i.test(p)),
      alt: parts.some(p => /^alt$/i.test(p)),
      meta: parts.some(p => /^(meta|cmd|win)$/i.test(p)),
      key: parts.find(p => !/^(ctrl|shift|alt|meta|cmd|win)$/i.test(p)) || ""
    };

    const ek = (e.key || "");
    const wk = want.key;

    const keyMatch =
      wk === "" ? false :
      wk.length === 1 ? ek.toLowerCase() === wk.toLowerCase() :
      ek.toLowerCase() === wk.toLowerCase();

    return (
      keyMatch &&
      !!e.ctrlKey === want.ctrl &&
      !!e.shiftKey === want.shift &&
      !!e.altKey === want.alt &&
      !!e.metaKey === want.meta
    );
  }

  // ---------- Blacklist ----------
  function currentHost() {
    try { return (location && location.hostname) ? location.hostname : ""; }
    catch { return ""; }
  }

  function isBlacklistedHost(host) {
    if (!host) return false;
    const h = host.toLowerCase();
    for (const raw of S.blacklistHosts) {
      const s = String(raw || "").trim().toLowerCase();
      if (!s) continue;
      if (s.startsWith(".")) {
        const suf = s.slice(1);
        if (!suf) continue;
        if (h === suf || h.endsWith("." + suf)) return true;
      } else {
        if (h === s) return true;
      }
    }
    return false;
  }

  // ---------- Runtime search state ----------
  let mode = "idle"; // "idle" | "text" | "links"
  let buf = "";
  let lastTypeAt = 0;

  let cacheDirty = true;
  let cacheQueryKey = "";
  let cacheModeKey = "";
  let matches = [];
  let currentIndex = -1;
  let lastMatchRange = null;

  // performance status
  let capped = false;
  let cappedWhy = "";

  function clearCache() {
    cacheDirty = true;
    matches = [];
    currentIndex = -1;
    capped = false;
    cappedWhy = "";
  }

  // ---------- HUD ----------
  let hudEl = null;
  let hudHideTimer = null;

  function ensureHud() {
    if (hudEl) return hudEl;

    hudEl = document.createElement("div");
    hudEl.id = "__findee_hud";
    applyHudStyle();

    hudEl.innerHTML = `
      <div id="__findee_handle" style="display:flex;gap:8px;align-items:baseline;cursor:grab;user-select:none;">
        <div style="font-weight:700;opacity:0.95;">FinDee</div>
        <div id="__findee_mode" style="opacity:0.70;font-weight:700;font-size:11px;letter-spacing:0.08em;"></div>
        <div style="flex:1"></div>
        <div id="__findee_count" style="opacity:0.70;font-weight:700;font-size:11px;letter-spacing:0.04em;"></div>
      </div>
      <div id="__findee_q" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:64vw;"></div>
      <div id="__findee_s" style="margin-top:3px;opacity:0.75;"></div>
      <div id="__findee_hint" style="margin-top:6px;opacity:0.45;font-size:11px;"></div>
    `;

    document.documentElement.appendChild(hudEl);
    applyHudPositionFromSettings();
    wireHudDrag();

    return hudEl;
  }

  function applyHudStyle() {
    if (!hudEl) return;
    Object.assign(hudEl.style, {
      position: "fixed",
      zIndex: String(OVERLAY_Z),
      background: `rgba(20,20,20,${clamp(S.hud.opacity, 0.1, 1)})`,
      color: "#eee",
      font: `${clamp(S.hud.fontSize, 9, 22)}px/1.35 -apple-system, Segoe UI, Roboto, Arial, sans-serif`,
      padding: "8px 10px",
      borderRadius: `${clamp(S.hud.corner, 0, 20)}px`,
      boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
      maxWidth: "72vw",
      pointerEvents: "auto",
      opacity: "0",
      transform: "translateY(6px)",
      transition: "opacity 120ms ease, transform 120ms ease"
    });
  }

  function applyHudPositionFromSettings() {
    if (!hudEl) return;
    const pos = S.hudPos;

    hudEl.style.left = "";
    hudEl.style.top = "";
    hudEl.style.right = "";
    hudEl.style.bottom = "";

    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      hudEl.style.left = `${clamp(pos.left, 0, window.innerWidth - 40)}px`;
      hudEl.style.top = `${clamp(pos.top, 0, window.innerHeight - 20)}px`;
    } else {
      hudEl.style.right = "14px";
      hudEl.style.bottom = "14px";
    }
  }

  function hudHintText() {
    const parts = [];
    parts.push(`${S.keys.toggleSettings} settings`);
    if (S.activationMode === "slash") parts.push(`${S.activateTextKey} text`);
    parts.push(`${S.activateLinksKey} links`);
    parts.push(`${S.keys.openLink} open`);
    return parts.join(" • ");
  }

  function showHud() {
    ensureHud();

    const modeLabel = (mode === "links") ? "LINKS" : "TEXT";
    hudEl.querySelector("#__findee_mode").textContent = mode === "idle" ? "" : modeLabel;

    const total = matches.length;
    const n = (total > 0 && currentIndex >= 0) ? (currentIndex + 1) : 0;
    hudEl.querySelector("#__findee_count").textContent = (mode === "idle") ? "" : `${n}/${total}`;

    hudEl.querySelector("#__findee_q").textContent = buf || "";
    hudEl.querySelector("#__findee_s").textContent = statusText();
    hudEl.querySelector("#__findee_hint").textContent = hudHintText();

    hudEl.style.opacity = "1";
    hudEl.style.transform = "translateY(0)";

    if (hudHideTimer) clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (!buf && mode === "idle") hideHud();
    }, 1200);
  }

  function hideHud() {
    if (!hudEl) return;
    hudEl.style.opacity = "0";
    hudEl.style.transform = "translateY(6px)";
  }

  function statusText() {
    if (isBlacklistedHost(currentHost())) return "Disabled on this site";
    if (mode === "idle") return "";
    if (!buf) return "Type to search…";
    if (matches.length === 0) return capped ? "No match (partial scan)" : "No match";
    if (capped) return cappedWhy ? `Match (partial: ${cappedWhy})` : "Match (partial)";
    return "Match";
  }

  // ---------- Draggable HUD ----------
  let drag = {
    active: false,
    started: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    offX: 0,
    offY: 0,
    threshold: 4
  };

  function wireHudDrag() {
    const handle = hudEl.querySelector("#__findee_handle");
    if (!handle) return;

    handle.style.cursor = "grab";
    handle.style.userSelect = "none";
    handle.style.touchAction = "none";

    const onMove = (e) => {
      if (!drag.active || e.pointerId !== drag.pointerId) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;

      if (!drag.started) {
        if (Math.hypot(dx, dy) < drag.threshold) return;
        drag.started = true;

        const r = hudEl.getBoundingClientRect();
        drag.offX = drag.startX - r.left;
        drag.offY = drag.startY - r.top;

        hudEl.style.right = "";
        hudEl.style.bottom = "";
        hudEl.style.transition = "none";
        handle.style.cursor = "grabbing";
      }

      const rNow = hudEl.getBoundingClientRect();
      const w = rNow.width;
      const h = rNow.height;

      let left = e.clientX - drag.offX;
      let top = e.clientY - drag.offY;

      left = clamp(left, 0, window.innerWidth - Math.max(40, w));
      top = clamp(top, 0, window.innerHeight - Math.max(20, h));

      hudEl.style.left = `${left}px`;
      hudEl.style.top = `${top}px`;

      e.preventDefault();
    };

    const endDrag = async (e) => {
      if (!drag.active) return;
      if (e && ("pointerId" in e) && e.pointerId !== drag.pointerId) return;

      drag.active = false;

      hudEl.style.transition = "opacity 120ms ease, transform 120ms ease";
      handle.style.cursor = "grab";

      if (drag.started) {
        const r = hudEl.getBoundingClientRect();
        S.hudPos = { left: Math.round(r.left), top: Math.round(r.top) };
        await saveSettings();
      }

      drag.started = false;
      drag.pointerId = null;

      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
      window.removeEventListener("blur", endDrag, true);
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" && e.button !== 0) return;
      if (e.isPrimary === false) return;

      drag.active = true;
      drag.started = false;
      drag.pointerId = e.pointerId;
      drag.startX = e.clientX;
      drag.startY = e.clientY;

      try { handle.setPointerCapture(e.pointerId); } catch {}

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", endDrag, true);
      window.addEventListener("pointercancel", endDrag, true);
      window.addEventListener("blur", endDrag, true);

      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  window.addEventListener("resize", () => {
    if (!hudEl) return;
    if (S.hudPos) applyHudPositionFromSettings();
  }, true);

  // ---------- Safe overlay highlight ----------
  let overlayRoot = null;

  function ensureOverlayRoot() {
    if (overlayRoot) return overlayRoot;
    overlayRoot = document.createElement("div");
    overlayRoot.id = "__findee_overlay";
    Object.assign(overlayRoot.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      zIndex: String(OVERLAY_Z - 1),
      pointerEvents: "none"
    });
    document.documentElement.appendChild(overlayRoot);
    return overlayRoot;
  }

  function clearOverlay() {
    if (!overlayRoot) return;
    overlayRoot.textContent = "";
  }

  function rgba(hex, a) {
    const h = (hex || "#000000").replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${clamp(a, 0, 1)})`;
  }

  function drawRangeOverlay(range) {
    ensureOverlayRoot();
    clearOverlay();

    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) return;

    const outline = rgba(S.highlight.outlineHex, S.highlight.outlineAlpha);
    const fill = rgba(S.highlight.fillHex, S.highlight.fillAlpha);
    const ow = clamp(S.highlight.outlineWidth, 1, 6);
    const cr = clamp(S.highlight.corner, 0, 12);

    for (const r of rects) {
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "fixed",
        left: `${Math.max(0, r.left)}px`,
        top: `${Math.max(0, r.top)}px`,
        width: `${Math.max(1, r.width)}px`,
        height: `${Math.max(1, r.height)}px`,
        outline: `${ow}px solid ${outline}`,
        background: fill,
        borderRadius: `${cr}px`,
        boxSizing: "border-box"
      });
      overlayRoot.appendChild(box);
    }
  }

  let rafPending = false;
  function scheduleOverlayRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (lastMatchRange) {
        try { drawRangeOverlay(lastMatchRange); } catch {}
      }
    });
  }

  window.addEventListener("scroll", scheduleOverlayRefresh, true);
  window.addEventListener("resize", scheduleOverlayRefresh, true);

  // ---------- Editable detection (Shadow DOM safe) ----------
  function getDeepActiveElement() {
    let a = null;
    try { a = document.activeElement; } catch { a = null; }
    for (let i = 0; i < 20 && a && a.shadowRoot; i++) {
      const inner = a.shadowRoot.activeElement;
      if (!inner || inner === a) break;
      a = inner;
    }
    return a;
  }

  function isEditableElement(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return !!el.closest?.('[contenteditable="true"]');
  }

  function isEditableTarget(t) {
    const active = getDeepActiveElement();
    if (isEditableElement(active)) return true;
    return isEditableElement(t);
  }

  // ---------- Matching helpers ----------
  function isVisibleTextNode(node) {
    const el = node.parentElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return false;

    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;

    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;

    return true;
  }

  function isLinkTextNode(node) {
    const el = node.parentElement;
    if (!el) return false;
    return !!el.closest("a");
  }

  function hasUppercase(s) {
    for (const ch of String(s || "")) {
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      if (lo !== up && ch === up) return true;
    }
    return false;
  }

  function preprocessTextSimple(s, caseSensitive) {
    let t = String(s ?? "");
    if (S.foldDiacritics) t = foldDiacritics(t);
    if (!caseSensitive) t = t.toLowerCase();
    return t;
  }

  function buildQueryRegex(rawQuery, caseSensitive) {
    let q = String(rawQuery ?? "");
    if (S.foldDiacritics) q = foldDiacritics(q);
    if (!caseSensitive) q = q.toLowerCase();

    q = q.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

    if (S.whitespaceFlexible) {
      q = q.replace(/\s+/g, "(?:[\\s\\u00A0]+)");
    }

    return new RegExp(q, "g");
  }

  function computeQueryKey(rawQuery, modeLocal) {
    const caseSensitive = S.smartCase ? hasUppercase(rawQuery) : false;
    let q = preprocessTextSimple(rawQuery, caseSensitive);
    q = q.replace(/\s+/g, " ").trim();
    return `${modeLocal}|${caseSensitive ? "CS" : "CI"}|${S.foldDiacritics ? "FD" : "ND"}|${S.whitespaceFlexible ? "WF" : "NW"}|${q}`;
  }

  // ---------- Rebuild matches (caps + time budget + correct mapping) ----------
  function rebuildMatchesIfNeeded() {
    if (mode === "idle") return;
    if (isBlacklistedHost(currentHost())) return;

    const key = computeQueryKey(buf, mode);
    if (!cacheDirty && cacheQueryKey === key && cacheModeKey === mode) return;

    cacheDirty = false;
    cacheQueryKey = key;
    cacheModeKey = mode;

    matches = [];
    currentIndex = -1;
    lastMatchRange = null;
    capped = false;
    cappedWhy = "";

    if (!buf) return;

    const startT = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const deadline = startT + REBUILD_BUDGET_MS;

    const caseSensitive = S.smartCase ? hasUppercase(buf) : false;
    const re = buildQueryRegex(buf, caseSensitive);

    const root = document.body;
    if (!root) return;

    const wantLinks = (mode === "links");

    let scannedNodes = 0;
    let scannedChars = 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (!isVisibleTextNode(node)) return NodeFilter.FILTER_REJECT;
        if (wantLinks && !isLinkTextNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      scannedNodes++;
      if (scannedNodes > MAX_TEXT_NODES) { capped = true; cappedWhy = "node cap"; break; }

      const raw = node.nodeValue;
      scannedChars += raw.length;
      if (scannedChars > MAX_TOTAL_CHARS) { capped = true; cappedWhy = "size cap"; break; }

      const nowT = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (nowT > deadline) { capped = true; cappedWhy = "time cap"; break; }

      let hay, bmap;
      if (S.foldDiacritics) {
        const r = foldWithBoundaryMap(raw, caseSensitive);
        hay = r.text;
        bmap = r.bmap;
      } else {
        hay = caseSensitive ? String(raw ?? "") : String(raw ?? "").toLowerCase();
        bmap = null;
      }

      re.lastIndex = 0;
      let m;
      while ((m = re.exec(hay)) !== null) {
        const a = m.index;
        const b = a + m[0].length;

        const start = bmap ? bmap[a] : a;
        const end = bmap ? bmap[b] : b;

        if (start < 0 || end < 0 || start >= end) {
          if (re.lastIndex === m.index) re.lastIndex++;
          continue;
        }
        if (end > raw.length) {
          if (re.lastIndex === m.index) re.lastIndex++;
          continue;
        }

        matches.push({ node, start, end });

        if (matches.length >= MAX_MATCHES) {
          capped = true;
          cappedWhy = "match cap";
          break;
        }

        if (re.lastIndex === m.index) re.lastIndex++;
      }

      if (capped && cappedWhy === "match cap") break;
    }

    if (matches.length > 0) {
      const idx = firstMatchInViewport(matches);
      currentIndex = (idx >= 0) ? idx : 0;
    }
  }

  function firstMatchInViewport(list) {
    for (let i = 0; i < list.length; i++) {
      const r = rangeForMatch(list[i]);
      if (!r) continue;
      const rect = r.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const inView =
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth;
      if (inView) return i;
    }
    return -1;
  }

  function rangeForMatch(m) {
    try {
      const r = document.createRange();
      r.setStart(m.node, m.start);
      r.setEnd(m.node, m.end);
      return r;
    } catch {
      return null;
    }
  }

  function scrollToRange(range) {
    const rect = range.getBoundingClientRect();
    const y = rect.top + window.scrollY - Math.max(80, window.innerHeight * 0.2);
    window.scrollTo({ top: y, behavior: S.smoothScroll ? "smooth" : "auto" });
  }

  function selectCurrent() {
    clearOverlay();
    lastMatchRange = null;

    if (mode === "idle") {
      hideHud(); // no idle flash
      return;
    }

    if (!buf) {
      showHud();
      return;
    }

    rebuildMatchesIfNeeded();
    if (matches.length === 0 || currentIndex < 0) {
      showHud();
      return;
    }

    const m = matches[currentIndex];
    const r = rangeForMatch(m);
    if (!r) {
      showHud();
      return;
    }

    lastMatchRange = r;
    try { drawRangeOverlay(r); } catch {}
    scrollToRange(r);
    showHud();
  }

  function nextMatch(dir) {
    if (mode === "idle") return;
    if (!buf) { showHud(); return; }

    rebuildMatchesIfNeeded();
    if (matches.length === 0) { showHud(); return; }

    currentIndex = (currentIndex + dir) % matches.length;
    if (currentIndex < 0) currentIndex += matches.length;
    selectCurrent();
  }

  // ---------- Open link / URL helpers ----------
  function normalizeUrl(u) {
    const s = String(u || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^www\./i.test(s)) return "https://" + s;
    return s;
  }

  function findPlainTextUrlForCurrentMatch() {
    if (mode === "idle" || !buf) return "";

    rebuildMatchesIfNeeded();
    if (matches.length === 0 || currentIndex < 0) return "";

    const m = matches[currentIndex];
    const raw = String(m.node?.nodeValue || "");
    if (!raw) return "";

    const urlRe = /(https?:\/\/[^\s<>"'()\[\]{}]+|www\.[^\s<>"'()\[\]{}]+)/ig;

    let hit = "";
    urlRe.lastIndex = 0;
    let mm;
    while ((mm = urlRe.exec(raw)) !== null) {
      const a = mm.index;
      const b = a + mm[0].length;
      const overlaps = !(b <= m.start || a >= m.end);
      if (!overlaps) continue;
      hit = mm[0];
      break;
    }

    return normalizeUrl(hit);
  }

  function openCurrentLink(newTab) {
    if (mode === "idle" || !buf) return false;

    rebuildMatchesIfNeeded();
    if (matches.length === 0 || currentIndex < 0) return false;

    const m = matches[currentIndex];
    const el = m?.node?.parentElement;

    // 1) Prefer <a>
    if (el) {
      const a = el.closest("a");
      if (a) {
        const hrefAttr = a.getAttribute("href") || "";
        const isJs = /^javascript:/i.test(hrefAttr);

        try {
          if (newTab) {
            if (!isJs && a.href) {
              window.open(a.href, "_blank", "noopener,noreferrer");
            } else {
              a.click();
            }
          } else {
            a.click();
          }
          return true;
        } catch {
          // fall through
        }
      }
    }

    // 2) Plain text URL
    const plainUrl = findPlainTextUrlForCurrentMatch();
    if (plainUrl) {
      try {
        if (newTab) {
          window.open(plainUrl, "_blank", "noopener,noreferrer");
        } else {
          window.location.href = plainUrl;
        }
        return true;
      } catch {}
    }

    return false;
  }

  // ---------- Mode control ----------
  function enterMode(newMode, clearQuery = true) {
    mode = newMode;
    if (clearQuery) buf = "";
    lastTypeAt = 0;
    clearCache();
    clearOverlay();
    lastMatchRange = null;
    showHud();
  }

  function exitMode() {
    mode = "idle";
    buf = "";
    lastTypeAt = 0;
    clearCache();
    clearOverlay();
    lastMatchRange = null;
    hideHud();
  }

  // ---------- DOM mutation invalidation ----------
  let invalidateTimer = null;

  function isFindeeNode(node) {
    try {
      if (!node) return false;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return false;
      return !!el.closest?.("#__findee_hud, #__findee_overlay, #__findee_modal");
    } catch { return false; }
  }

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (isFindeeNode(m.target)) continue;
      if (m.addedNodes && Array.from(m.addedNodes).some(isFindeeNode)) continue;
      if (m.removedNodes && Array.from(m.removedNodes).some(isFindeeNode)) continue;

      if (invalidateTimer) return;
      invalidateTimer = setTimeout(() => {
        invalidateTimer = null;
        cacheDirty = true;
        if (lastMatchRange) scheduleOverlayRefresh();
      }, CACHE_INVALIDATE_DEBOUNCE_MS);
      return;
    }
  });

  // ---------- Settings modal ----------
  let modalEl = null;
  let modalOpen = false;

  function ensureModal() {
    if (modalEl) return modalEl;

    modalEl = document.createElement("div");
    modalEl.id = "__findee_modal";
    Object.assign(modalEl.style, {
      position: "fixed",
      inset: "0",
      zIndex: String(OVERLAY_Z),
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.35)",
      pointerEvents: "auto"
    });

    document.documentElement.appendChild(modalEl);
    rebuildModal();
    return modalEl;
  }

  function btnCss(primary = false) {
    return [
      "border:1px solid rgba(255,255,255,0.18)",
      `background:${primary ? "rgba(255,204,0,0.85)" : "rgba(255,255,255,0.08)"}`,
      `color:${primary ? "#111" : "#eee"}`,
      "padding:7px 10px",
      "border-radius:10px",
      "cursor:pointer"
    ].join(";");
  }

  function cardCss() {
    return [
      "border:1px solid rgba(255,255,255,0.12)",
      "border-radius:12px",
      "padding:10px",
      "background:rgba(255,255,255,0.04)"
    ].join(";");
  }

  function row(label, bodyHtml) {
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0;">
        <div style="opacity:.9;">${label}</div>
        <div>${bodyHtml}</div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function rowNum(label, id, val, min, max, step) {
    return row(label,
      `<input id="${id}" type="number" value="${val}"
        min="${min}" max="${max}" step="${step}"
        style="width:160px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#eee;border-radius:10px;padding:6px 8px;box-sizing:border-box;">`
    );
  }

  function rowChk(label, id, checked) {
    return row(label,
      `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input id="${id}" type="checkbox" ${checked ? "checked" : ""}>
      </label>`
    );
  }

  function rowText(label, id, val, widthPx = 160) {
    return row(label,
      `<input id="${id}" type="text" value="${escapeHtml(val)}"
        style="width:${widthPx}px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#eee;border-radius:10px;padding:6px 8px;box-sizing:border-box;">`
    );
  }

  function rowSelect(label, id, options, selected) {
    const opts = options.map(o => `<option value="${escapeHtml(o.value)}" ${o.value === selected ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    return row(label,
      `<select id="${id}"
        style="width:180px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#eee;border-radius:10px;padding:6px 8px;box-sizing:border-box;">
        ${opts}
      </select>`
    );
  }

  function rowColor(label, id, val) {
    const safe = /^#[0-9a-f]{6}$/i.test(val) ? val : "#ffcc00";
    return row(label,
      `<input id="${id}" type="color" value="${safe}"
        style="width:46px;height:30px;background:transparent;border:none;cursor:pointer;">`
    );
  }

  function downloadText(filename, text) {
    try {
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch {}
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try { window.prompt("Copy this:", text); } catch {}
      return false;
    }
  }

  function rebuildModal() {
    if (!modalEl) return;

    modalEl.textContent = "";

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(720px, 94vw)",
      background: "rgba(20,20,20,0.96)",
      color: "#eee",
      borderRadius: "14px",
      boxShadow: "0 10px 40px rgba(0,0,0,0.45)",
      padding: "14px 14px 12px",
      font: "13px/1.35 -apple-system, Segoe UI, Roboto, Arial, sans-serif",
      maxHeight: "88vh",
      overflow: "auto",
      boxSizing: "border-box"
    });

    const host = currentHost();

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="font-weight:800;font-size:14px;">FinDee settings</div>
        <button id="__findee_close" style="${btnCss()}">Close</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="${cardCss()}">
          <div style="font-weight:750;margin-bottom:8px;">Activation</div>
          ${rowSelect("Mode", "__fd_activationMode", [
            { value: "direct", label: "Direct (type immediately)" },
            { value: "slash",  label: "Slash-to-search (manual start)" }
          ], S.activationMode)}
          ${rowText("Text activation key", "__fd_activateTextKey", S.activateTextKey, 120)}
          ${rowText("Links-only key", "__fd_activateLinksKey", S.activateLinksKey, 120)}
          <div style="opacity:.65;margin-top:6px;">Keys should be 1 character. Examples: / and '</div>
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:750;margin-bottom:8px;">Behavior</div>
          ${rowNum("Reset after pause (ms)", "__fd_resetMs", S.resetMs, 100, 5000, 50)}
          ${rowNum("Max buffer", "__fd_maxBuffer", S.maxBuffer, 10, 200, 1)}
          ${rowChk("Smooth scroll", "__fd_smoothScroll", S.smoothScroll)}
          ${rowChk("Backspace edits query", "__fd_backspace", S.keys.backspaceEditsQuery)}
          ${rowChk("n/N navigate (after idle)", "__fd_nkeys", S.nKeysNavigate)}
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:750;margin-bottom:8px;">Matching</div>
          ${rowChk("Ignore diacritics (ě=e, č=c…)", "__fd_fold", S.foldDiacritics)}
          ${rowChk("Smart case (Uppercase = case-sensitive)", "__fd_smartCase", S.smartCase)}
          ${rowChk("Flexible whitespace (space matches whitespace)", "__fd_wsflex", S.whitespaceFlexible)}
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:750;margin-bottom:8px;">Keys</div>
          ${rowText("Toggle settings", "__fd_k_toggle", S.keys.toggleSettings)}
          ${rowText("Clear (exit search)", "__fd_k_clear", S.keys.clear)}
          ${rowText("Next match", "__fd_k_next", S.keys.next)}
          ${rowText("Prev match", "__fd_k_prev", S.keys.prev)}
          ${rowText("Open link/URL", "__fd_k_open", S.keys.openLink)}
          ${rowText("Open link/URL (new tab)", "__fd_k_openNew", S.keys.openLinkNewTab)}
          <div style="opacity:.65;margin-top:6px;">Format: Shift+Enter, Ctrl+Enter, Ctrl+Shift+Enter, F2…</div>
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:750;margin-bottom:8px;">HUD</div>
          ${rowNum("Font size (px)", "__fd_hudFont", S.hud.fontSize, 9, 22, 1)}
          ${rowNum("Corner radius", "__fd_hudCorner", S.hud.corner, 0, 20, 1)}
          ${rowNum("Opacity (0.1–1.0)", "__fd_hudOpacity", S.hud.opacity, 0.1, 1.0, 0.01)}
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
            <button id="__fd_resetHudPos" style="${btnCss()}">Reset HUD position</button>
          </div>
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:750;margin-bottom:8px;">Highlight</div>
          ${rowColor("Outline color", "__fd_outHex", S.highlight.outlineHex)}
          ${rowNum("Outline alpha (0–1)", "__fd_outA", S.highlight.outlineAlpha, 0, 1, 0.01)}
          ${rowNum("Outline width", "__fd_outW", S.highlight.outlineWidth, 1, 6, 1)}
          <div style="height:8px;"></div>
          ${rowColor("Fill color", "__fd_fillHex", S.highlight.fillHex)}
          ${rowNum("Fill alpha (0–1)", "__fd_fillA", S.highlight.fillAlpha, 0, 1, 0.01)}
          ${rowNum("Corner radius", "__fd_hiCorner", S.highlight.corner, 0, 12, 1)}
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:750;margin-bottom:8px;">Blacklist</div>
          <div style="opacity:.75;margin-bottom:6px;">
            Current host: <span style="font-weight:700;">${escapeHtml(host || "(none)")}</span>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
            <button id="__fd_disableThis" style="${btnCss()}">Disable on this host</button>
            <button id="__fd_enableThis" style="${btnCss()}">Enable on this host</button>
          </div>
          <div style="opacity:.65;margin-bottom:6px;">One host per line. Use ".example.com" to match subdomains.</div>
          <textarea id="__fd_blacklist" rows="6"
            style="display:block;width:100%;max-width:100%;box-sizing:border-box;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);color:#eee;border-radius:10px;padding:8px;resize:vertical;overflow:auto;">${escapeHtml(S.blacklistHosts.join("\n"))}</textarea>
        </div>
      </div>

      <input id="__fd_importFile" type="file" accept="application/json" style="display:none">

      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;flex-wrap:wrap;">
        <div style="opacity:.55;font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span>Tiny support:</span>
          <button id="__fd_support" style="${btnCss()}">Copy email + open PayPal</button>
          <span style="opacity:.8;">hanenashi@gmail.com</span>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          <button id="__fd_export" style="${btnCss()}">Export</button>
          <button id="__fd_import" style="${btnCss()}">Import</button>
          <button id="__fd_defaults" style="${btnCss()}">Defaults</button>
          <button id="__fd_save" style="${btnCss(true)}">Save</button>
        </div>
      </div>
    `;

    modalEl.appendChild(panel);

    modalEl.onmousedown = (e) => {
      if (e.target === modalEl) closeModal();
    };
    panel.querySelector("#__findee_close").onclick = closeModal;

    panel.querySelector("#__fd_resetHudPos").onclick = async () => {
      S.hudPos = null;
      await saveSettings();
      ensureHud();
      applyHudPositionFromSettings();
    };

    panel.querySelector("#__fd_disableThis").onclick = () => {
      const h = currentHost();
      if (!h) return;
      const set = new Set(S.blacklistHosts.map(x => String(x).trim()).filter(Boolean));
      set.add(h);
      panel.querySelector("#__fd_blacklist").value = Array.from(set).sort().join("\n");
    };

    panel.querySelector("#__fd_enableThis").onclick = () => {
      const h = currentHost();
      if (!h) return;
      const set = new Set(S.blacklistHosts.map(x => String(x).trim()).filter(Boolean));
      set.delete(h);
      panel.querySelector("#__fd_blacklist").value = Array.from(set).sort().join("\n");
    };

    panel.querySelector("#__fd_defaults").onclick = () => {
      S = structuredClone(DEFAULTS);
      sanitizeSettings();
      saveSettings().then(() => {
        applyAfterSettingsChange();
        rebuildModal();
      });
    };

    panel.querySelector("#__fd_save").onclick = async () => {
      readModalIntoSettings(panel);
      sanitizeSettings();
      await saveSettings();
      applyAfterSettingsChange();
      closeModal();
    };

    panel.querySelector("#__fd_support").onclick = async () => {
      const email = "hanenashi@gmail.com";
      await copyToClipboard(email);
      try { window.open("https://www.paypal.com/", "_blank", "noopener,noreferrer"); } catch {}
    };

    // Export CURRENT modal values (even if not saved)
    panel.querySelector("#__fd_export").onclick = () => {
      try {
        const tmp = structuredClone(S);
        const old = S;
        S = tmp;

        readModalIntoSettings(panel);
        sanitizeSettings();

        const payload = structuredClone(S);
        S = old;

        downloadText("findee_settings.json", JSON.stringify(payload, null, 2));
      } catch {}
    };

    const fileInput = panel.querySelector("#__fd_importFile");
    panel.querySelector("#__fd_import").onclick = () => {
      try { fileInput.value = ""; fileInput.click(); } catch {}
    };

    fileInput.onchange = async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== "object") throw new Error("bad json");

        S = deepMerge(structuredClone(DEFAULTS), obj);
        sanitizeSettings();
        await saveSettings();
        applyAfterSettingsChange();
        rebuildModal();
      } catch {
        try { alert("Import failed (invalid JSON)."); } catch {}
      }
    };
  }

  function readModalIntoSettings(panel) {
    const g = (id) => panel.querySelector(`#${id}`);

    S.activationMode = g("__fd_activationMode").value;
    S.activateTextKey = safeSingleChar(g("__fd_activateTextKey").value, "/");
    S.activateLinksKey = safeSingleChar(g("__fd_activateLinksKey").value, "'");

    S.resetMs = clamp(Number(g("__fd_resetMs").value), 100, 5000);
    S.maxBuffer = clamp(Number(g("__fd_maxBuffer").value), 10, 200);

    S.smoothScroll = !!g("__fd_smoothScroll").checked;
    S.keys.backspaceEditsQuery = !!g("__fd_backspace").checked;
    S.nKeysNavigate = !!g("__fd_nkeys").checked;

    S.foldDiacritics = !!g("__fd_fold").checked;
    S.smartCase = !!g("__fd_smartCase").checked;
    S.whitespaceFlexible = !!g("__fd_wsflex").checked;

    S.keys.toggleSettings = g("__fd_k_toggle").value.trim() || DEFAULTS.keys.toggleSettings;
    S.keys.clear = g("__fd_k_clear").value.trim() || DEFAULTS.keys.clear;
    S.keys.next = g("__fd_k_next").value.trim() || DEFAULTS.keys.next;
    S.keys.prev = g("__fd_k_prev").value.trim() || DEFAULTS.keys.prev;
    S.keys.openLink = g("__fd_k_open").value.trim() || DEFAULTS.keys.openLink;
    S.keys.openLinkNewTab = g("__fd_k_openNew").value.trim() || DEFAULTS.keys.openLinkNewTab;

    S.hud.fontSize = clamp(Number(g("__fd_hudFont").value), 9, 22);
    S.hud.corner = clamp(Number(g("__fd_hudCorner").value), 0, 20);
    S.hud.opacity = clamp(Number(g("__fd_hudOpacity").value), 0.1, 1);

    S.highlight.outlineHex = g("__fd_outHex").value;
    S.highlight.outlineAlpha = clamp(Number(g("__fd_outA").value), 0, 1);
    S.highlight.outlineWidth = clamp(Number(g("__fd_outW").value), 1, 6);

    S.highlight.fillHex = g("__fd_fillHex").value;
    S.highlight.fillAlpha = clamp(Number(g("__fd_fillA").value), 0, 1);
    S.highlight.corner = clamp(Number(g("__fd_hiCorner").value), 0, 12);

    const bl = g("__fd_blacklist").value.split("\n").map(x => x.trim()).filter(Boolean);
    S.blacklistHosts = Array.from(new Set(bl));
  }

  function openModal() {
    ensureModal();
    modalEl.style.display = "flex";
    modalOpen = true;
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.style.display = "none";
    modalOpen = false;
  }

  function applyAfterSettingsChange() {
    if (hudEl) {
      applyHudStyle();
      applyHudPositionFromSettings();
    }

    clearCache();

    if (isBlacklistedHost(currentHost())) {
      exitMode();
      return;
    }

    // Prevent reload flash
    if (mode === "idle" && !buf) {
      clearOverlay();
      lastMatchRange = null;
      hideHud();
      return;
    }

    selectCurrent();
  }

  // ---------- Key handling ----------
  function handleActivationChars(e) {
    if (e.key.length !== 1) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isBlacklistedHost(currentHost())) return false;

    if (e.key === S.activateLinksKey) {
      e.preventDefault();
      e.stopPropagation();
      enterMode("links", true);
      return true;
    }

    if (S.activationMode === "slash" && mode === "idle" && e.key === S.activateTextKey) {
      e.preventDefault();
      e.stopPropagation();
      enterMode("text", true);
      return true;
    }

    return false;
  }

  function handleTypedChar(e) {
    const now = Date.now();

    if (e.key.length !== 1 || e.repeat) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isBlacklistedHost(currentHost())) return false;

    if (S.activationMode === "slash" && mode === "idle") return false;

    if (S.activationMode === "direct" && mode === "idle") {
      mode = "text";
      buf = "";
      clearCache();
    }

    if (now - lastTypeAt > S.resetMs) {
      buf = "";
      clearCache();
      lastMatchRange = null;
      clearOverlay();
    }

    lastTypeAt = now;

    buf += e.key;
    if (buf.length > S.maxBuffer) buf = buf.slice(-S.maxBuffer);

    clearCache();
    rebuildMatchesIfNeeded();
    selectCurrent();
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  function handleBackspace(e) {
    if (!S.keys.backspaceEditsQuery) return false;
    if (e.key !== "Backspace") return false;
    if (mode === "idle") return false;
    if (!buf) return false;

    buf = buf.slice(0, -1);
    clearCache();
    rebuildMatchesIfNeeded();
    selectCurrent();
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  function handleNavKeys(e) {
    if (mode === "idle") return false;

    // OPEN (href or plain-text URL)
    if (matchCombo(e, S.keys.openLinkNewTab)) {
      e.preventDefault(); e.stopPropagation();
      if (!openCurrentLink(true)) showHud();
      return true;
    }
    if (matchCombo(e, S.keys.openLink)) {
      e.preventDefault(); e.stopPropagation();
      if (!openCurrentLink(false)) showHud();
      return true;
    }

    if (matchCombo(e, S.keys.next)) {
      e.preventDefault(); e.stopPropagation();
      nextMatch(+1);
      return true;
    }
    if (matchCombo(e, S.keys.prev)) {
      e.preventDefault(); e.stopPropagation();
      nextMatch(-1);
      return true;
    }

    if (S.nKeysNavigate && buf && (e.key === "n" || e.key === "N") &&
        !e.ctrlKey && !e.metaKey && !e.altKey &&
        (Date.now() - lastTypeAt) > NAV_IDLE_MS) {
      e.preventDefault(); e.stopPropagation();
      nextMatch(e.key === "N" ? -1 : +1);
      return true;
    }

    return false;
  }

  // Unified clear: Escape always exits mode for both activation modes
  function handleClear(e) {
    if (!matchCombo(e, S.keys.clear)) return false;
    e.preventDefault(); e.stopPropagation();

    if (mode !== "idle") {
      exitMode();
      return true;
    }

    clearOverlay();
    hideHud();
    return true;
  }

  // ---------- Main listener ----------
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;

    if (!isEditableTarget(e.target) && matchCombo(e, S.keys.toggleSettings)) {
      e.preventDefault();
      modalOpen ? closeModal() : openModal();
      return;
    }

    if (modalOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      }
      return;
    }

    if (isEditableTarget(e.target)) return;

    if (handleClear(e)) return;
    if (handleActivationChars(e)) return;

    if (handleNavKeys(e)) return;
    if (handleBackspace(e)) return;

    handleTypedChar(e);
  }, true);

  // Click exits mode (but not when clicking our HUD/modal)
  window.addEventListener("mousedown", (e) => {
    if (modalOpen) return;

    const t = e.target;
    if (t && (t.closest?.("#__findee_hud") || t.closest?.("#__findee_modal"))) return;

    if (mode !== "idle") exitMode();
  }, true);

  // ---------- Boot ----------
  (async () => {
    await loadSettings();
    applyAfterSettingsChange();

    if (document.documentElement) {
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    }
  })();
})();
