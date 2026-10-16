import { createColorPicker } from "./color-picker.js";

const {
  ext,
  normalizeList,
  normalizeSettings,
  parseColor,
  parseListText,
  fetchList,
  toHex8,
  toCss,
  highlightStyle,
  combinedHighlightStyle,
  MAX_BORDER_WIDTH,
  STARTERS,
} = globalThis.TakeRadar;

const listsEl = document.getElementById("lists");
const statusEl = document.getElementById("status");
const importFile = document.getElementById("importFile");

let lists = [];
let settings = normalizeSettings();
// list id -> function that re-renders a card's synced names and status
const cardUpdaters = new Map();

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
  const updateCount = () => {
    const n = list.names.length;
    count.textContent = list.enabled === false ? "Hidden" : `${n} name${n === 1 ? "" : "s"}`;
    card.classList.toggle("disabled", list.enabled === false);
  };

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
    cardUpdaters.delete(list.id);
    card.remove();
    renderEmptyState();
    renderStarters();
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
    placeholder: "One name per line. Add a note after a |, e.g.\nJane Doe | former campaign spokeswoman",
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

  // Lists synced from a URL are read-only here; the source is the truth.
  const syncInfo = el("div", { className: "sync-info" });
  const renderSync = () => {
    textarea.readOnly = Boolean(list.source);
    textarea.classList.toggle("readonly", Boolean(list.source));
    if (!list.source) {
      syncInfo.replaceChildren();
      syncInfo.hidden = true;
      return;
    }
    const { url, updatedAt, error } = list.source;
    const where = el("a", { href: url, target: "_blank", rel: "noreferrer", textContent: shortUrl(url) });
    const when = updatedAt ? `updated ${timeAgo(updatedAt)}` : "not refreshed yet";
    const refresh = el("button", { type: "button", className: "link-btn", textContent: "Refresh" });
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      refresh.textContent = "Refreshing…";
      await save();
      await ext.runtime.sendMessage({ type: "refresh-lists", ids: [list.id] }).catch(() => {});
    });
    const unlink = el("button", { type: "button", className: "link-btn", textContent: "Stop syncing" });
    unlink.title = "Keep these names and edit them here instead";
    unlink.addEventListener("click", () => {
      delete list.source;
      renderSync();
      scheduleSave();
    });
    syncInfo.hidden = false;
    syncInfo.replaceChildren(
      el("div", {}, "Synced from ", where, ` · ${when}`),
      ...(error ? [el("div", { className: "sync-error", textContent: `Last refresh failed: ${error}` })] : []),
      el("div", { className: "sync-actions" }, refresh, unlink),
    );
  };

  // Called when the background script refreshes this list's names.
  cardUpdaters.set(list.id, () => {
    if (document.activeElement !== textarea) textarea.value = list.names.join("\n");
    updateCount();
    renderSync();
  });

  // Options ---------------------------------------------------------------------

  const checkbox = (labelText, hint, checked, onChange) => {
    const input = el("input", { type: "checkbox", checked });
    input.addEventListener("change", () => onChange(input.checked));
    return el(
      "label",
      { className: "check" },
      input,
      el("span", {}, el("span", { textContent: labelText }), el("span", { className: "check-hint", textContent: hint })),
    );
  };

  const options = el(
    "div",
    { className: "options" },
    checkbox("Highlight this list", "Turn off to hide it without deleting it.", list.enabled !== false, (on) => {
      if (on) delete list.enabled;
      else list.enabled = false;
      updateCount();
      scheduleSave();
    }),
    checkbox(
      "Also highlight later mentions by last name",
      "After a full name appears on a page, e.g. \u201cMs. Okafor said\u201d",
      list.followups !== false,
      (on) => {
        if (on) delete list.followups;
        else list.followups = false;
        scheduleSave();
      },
    ),
  );

  const body = el(
    "div",
    { className: "list-body" },
    options,
    preview,
    el("div", { className: "section-label", textContent: "Style" }),
    presets,
    fillRow.row,
    fillRow.slot,
    borderRow.row,
    borderRow.slot,
    el("div", { className: "section-label", textContent: "Names" }),
    syncInfo,
    textarea,
  );

  card.append(header, body);
  updateCount();
  refreshStyle();
  renderSync();
  return card;
}

