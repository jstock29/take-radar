import { createColorPicker } from "./color-picker.js";

const { ext, normalizeList, parseColor, toHex8, toCss, highlightStyle, MAX_BORDER_WIDTH } =
  globalThis.TakeRadar;

const listsEl = document.getElementById("lists");
const statusEl = document.getElementById("status");
const importFile = document.getElementById("importFile");

let lists = [];

// --- Saving ----------------------------------------------------------------

let saveTimer = null;
let statusTimer = null;

const showStatus = (text, { fade = false } = {}) => {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.classList.add("visible");
  if (fade) statusTimer = setTimeout(() => statusEl.classList.remove("visible"), 1200);
};

// Save shortly after the last edit; the popup can close at any moment, so
// there's no separate Save button to forget.
const scheduleSave = () => {
  showStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
};

const save = async () => {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await ext.storage.local.set({ lists });
    showStatus("Saved", { fade: true });
  } catch (err) {
    showStatus(`Couldn't save: ${err?.message ?? err}`);
  }
};

// Flush a pending save if the popup is closing.
window.addEventListener("pagehide", () => saveTimer && save());

// --- Helpers ---------------------------------------------------------------

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const icon = (path, size = 12) => {
  const span = el("span", { className: "icon" });
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 12 12" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return span;
};
const CHEVRON = "M4.5 2.5 8 6l-3.5 3.5";
const CROSS = "M3 3l6 6M9 3l-6 6";

const parseNames = (text) =>
  text
    .split(/[\n,]/)
    .map((n) => n.trim().replace(/^"(.*)"$/, "$1").trim())
    .filter(Boolean);

const applyHighlight = (node, list) => {
  node.style.cssText = "";
  highlightStyle(list).forEach(([prop, value]) => node.style.setProperty(prop, value));
};

const withAlpha = (hex8, a) => toHex8({ ...parseColor(hex8), a });

// The list's "main" color: the fill, unless the fill is see-through.
const baseColor = (list) => {
  const fill = parseColor(list.fill);
  return fill.a > 0.05 ? list.fill : list.border;
};

// One-click looks built from the list's current color.
const PRESETS = [
  { label: "Solid", apply: (c) => ({ fill: withAlpha(c, 1), borderWidth: 0 }) },
  { label: "Tint", apply: (c) => ({ fill: withAlpha(c, 0.3), borderWidth: 0 }) },
  { label: "Box", apply: (c) => ({ fill: withAlpha(c, 0), border: withAlpha(c, 1), borderWidth: 2 }) },
  { label: "Box + tint", apply: (c) => ({ fill: withAlpha(c, 0.15), border: withAlpha(c, 1), borderWidth: 1 }) },
];

// Only one color picker is open at a time across all lists.
let closeOpenPicker = null;

// --- One list card -----------------------------------------------------------

