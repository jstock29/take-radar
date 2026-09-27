import { names } from "./names.js";

// Lists live in chrome.storage.local: sync caps each item at 8KB, which a
// single big list easily exceeds.
chrome.runtime.onInstalled.addListener(async () => {
  const { lists } = await chrome.storage.local.get("lists");
  if (lists) return;

  // Carry over lists saved by older versions, otherwise seed the default list.
  const synced = await chrome.storage.sync.get("lists");
  await chrome.storage.local.set({
    lists: synced.lists ?? [
      {
        id: "default",
        name: "Harper's Letter Signatories",
        color: "#ff8c00",
        names,
      },
    ],
  });
  await chrome.storage.sync.remove(["lists", "names"]);
});