// --- Page ---------------------------------------------------------------------

const shortUrl = (url) => {
  try {
    const u = new URL(url);
    const file = u.pathname.split("/").filter(Boolean).pop();
    return file ? `${u.hostname}/…/${file}` : u.hostname;
  } catch {
    return url;
  }
};

const timeAgo = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

function renderEmptyState() {
  if (lists.length) {
    listsEl.querySelector(".empty")?.remove();
  } else if (!listsEl.querySelector(".empty")) {
    listsEl.append(
      el("div", {
        className: "empty",
        textContent: "No lists yet. Add a starter list below, or make your own.",
      }),
    );
  }
}

function addList(partial, { open = true } = {}) {
  const list = normalizeList(partial);
  lists.push(list);
  const card = renderList(list, { open });
  listsEl.append(card);
  renderEmptyState();
  renderStarters();
  card.scrollIntoView({ block: "nearest" });
  scheduleSave();
  return card;
}

// --- Starter lists ---------------------------------------------------------------

const startersEl = document.getElementById("starters");

const hasStarter = (starter) =>
  lists.some((l) => l.starterId === starter.id || (starter.id === "harpers" && l.id === "default"));

function renderStarters() {
  const available = STARTERS.filter((s) => !hasStarter(s));
  startersEl.hidden = !available.length;
  startersEl.replaceChildren(
    el("div", { className: "section-label", textContent: "Starter lists" }),
    ...available.map((starter) => {
      const add = el("button", { type: "button", className: "starter-add", textContent: "Add" });
      add.addEventListener("click", async () => {
        add.disabled = true;
        // Start from the bundled copy, then sync from the repo for updates.
        const res = await fetch(ext.runtime.getURL(starter.file));
        addList(
          {
            name: starter.name,
            starterId: starter.id,
            ...starter.style,
            names: parseListText(await res.text()),
            source: { url: starter.url, updatedAt: Date.now() },
          },
          { open: false },
        );
        await save();
        ext.runtime.sendMessage({ type: "refresh-lists", ids: [lists.at(-1).id] }).catch(() => {});
      });
      return el(
        "div",
        { className: "starter" },
        el(
          "div",
          { className: "starter-text" },
          el("div", { className: "starter-name", textContent: starter.name }),
          el("div", { className: "starter-desc", textContent: starter.description }),
        ),
        add,
      );
    }),
  );
}

// --- Adding lists ---------------------------------------------------------------

const isPopup = () => window.innerWidth < 500;

const openInTab = async () => {
  await save();
  await ext.runtime.openOptionsPage();
  window.close();
};

document.getElementById("addListBtn").addEventListener("click", () => {
  addList({ name: "New list" }).querySelector(".list-name").select();
});

document.getElementById("openTabBtn").addEventListener("click", openInTab);

// A file dialog steals focus from the popup. Chrome keeps the popup open for
// it, but Safari and Firefox close it, so on those we import from a tab.
document.getElementById("importBtn").addEventListener("click", () => {
  if (isPopup() && location.protocol !== "chrome-extension:") return openInTab();
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (!file) return;
  addList({
    name: file.name.replace(/\.[^.]+$/, ""),
    names: parseListText(await file.text(), { csv: /\.csv$/i.test(file.name) }),
  });
  importFile.value = "";
});

// Subscribing to a URL --------------------------------------------------------------

const urlForm = document.getElementById("urlForm");
const urlInput = document.getElementById("urlInput");
const urlError = document.getElementById("urlError");
const urlSubmit = urlForm.querySelector("button[type=submit]");