function renderList(list, { open = false } = {}) {
  const card = el("section", { className: open ? "list open" : "list" });
  const setOpen = (value) => {
    card.classList.toggle("open", value);
    toggle.ariaExpanded = String(value);
    if (!value && closeOpenPicker?.card === card) closeOpenPicker();
  };

  // Header ------------------------------------------------------------------

  const chip = el("button", {
    type: "button",
    className: "chip",
    title: "Highlight style",
    textContent: "Aa",
  });
  chip.addEventListener("click", () => setOpen(true));

  const name = el("input", {
    type: "text",
    className: "list-name",
    value: list.name,
    placeholder: "List name",
    ariaLabel: "List name",
  });
  name.addEventListener("input", () => {
    list.name = name.value;
    scheduleSave();
  });

  const count = el("span", { className: "count" });
  const updateCount = () =>
    (count.textContent = `${list.names.length} name${list.names.length === 1 ? "" : "s"}`);

  const toggle = el("button", {
    type: "button",
    className: "icon-btn toggle",
    title: "Edit style and names",
    ariaExpanded: String(open),
  }, icon(CHEVRON));
  toggle.addEventListener("click", () => setOpen(!card.classList.contains("open")));

  // Two-step delete instead of confirm(): Safari's extension popover doesn't
  // allow modal dialogs, and it's less jarring everywhere else.
  const del = el("button", {
    type: "button",
    className: "icon-btn delete",
    title: "Delete list",
  }, icon(CROSS));
  let armTimer = null;
  const disarm = () => {
    clearTimeout(armTimer);
    del.classList.remove("armed");
    del.replaceChildren(icon(CROSS));
  };
  del.addEventListener("click", () => {
    if (!del.classList.contains("armed")) {
      del.classList.add("armed");
      del.textContent = "Delete?";
      armTimer = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armTimer);
    if (closeOpenPicker?.card === card) closeOpenPicker();
    lists = lists.filter((l) => l !== list);
    card.remove();
    renderEmptyState();
    scheduleSave();
  });
  del.addEventListener("blur", disarm);

  const header = el("div", { className: "list-header" }, chip, name, count, toggle, del);

  // Style -----------------------------------------------------------------------

  const sample = el("span", { className: "sample", textContent: "Jane Q. Example" });
  const preview = el(
    "div",
    { className: "preview" },
    "A recent op-ed by ",
    sample,
    " argued…",
  );

  const colorRow = (key, labelText) => {
    const swatch = el("span", { className: "swatch-fill" });
    const value = el("span", { className: "color-value" });
    const button = el(
      "button",
      { type: "button", className: "color-btn", ariaExpanded: "false" },
      el("span", { className: "swatch" }, swatch),
      el("span", { className: "color-label", textContent: labelText }),
      value,
    );
    const slot = el("div", { className: "picker-slot" });

    const sync = () => {
      swatch.style.background = toCss(list[key]);
      const c = parseColor(list[key]);
      const alpha = c.a < 1 ? ` · ${Math.round(c.a * 100)}%` : "";
      value.textContent = c.a === 0 ? "None" : list[key].slice(0, 7) + alpha;
    };

    let picker = null;
    const close = () => {
      slot.replaceChildren();
      button.ariaExpanded = "false";
      button.classList.remove("active");
      closeOpenPicker = null;
    };
    button.addEventListener("click", () => {
      const wasOpen = closeOpenPicker?.button === button;
      closeOpenPicker?.();
      if (wasOpen) return;
      picker = createColorPicker({
        value: list[key],
        label: labelText,
        onInput: (hex8) => {
          list[key] = hex8;
          // Picking a border color only makes sense if there's a border.
          if (key === "border" && !list.borderWidth && parseColor(hex8).a > 0) {
            list.borderWidth = 2;
          }
          refreshStyle();
          scheduleSave();
        },
      });
      slot.replaceChildren(picker.el);
      button.ariaExpanded = "true";
      button.classList.add("active");
      closeOpenPicker = Object.assign(close, { card, button });
      slot.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    return {
      row: el("div", { className: "color-row" }, button),
      slot,
      sync,
      setPicker: (v) => picker?.setValue(v),
    };
  };

  const fillRow = colorRow("fill", "Fill");
  const borderRow = colorRow("border", "Border");

  const widthButtons = [];
  const widthControl = el("div", { className: "segmented", role: "radiogroup", ariaLabel: "Border width" });
  for (let w = 0; w <= MAX_BORDER_WIDTH; w++) {
    const b = el("button", {
      type: "button",
      role: "radio",
      textContent: w === 0 ? "None" : `${w}px`,
    });
    b.addEventListener("click", () => {
      list.borderWidth = w;
      refreshStyle();
      scheduleSave();
    });
    widthButtons.push(b);
    widthControl.append(b);
  }
  borderRow.row.append(widthControl);

  const presets = el("div", { className: "presets" });
  const presetRenders = PRESETS.map((preset) => {
    const b = el("button", { type: "button", className: "preset" });
    const demo = el("span", { className: "preset-demo", textContent: preset.label });
    b.append(demo);
    b.addEventListener("click", () => {
      Object.assign(list, preset.apply(baseColor(list)));
      refreshStyle({ syncPickers: true });
      scheduleSave();
    });
    presets.append(b);
    return () => applyHighlight(demo, { ...list, ...preset.apply(baseColor(list)) });
  });

  function refreshStyle({ syncPickers = false } = {}) {
    applyHighlight(chip, list);
    applyHighlight(sample, list);
    fillRow.sync();
    borderRow.sync();
    widthButtons.forEach((b, w) => (b.ariaChecked = String(list.borderWidth === w)));
    presetRenders.forEach((render) => render());
    if (syncPickers) {
      fillRow.setPicker(list.fill);
      borderRow.setPicker(list.border);
    }
  }

  // Names -----------------------------------------------------------------------

  const textarea = el("textarea", {
    placeholder: "One name or phrase per line",
    value: list.names.join("\n"),
    spellcheck: false,
    ariaLabel: "Names",
  });
  textarea.addEventListener("input", () => {
    list.names = textarea.value
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
    updateCount();
    scheduleSave();
  });

  const body = el(
    "div",
    { className: "list-body" },
    preview,
    el("div", { className: "section-label", textContent: "Style" }),
    presets,
    fillRow.row,
    fillRow.slot,
    borderRow.row,
    borderRow.slot,
    el("div", { className: "section-label", textContent: "Names" }),
    textarea,
  );

  card.append(header, body);
  updateCount();
  refreshStyle();
  return card;
}

// --- Page ---------------------------------------------------------------------

function renderEmptyState() {
  if (lists.length) {
    listsEl.querySelector(".empty")?.remove();
  } else if (!listsEl.querySelector(".empty")) {
    listsEl.append(el("div", { className: "empty", textContent: "No lists yet." }));
  }
}

function addList(partial) {
  const list = normalizeList(partial);
  lists.push(list);
  const card = renderList(list, { open: true });
  listsEl.append(card);
  renderEmptyState();
  card.scrollIntoView({ block: "nearest" });
  scheduleSave();
  return card;
}

const isPopup = () => window.innerWidth < 500;

document.getElementById("addListBtn").addEventListener("click", () => {
  addList({ name: "New list" }).querySelector(".list-name").select();
});

document.getElementById("openTabBtn").addEventListener("click", async () => {
  await save();
  await ext.runtime.openOptionsPage();
  window.close();
});

// A file dialog steals focus from the popup. Chrome keeps the popup open for
// it, but Safari and Firefox close it, so on those we import from a tab.
document.getElementById("importBtn").addEventListener("click", async () => {
  if (isPopup() && location.protocol !== "chrome-extension:") {
    await save();
    await ext.runtime.openOptionsPage();
    window.close();
    return;
  }
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (!file) return;
  addList({
    name: file.name.replace(/\.[^.]+$/, ""),
    names: parseNames(await file.text()),
  });
  importFile.value = "";
});

// Clicking outside a color picker closes it.
document.addEventListener("pointerdown", (e) => {
  if (!closeOpenPicker) return;
  if (e.target.closest(".picker-slot, .color-btn, .preset, .segmented")) return;
  closeOpenPicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && closeOpenPicker) {
    const { button } = closeOpenPicker;
    closeOpenPicker();
    button.focus();
    e.preventDefault();
  }
});

ext.storage.local.get("lists").then((data) => {
  lists = (Array.isArray(data?.lists) ? data.lists : []).map(normalizeList);
  lists.forEach((list) => listsEl.append(renderList(list)));
  renderEmptyState();
});
