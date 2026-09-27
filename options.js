const listsEl = document.getElementById("lists");
const statusEl = document.getElementById("status");
const importFile = document.getElementById("importFile");

const DEFAULT_COLOR = "#ff8c00";

let lists = [];
let saveTimer = null;

const parseNames = (text) =>
  text
    .split(/[\n,]/)
    .map((n) => n.trim())
    .filter(Boolean);

const newList = (name, names = []) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  name,
  color: DEFAULT_COLOR,
  names,
});

const showStatus = (text) => {
  statusEl.textContent = text;
  statusEl.style.opacity = 1;
};

// Save shortly after the last edit; the popup can close at any moment, so
// there's no separate Save button to forget.
const scheduleSave = () => {
  showStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
};

const save = () => {
  saveTimer = null;
  chrome.storage.local.set({ lists }, () => {
    if (chrome.runtime.lastError) {
      showStatus(`Couldn't save: ${chrome.runtime.lastError.message}`);
      return;
    }
    showStatus("Saved");
    setTimeout(() => (statusEl.style.opacity = 0), 1200);
  });
};

// Flush a pending save if the popup is closing.
window.addEventListener("pagehide", () => saveTimer && save());

const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

function renderList(list, { open = false } = {}) {
  const card = el("div", { className: open ? "list open" : "list" });

  const color = el("input", { type: "color", value: list.color, title: "Highlight color" });
  color.addEventListener("input", () => {
    list.color = color.value;
    scheduleSave();
  });

  const name = el("input", {
    type: "text",
    className: "list-name",
    value: list.name,
    placeholder: "List name",
  });
  name.addEventListener("input", () => {
    list.name = name.value;
    scheduleSave();
  });

  const count = el("span", { className: "count" });
  const updateCount = () =>
    (count.textContent = `${list.names.length} name${list.names.length === 1 ? "" : "s"}`);
  updateCount();

  const toggle = el("button", { className: "icon-btn toggle", title: "Edit names" });
  toggle.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  toggle.addEventListener("click", () => card.classList.toggle("open"));

  const del = el("button", { className: "icon-btn delete", textContent: "✕", title: "Delete list" });
  del.addEventListener("click", () => {
    if (!confirm(`Delete "${list.name || "Untitled"}"?`)) return;
    lists = lists.filter((l) => l !== list);
    card.remove();
    renderEmptyState();
    scheduleSave();
  });

  const textarea = el("textarea", {
    placeholder: "One name or phrase per line",
    value: list.names.join("\n"),
    spellcheck: false,
  });
  textarea.addEventListener("input", () => {
    list.names = textarea.value
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
    updateCount();
    scheduleSave();
  });

  const header = el("div", { className: "list-header" });
  header.append(color, name, count, toggle, del);
  const body = el("div", { className: "list-body" });
  body.append(textarea);
  card.append(header, body);
  return card;
}

function renderEmptyState() {
  if (lists.length) {
    listsEl.querySelector(".empty")?.remove();
  } else if (!listsEl.querySelector(".empty")) {
    listsEl.append(el("div", { className: "empty", textContent: "No lists yet." }));
  }
}

function addList(list) {
  lists.push(list);
  const card = renderList(list, { open: true });
  listsEl.append(card);
  renderEmptyState();
  card.scrollIntoView({ block: "nearest" });
  scheduleSave();
  return card;
}

document.getElementById("addListBtn").addEventListener("click", () => {
  addList(newList("New list")).querySelector(".list-name").select();
});

document.getElementById("importBtn").addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (!file) return;
  addList(newList(file.name.replace(/\.[^.]+$/, ""), parseNames(await file.text())));
  importFile.value = "";
});

chrome.storage.local.get("lists", (data) => {
  lists = data.lists || [];
  lists.forEach((list) => listsEl.append(renderList(list)));
  renderEmptyState();
});