document.getElementById("urlBtn").addEventListener("click", () => {
  urlForm.hidden = !urlForm.hidden;
  if (!urlForm.hidden) urlInput.focus();
});
document.getElementById("urlCancel").addEventListener("click", () => {
  urlForm.hidden = true;
  urlError.textContent = "";
});

// "republican-operatives.txt" -> "Republican operatives"
const nameFromUrl = (url) => {
  const file = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  const base = decodeURIComponent(file).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return base ? base[0].toUpperCase() + base.slice(1) : new URL(url).hostname;
};

urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  urlError.textContent = "";
  let url;
  try {
    url = new URL(urlInput.value.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    urlError.textContent = "Enter a full http:// or https:// address.";
    return;
  }

  urlSubmit.disabled = true;
  urlSubmit.textContent = "Loading…";
  const done = () => {
    urlSubmit.disabled = false;
    urlSubmit.textContent = "Add";
  };

  let names;
  try {
    names = await fetchList(url.href);
  } catch (err) {
    if (!(err instanceof TypeError)) {
      urlError.textContent = `Couldn't load that list (${err.message}).`;
      return done();
    }
    // A network-level failure is usually the site not allowing cross-origin
    // reads; with permission for that site the extension can read it anyway.
    // Save the list first: on some browsers the permission prompt closes
    // this popup, and the background script finishes the job once granted.
    addList({ name: nameFromUrl(url.href), names: [], source: { url: url.href } }, { open: false });
    await save();
    const granted = await ext.permissions
      .request({ origins: [`${url.origin}/*`] })
      .catch(() => false);
    if (!granted) {
      urlError.textContent = `Couldn't read ${url.hostname} without permission. The list was added but is empty; allow access and press Refresh on it.`;
      return done();
    }
    await ext.runtime.sendMessage({ type: "refresh-lists", ids: [lists.at(-1).id] }).catch(() => {});
    urlForm.hidden = true;
    urlInput.value = "";
    return done();
  }

  if (!names.length) {
    urlError.textContent = "That address loaded, but no names were found in it.";
    return done();
  }
  addList({
    name: nameFromUrl(url.href),
    names,
    source: { url: url.href, updatedAt: Date.now() },
  });
  urlForm.hidden = true;
  urlInput.value = "";
  done();
});

// --- On/off -------------------------------------------------------------------------

const powerBtn = document.getElementById("powerBtn");
const siteRow = document.getElementById("siteRow");
let currentHost = null;
let shortcut = "";

const saveSettings = () => ext.storage.local.set({ settings }).catch(() => {});

function renderPower() {
  powerBtn.ariaChecked = String(!settings.paused);
  powerBtn.title = settings.paused ? "Resume highlighting" : "Pause highlighting everywhere";
  powerBtn.querySelector(".switch-label").textContent = settings.paused ? "Paused" : "On";
  document.body.classList.toggle("paused", settings.paused);

  if (settings.paused) {
    siteRow.hidden = false;
    siteRow.replaceChildren(
      el("span", { textContent: `Paused everywhere${shortcut ? ` · ${shortcut} to resume` : ""}` }),
    );
    return;
  }
  siteRow.hidden = !currentHost;
  if (!currentHost) return;

  const off = settings.disabledHosts.includes(currentHost);
  const button = el("button", {
    type: "button",
    className: "link-btn",
    textContent: off ? "Turn back on" : "Turn off for this site",
  });
  button.addEventListener("click", () => {
    settings.disabledHosts = off
      ? settings.disabledHosts.filter((h) => h !== currentHost)
      : [...settings.disabledHosts, currentHost];
    saveSettings();
    renderPower();
  });
  siteRow.replaceChildren(
    el("span", {}, off ? "Off on " : "On for ", el("b", { textContent: currentHost })),
    button,
  );
}

powerBtn.addEventListener("click", () => {
  settings.paused = !settings.paused;
  saveSettings();
  renderPower();
});

