# FinDee

FinDee is a lightweight **type-ahead find** extension for Chrome.

You just start typing on any page and FinDee “locks on” to matching text like a radar ping:
- **HUD** shows your current query + match status
- **Safe highlight overlay** (does not edit the page DOM)
- **Next/prev navigation**
- **Draggable HUD** with saved position
- **Settings panel** (keybindings, highlight style, behavior)
- **Czech-friendly** by default: diacritics-insensitive search (ě = e, č = c, …)

---

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`FinDee/`)

---

## How to use

- Type any letters on a page → FinDee starts searching immediately
- **Enter** = next match
- **Shift+Enter** = previous match
- **Esc** = clear query / hide highlight
- **F2** = open settings

Optional:
- **n / N** navigation (next / prev) can be enabled in settings  
  (FinDee tries not to steal your “n” while you’re actively typing.)

---

## Notes / Design goals

- No page edits for highlighting: FinDee draws an overlay on top of the page.
- No network, no tracking, no accounts.

---

## Files

- `manifest.json` – Chrome extension manifest (MV3)
- `content.js` – content script (FinDee logic + HUD + overlay + settings)
- `icons/` – extension icons
- `BKP/` – source icon backups

---

## License

TBD (MIT recommended).
