const textarea = document.getElementById("nameList");
const saveBtn = document.getElementById("saveBtn");

// Load existing list
chrome.storage.sync.get("names", (data) => {
  const names = data.names || [];
  textarea.value = names.join("\n");
});

saveBtn.addEventListener("click", () => {
  const names = textarea.value
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
  chrome.storage.sync.set({ names });
  alert("Names saved!");
});