// --- On this page -----------------------------------------------------------------------

const onPageEl = document.getElementById("onPage");
let currentTabId = null;

const MAX_PEOPLE_SHOWN = 12;

async function renderOnPage() {
  if (currentTabId == null || settings.paused) {
    onPageEl.hidden = true;
    return;
  }
  const people = await ext.runtime
    .sendMessage({ type: "page-summary", tabId: currentTabId })
    .catch(() => []);
  const byId = new Map(lists.map((l) => [l.id, l]));
  const known = (people ?? []).filter((p) => p.lists.some((id) => byId.has(id)));
  onPageEl.hidden = !known.length;
  if (!known.length) return;

  const rows = known.slice(0, MAX_PEOPLE_SHOWN).map((person) => {
    const onLists = person.lists.map((id) => byId.get(id)).filter(Boolean);
    const chip = el("span", { className: "person-name", textContent: person.name });
    combinedHighlightStyle(onLists).forEach(([prop, value]) => chip.style.setProperty(prop, value));
    const button = el(
      "button",
      { type: "button", className: "person", title: "Show on the page" },
      chip,
      el("span", { className: "person-lists", textContent: onLists.map((l) => l.name).join(", ") }),
      el("span", { className: "person-count", textContent: person.count > 1 ? `\u00d7${person.count}` : "" }),
    );
    // Each click scrolls the page to the next mention of this person.
    button.addEventListener("click", () => {
      ext.tabs.sendMessage(currentTabId, { type: "reveal", name: person.name }).catch(() => {});
    });
    return button;
  });
  const more = known.length - MAX_PEOPLE_SHOWN;
  onPageEl.replaceChildren(
    el("div", { className: "section-label", textContent: `On this page \u00b7 ${known.length}` }),
    ...rows,
    ...(more > 0 ? [el("div", { className: "person-more", textContent: `and ${more} more` })] : []),
  );
}

// --- Pickers, keys and loading --------------------------------------------------------

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

// Pick up changes made elsewhere: names refreshed by the background script,
// or the pause shortcut pressed while this page is open.
// Pages re-highlight after any list or setting change; give them a moment,
// then refresh "On this page".
let onPageTimer = null;
const refreshOnPageSoon = () => {
  clearTimeout(onPageTimer);
  onPageTimer = setTimeout(renderOnPage, 600);
};

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.lists || changes.settings) refreshOnPageSoon();
  if (changes.settings) {
    settings = normalizeSettings(changes.settings.newValue);
    renderPower();
  }
  if (changes.lists) {
    for (const stored of (changes.lists.newValue ?? []).map(normalizeList)) {
      const mine = lists.find((l) => l.id === stored.id);
      if (!mine?.source || !stored.source) continue;
      if (JSON.stringify([mine.names, mine.source]) === JSON.stringify([stored.names, stored.source])) {
        continue;
      }
      mine.names = stored.names;
      mine.source = stored.source;
      cardUpdaters.get(mine.id)?.();
    }
  }
});

(async () => {
  const [data, tabs, commands] = await Promise.all([
    ext.storage.local.get(["lists", "settings"]),
    ext.tabs?.query({ active: true, currentWindow: true }).catch(() => []) ?? [],
    ext.commands?.getAll?.().catch(() => []) ?? [],
  ]);
  lists = (Array.isArray(data?.lists) ? data.lists : []).map(normalizeList);
  settings = normalizeSettings(data?.settings);

  // The page the popup was opened over (unknown when opened as a tab).
  const url = tabs?.[0]?.url;
  if (url && /^https?:/.test(url)) {
    currentHost = new URL(url).hostname;
    currentTabId = tabs[0].id;
  }
  shortcut = commands?.find((c) => c.name === "toggle-pause")?.shortcut ?? "";

  lists.forEach((list) => listsEl.append(renderList(list)));
  renderEmptyState();
  renderStarters();
  renderPower();
  renderOnPage();
})();
