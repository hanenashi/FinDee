(() => {
  // =========================
  // FinDee v0.3.4 (MV3)
  // - Type-ahead find with safe overlay highlight (no DOM edits)
  // - Draggable HUD + saved position (robust)
  // - In-page Settings modal (default F2)
  // - NEW: Diacritics-insensitive search (default ON)
  //   e.g. typing "e" finds "ě", "é" (Czech-friendly)
  // =========================

  const OVERLAY_Z = 2147483647;
  const STORAGE_KEY = "__findee_settings_v1";
  const NAV_IDLE_MS = 300;

  const DEFAULTS = {
    resetMs: 900,
    maxBuffer: 80,
    smoothScroll: true,

    // NEW
    foldDiacritics: true,

    hud: {
      opacity: 0.92,
      fontSize: 12,
      corner: 8
    },
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
      backspaceEditsQuery: true,
      nKeysNavigate: true
    },
    hudPos: null // { left: number, top: number } or null => default bottom-right
  };

  // ---------- Settings state ----------
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
    } catch {
      S = structuredClone(DEFAULTS);
    }
  }

  async function saveSettings() {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: S }); } catch {}
  }

  // ---------- Diacritics folding ----------
  // Works great for Czech (ěščřžýáíéóúůďťň etc).
  // Note: Some languages have letters that fold into multiple chars (æ -> ae),
  // not a Czech problem, but that would break exact index mapping.
  function foldDiacritics(s) {
    return String(s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
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

  // ---------- Runtime search state ----------
  let buf = "";
  let lastTypeAt = 0;
  let lastMatchRange = null;

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
        <div style="font-weight:600;opacity:0.95;">FinDee:</div>
        <div id="__findee_q" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48vw;"></div>
      </div>
      <div id="__findee_s" style="margin-top:4px;opacity:0.75;"></div>
      <div id="__findee_hint" style="margin-top:6px;opacity:0.45;font-size:11px;">
        drag title • ${S.keys.toggleSettings} settings
      </div>
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
      maxWidth: "70vw",
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

  function showHud(query, status) {
    ensureHud();
    hudEl.querySelector("#__findee_q").textContent = query || "";
    hudEl.querySelector("#__findee_s").textContent = status || "";

    const hint = hudEl.querySelector("#__findee_hint");
    if (hint) hint.textContent = `drag title • ${S.keys.toggleSettings} settings`;

    hudEl.style.opacity = "1";
    hudEl.style.transform = "translateY(0)";

    if (hudHideTimer) clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (!buf) hideHud();
    }, 1200);
  }

  function hideHud() {
    if (!hudEl) return;
    hudEl.style.opacity = "0";
    hudEl.style.transform = "translateY(6px)";
  }

  // ---------- Draggable HUD (robust) ----------
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

  // ---------- Safe highlight overlay ----------
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

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(560px, 92vw)",
      background: "rgba(20,20,20,0.96)",
      color: "#eee",
      borderRadius: "14px",
      boxShadow: "0 10px 40px rgba(0,0,0,0.45)",
      padding: "14px 14px 12px",
      font: "13px/1.35 -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    });

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="font-weight:700;font-size:14px;">FinDee settings</div>
        <button id="__findee_close" style="${btnCss()}">Close</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="${cardCss()}">
          <div style="font-weight:650;margin-bottom:8px;">Behavior</div>
          ${rowNum("Reset after pause (ms)", "__findee_resetMs", S.resetMs, 100, 5000, 50)}
          ${rowNum("Max buffer", "__findee_maxBuffer", S.maxBuffer, 10, 200, 1)}
          ${rowChk("Smooth scroll", "__findee_smoothScroll", S.smoothScroll)}
          ${rowChk("Ignore diacritics (ě= e, č= c)", "__findee_fold", S.foldDiacritics)}
          ${rowChk("Backspace edits query", "__findee_backspace", S.keys.backspaceEditsQuery)}
          ${rowChk("n/N navigate (next/prev)", "__findee_nkeys", S.keys.nKeysNavigate)}
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:650;margin-bottom:8px;">HUD</div>
          ${rowNum("Font size (px)", "__findee_hudFont", S.hud.fontSize, 9, 22, 1)}
          ${rowNum("Corner radius", "__findee_hudCorner", S.hud.corner, 0, 20, 1)}
          ${rowNum("Opacity (0.1–1.0)", "__findee_hudOpacity", S.hud.opacity, 0.1, 1.0, 0.01)}
          <div style="margin-top:8px;">
            <button id="__findee_resetHudPos" style="${btnCss()}">Reset HUD position</button>
          </div>
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:650;margin-bottom:8px;">Highlight</div>
          ${rowColor("Outline color", "__findee_outHex", S.highlight.outlineHex)}
          ${rowNum("Outline alpha (0–1)", "__findee_outA", S.highlight.outlineAlpha, 0, 1, 0.01)}
          ${rowNum("Outline width", "__findee_outW", S.highlight.outlineWidth, 1, 6, 1)}
          <div style="height:8px;"></div>
          ${rowColor("Fill color", "__findee_fillHex", S.highlight.fillHex)}
          ${rowNum("Fill alpha (0–1)", "__findee_fillA", S.highlight.fillAlpha, 0, 1, 0.01)}
          ${rowNum("Corner radius", "__findee_hiCorner", S.highlight.corner, 0, 12, 1)}
        </div>

        <div style="${cardCss()}">
          <div style="font-weight:650;margin-bottom:8px;">Keys</div>
          ${rowKey("Toggle settings", "__findee_k_toggle", S.keys.toggleSettings)}
          ${rowKey("Clear", "__findee_k_clear", S.keys.clear)}
          ${rowKey("Next match", "__findee_k_next", S.keys.next)}
          ${rowKey("Prev match", "__findee_k_prev", S.keys.prev)}
          <div style="opacity:.65;margin-top:6px;">
            Format: Shift+Enter, Ctrl+Shift+F, F2, Escape...
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button id="__findee_defaults" style="${btnCss()}">Defaults</button>
        <button id="__findee_save" style="${btnCss(true)}">Save</button>
      </div>
    `;

    modalEl.appendChild(panel);
    document.documentElement.appendChild(modalEl);

    modalEl.addEventListener("mousedown", (e) => {
      if (e.target === modalEl) closeModal();
    });

    panel.querySelector("#__findee_close").addEventListener("click", closeModal);

    panel.querySelector("#__findee_defaults").addEventListener("click", () => {
      S = structuredClone(DEFAULTS);
      saveSettings().then(() => {
        applyAfterSettingsChange();
        rebuildModal();
      });
    });

    panel.querySelector("#__findee_resetHudPos").addEventListener("click", async () => {
      S.hudPos = null;
      await saveSettings();
      ensureHud();
      applyHudPositionFromSettings();
    });

    panel.querySelector("#__findee_save").addEventListener("click", async () => {
      readModalIntoSettings();
      await saveSettings();
      applyAfterSettingsChange();
      closeModal();
    });

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

  function rowNum(label, id, val, min, max, step) {
    return row(label,
      `<input id="${id}" type="number" value="${val}"
        min="${min}" max="${max}" step="${step}"
        style="width:140px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#eee;border-radius:10px;padding:6px 8px;">`
    );
  }

  function rowChk(label, id, checked) {
    return row(label,
      `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input id="${id}" type="checkbox" ${checked ? "checked" : ""}>
      </label>`
    );
  }

  function rowColor(label, id, val) {
    const safe = /^#[0-9a-f]{6}$/i.test(val) ? val : "#ffcc00";
    return row(label,
      `<input id="${id}" type="color" value="${safe}"
        style="width:46px;height:30px;background:transparent;border:none;cursor:pointer;">`
    );
  }

  function rowKey(label, id, val) {
    return row(label,
      `<input id="${id}" type="text" value="${escapeHtml(val)}"
        style="width:180px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#eee;border-radius:10px;padding:6px 8px;">`
    );
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function rebuildModal() {
    if (!modalEl) return;
    const open = modalOpen;
    modalEl.remove();
    modalEl = null;
    ensureModal();
    if (open) openModal();
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

  function readModalIntoSettings() {
    const g = (id) => modalEl.querySelector(`#${id}`);

    const resetMs = Number(g("__findee_resetMs").value);
    const maxBuffer = Number(g("__findee_maxBuffer").value);

    S.resetMs = clamp(isFinite(resetMs) ? resetMs : DEFAULTS.resetMs, 100, 5000);
    S.maxBuffer = clamp(isFinite(maxBuffer) ? maxBuffer : DEFAULTS.maxBuffer, 10, 200);
    S.smoothScroll = !!g("__findee_smoothScroll").checked;

    // NEW
    S.foldDiacritics = !!g("__findee_fold").checked;

    S.keys.backspaceEditsQuery = !!g("__findee_backspace").checked;
    S.keys.nKeysNavigate = !!g("__findee_nkeys").checked;

    S.hud.fontSize = clamp(Number(g("__findee_hudFont").value), 9, 22);
    S.hud.corner = clamp(Number(g("__findee_hudCorner").value), 0, 20);
    S.hud.opacity = clamp(Number(g("__findee_hudOpacity").value), 0.1, 1);

    S.highlight.outlineHex = g("__findee_outHex").value;
    S.highlight.outlineAlpha = clamp(Number(g("__findee_outA").value), 0, 1);
    S.highlight.outlineWidth = clamp(Number(g("__findee_outW").value), 1, 6);

    S.highlight.fillHex = g("__findee_fillHex").value;
    S.highlight.fillAlpha = clamp(Number(g("__findee_fillA").value), 0, 1);
    S.highlight.corner = clamp(Number(g("__findee_hiCorner").value), 0, 12);

    S.keys.toggleSettings = g("__findee_k_toggle").value.trim() || DEFAULTS.keys.toggleSettings;
    S.keys.clear = g("__findee_k_clear").value.trim() || DEFAULTS.keys.clear;
    S.keys.next = g("__findee_k_next").value.trim() || DEFAULTS.keys.next;
    S.keys.prev = g("__findee_k_prev").value.trim() || DEFAULTS.keys.prev;
  }

  function applyAfterSettingsChange() {
    if (hudEl) {
      applyHudStyle();
      applyHudPositionFromSettings();
      const hint = hudEl.querySelector("#__findee_hint");
      if (hint) hint.textContent = `drag title • ${S.keys.toggleSettings} settings`;
    }
    if (lastMatchRange) scheduleOverlayRefresh();
  }

  // ---------- Helpers ----------
  function isEditableTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (t.isContentEditable) return true;
    return !!t.closest?.('[contenteditable="true"]');
  }

  function getVisibleTextNodes(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;

        const tag = el.tagName.toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) return NodeFilter.FILTER_REJECT;

        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;

        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function findNext(query, backwards = false) {
    if (!query) return null;

    const qRaw = String(query);
    const q = (S.foldDiacritics ? foldDiacritics(qRaw) : qRaw).toLowerCase();

    const nodes = getVisibleTextNodes();
    if (!nodes.length) return null;

    let startIdx = 0;
    let startOffset = 0;

    if (lastMatchRange && lastMatchRange.startContainer) {
      const c = lastMatchRange.startContainer;
      const idx = nodes.indexOf(c);
      if (idx >= 0) {
        startIdx = idx;
        startOffset = backwards ? lastMatchRange.startOffset : lastMatchRange.endOffset;
      }
    }

    function nodeHay(text) {
      const t = S.foldDiacritics ? foldDiacritics(text) : text;
      return t.toLowerCase();
    }

    function forward() {
      for (let i = startIdx; i < nodes.length; i++) {
        const text = nodes[i].nodeValue;
        const hay = nodeHay(text);
        const from = (i === startIdx) ? clamp(startOffset, 0, hay.length) : 0;
        const pos = hay.indexOf(q, from);
        if (pos !== -1) return { node: nodes[i], pos };
      }
      for (let i = 0; i < startIdx; i++) {
        const text = nodes[i].nodeValue;
        const hay = nodeHay(text);
        const pos = hay.indexOf(q, 0);
        if (pos !== -1) return { node: nodes[i], pos };
      }
      return null;
    }

    function backward() {
      for (let i = startIdx; i >= 0; i--) {
        const text = nodes[i].nodeValue;
        const hay = nodeHay(text);
        const to = (i === startIdx) ? clamp(startOffset, 0, hay.length) : hay.length;
        const slice = hay.slice(0, to);
        const pos = slice.lastIndexOf(q);
        if (pos !== -1) return { node: nodes[i], pos };
      }
      for (let i = nodes.length - 1; i > startIdx; i--) {
        const text = nodes[i].nodeValue;
        const hay = nodeHay(text);
        const pos = hay.lastIndexOf(q);
        if (pos !== -1) return { node: nodes[i], pos };
      }
      return null;
    }

    const hit = backwards ? backward() : forward();
    if (!hit) return null;

    const range = document.createRange();
    range.setStart(hit.node, hit.pos);
    range.setEnd(hit.node, hit.pos + qRaw.length); // qRaw length == folded length for Czech letters
    return range;
  }

  function scrollToRange(range) {
    const rect = range.getBoundingClientRect();
    const y = rect.top + window.scrollY - Math.max(80, window.innerHeight * 0.2);
    window.scrollTo({ top: y, behavior: S.smoothScroll ? "smooth" : "auto" });
  }

  function doSearch(backwards = false) {
    if (!buf) {
      lastMatchRange = null;
      clearOverlay();
      hideHud();
      return;
    }

    const r = findNext(buf, backwards);
    if (!r) {
      showHud(buf, "no match");
      lastMatchRange = null;
      clearOverlay();
      return;
    }

    lastMatchRange = r;
    showHud(buf, backwards ? "match (prev)" : "match");
    scrollToRange(r);
    try { drawRangeOverlay(r); } catch {}
  }

  function clearAll() {
    buf = "";
    lastTypeAt = 0;
    lastMatchRange = null;
    clearOverlay();
    hideHud();
  }

  const mo = new MutationObserver(() => {
    if (lastMatchRange) scheduleOverlayRefresh();
  });

  // ---------- Main key handling ----------
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;

    const now = Date.now();

    if (!isEditableTarget(e.target) && matchCombo(e, S.keys.toggleSettings)) {
      e.preventDefault();
      modalOpen ? closeModal() : openModal();
      return;
    }

    if (modalOpen) {
      if (matchCombo(e, "Escape")) {
        e.preventDefault();
        closeModal();
      }
      return;
    }

    if (!isEditableTarget(e.target) && matchCombo(e, S.keys.clear)) {
      clearAll();
      return;
    }

    if (!isEditableTarget(e.target) && buf) {
      if (matchCombo(e, S.keys.next)) {
        e.preventDefault();
        doSearch(false);
        return;
      }
      if (matchCombo(e, S.keys.prev)) {
        e.preventDefault();
        doSearch(true);
        return;
      }
    }

    if (isEditableTarget(e.target)) return;

    if (S.keys.nKeysNavigate && buf && (e.key === "n" || e.key === "N") &&
        !e.ctrlKey && !e.metaKey && !e.altKey &&
        (now - lastTypeAt) > NAV_IDLE_MS) {
      e.preventDefault();
      doSearch(e.key === "N");
      return;
    }

    if (S.keys.backspaceEditsQuery && e.key === "Backspace") {
      if (buf) {
        e.preventDefault();
        buf = buf.slice(0, -1);
        doSearch(false);
      }
      return;
    }

    if (e.key.length === 1 && !e.repeat) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (now - lastTypeAt > S.resetMs) {
        buf = "";
        lastMatchRange = null;
        clearOverlay();
      }
      lastTypeAt = now;

      buf += e.key;
      if (buf.length > S.maxBuffer) buf = buf.slice(-S.maxBuffer);

      doSearch(false);
    }
  }, true);

  // ---------- Boot ----------
  (async () => {
    await loadSettings();
    applyAfterSettingsChange();
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  })();
})();
