// Chrome runs this as a service worker and needs the helpers pulled in here;
// Firefox and Safari load them first via manifest "background.scripts".
if (typeof TakeRadar === "undefined" && typeof importScripts === "function") {
  importScripts("shared.js", "names.js");
}

const { ext, normalizeList } = TakeRadar;

// Lists live in storage.local: sync caps each item at 8KB, which a single
// big list easily exceeds.
ext.runtime.onInstalled.addListener(async () => {
  let { lists } = await ext.storage.local.get("lists");

  if (!Array.isArray(lists)) {
    // Carry over lists saved by older versions, otherwise seed the default.
    lists = await legacySyncedLists();
    lists ??= [
      {
        id: "default",
        name: "Harper's Letter Signatories",
        names: globalThis.TAKE_RADAR_DEFAULT_NAMES,
      },
    ];
  }

  // Upgrade older list shapes (e.g. the single `color` field before 0.4).
  await ext.storage.local.set({ lists: lists.map(normalizeList) });
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
