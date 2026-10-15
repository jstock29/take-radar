// Chrome runs this as a service worker and needs the helpers pulled in here;
// Firefox and Safari load them first via manifest "background.scripts".
if (typeof TakeRadar === "undefined" && typeof importScripts === "function") {
  importScripts("shared.js");
}

const { ext, normalizeList, normalizeSettings, fetchList } = TakeRadar;
const action = ext.action ?? ext.browserAction;

// --- Install and upgrade --------------------------------------------------------

// Lists live in storage.local: sync caps each item at 8KB, which a single
// big list easily exceeds.
ext.runtime.onInstalled.addListener(async ({ reason }) => {
  let { lists } = await ext.storage.local.get("lists");
  if (!Array.isArray(lists)) lists = (await legacySyncedLists()) ?? [];

  lists = lists.map(normalizeList);
  // Before 0.5 the Harper's Letter list was installed by default (id
  // "default"); mark it so the starter list shows as already added.
  for (const list of lists) {
    if (list.id === "default" && !list.starterId) list.starterId = "harpers";
  }
  await ext.storage.local.set({ lists });
  scheduleRefresh();

  // Nothing is highlighted until a list exists, so show the lists page.
  if (reason === "install") ext.runtime.openOptionsPage();
});

async function legacySyncedLists() {
  try {
    const { lists } = await ext.storage.sync.get("lists");
    await ext.storage.sync.remove(["lists", "names"]);
    return Array.isArray(lists) ? lists : null;
  } catch {
    // storage.sync can be unavailable (e.g. sync disabled, some Safari setups).
    return null;
  }
}

// --- Lists synced from a URL --------------------------------------------------------

const REFRESH_ALARM = "refresh-lists";
const REFRESH_MINUTES = 12 * 60;

function scheduleRefresh() {
  ext.alarms?.create(REFRESH_ALARM, { delayInMinutes: 1, periodInMinutes: REFRESH_MINUTES });
}
ext.runtime.onStartup?.addListener(scheduleRefresh);
ext.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshLists();
});
// A host permission granted from the popup (which may have closed while the
// prompt was up) means a pending list can now be fetched.
ext.permissions?.onAdded?.addListener(() => refreshLists());

/**
 * Re-fetch lists that have a source URL (all of them, or only `ids`).
 * Returns { [listId]: "ok" | errorMessage }.
 */
async function refreshLists(ids) {
  const { lists: stored = [] } = await ext.storage.local.get("lists");
  const targets = stored
    .map(normalizeList)
    .filter((l) => l.source && (!ids || ids.includes(l.id)));
  if (!targets.length) return {};

  const results = new Map(
    await Promise.all(
      targets.map(async (list) => {
        try {
          const names = await fetchList(list.source.url);
          if (!names.length) throw new Error("The list at that address is empty");
          return [list.id, { names }];
        } catch (err) {
          return [list.id, { error: err?.message || String(err) }];
        }
      }),
    ),
  );

  // Re-read so edits made while the fetches were running aren't lost.
  const { lists: latest = [] } = await ext.storage.local.get("lists");
  const next = latest.map(normalizeList).map((list) => {
    const result = results.get(list.id);
    if (!result || !list.source) return list;
    if (result.error) return { ...list, source: { ...list.source, error: result.error } };
    return {
      ...list,
      names: result.names,
      source: { ...list.source, updatedAt: Date.now(), error: "" },
    };
  });
  await ext.storage.local.set({ lists: next });

  return Object.fromEntries([...results].map(([id, r]) => [id, r.error ?? "ok"]));
}

// --- Match count badge -----------------------------------------------------------

// tabId -> Map(frameId -> { count, off }). Mirrored to storage.session so it
// survives the service worker going to sleep.
const counts = new Map();
let restored = null;

const restoreCounts = () =>
  (restored ??= (async () => {
    try {
      const { badgeCounts } = await ext.storage.session.get("badgeCounts");
      for (const [tabId, frames] of Object.entries(badgeCounts ?? {})) {
        counts.set(Number(tabId), new Map(Object.entries(frames).map(([f, v]) => [Number(f), v])));
      }
    } catch {
      // No storage.session (older browsers): counts just start fresh.
    }
  })());

const persistCounts = () => {
  const plain = Object.fromEntries(
    [...counts].map(([tabId, frames]) => [tabId, Object.fromEntries(frames)]),
  );
  ext.storage.session?.set({ badgeCounts: plain }).catch?.(() => {});
};

function paintBadge(tabId) {
  const frames = counts.get(tabId);
  const all = [...(frames?.values() ?? [])];
  const off = frames?.get(0)?.off ?? all.some((f) => f.off);
  const total = all.reduce((sum, f) => sum + (f.off ? 0 : f.count), 0);
  const text = off ? "off" : total ? (total > 999 ? "999+" : String(total)) : "";
  const catchAll = (p) => p?.catch?.(() => {}); // the tab may be gone

  catchAll(action.setBadgeText({ tabId, text }));
  catchAll(action.setBadgeBackgroundColor({ tabId, color: off ? "#8e8e93" : "#ff8c00" }));
  catchAll(action.setBadgeTextColor?.({ tabId, color: off ? "#ffffff" : "#000000" }));
}

async function setCount(tabId, frameId, { count, off }) {
  await restoreCounts();
  if (!counts.has(tabId)) counts.set(tabId, new Map());
  counts.get(tabId).set(frameId, { count: Number(count) || 0, off: Boolean(off) });
  paintBadge(tabId);
  persistCounts();
}

async function forgetTab(tabId) {
  await restoreCounts();
  if (counts.delete(tabId)) persistCounts();
}

ext.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    forgetTab(tabId);
    action.setBadgeText({ tabId, text: "" })?.catch?.(() => {});
  }
});
ext.tabs.onRemoved.addListener(forgetTab);

// --- Messages and shortcuts -----------------------------------------------------------

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "count" && sender.tab?.id != null) {
    setCount(sender.tab.id, sender.frameId ?? 0, msg);
    return false;
  }
  if (msg?.type === "refresh-lists") {
    refreshLists(msg.ids).then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true; // respond asynchronously
  }
  return false;
});

ext.commands?.onCommand.addListener(async (command) => {
  if (command !== "toggle-pause") return;
  const { settings } = await ext.storage.local.get("settings");
  const current = normalizeSettings(settings);
  await ext.storage.local.set({ settings: { ...current, paused: !current.paused } });
});
