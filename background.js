import { names } from "./names.js";

// Now you can use `names` anywhere in this service worker
chrome.storage.sync.set({ names });

chrome.runtime.onInstalled.addListener(() => {
  console.log("Background worker started. Names:", names);
});
