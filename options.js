const listsContainer = document.getElementById("listsContainer");
const addListBtn = document.getElementById("addListBtn");
const saveBtn = document.getElementById("saveBtn");
const importFile = document.getElementById("importFile");

let lists = [];

function createListElement(list, index) {
  const div = document.createElement("div");
  div.className = "list-container";

  const header = document.createElement("div");
  header.className = "list-header";
  header.innerHTML = `
    <strong>${list.name}</strong> (${list.names.length} names)
    <button class="expand-btn">Expand</button>
  `;

  // Color picker inside content so it's always accessible when list is expanded
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = list.color;
  colorInput.title = "Change highlight color";
  colorInput.addEventListener(
    "change",
    (e) => (lists[index].color = e.target.value),
  );

  const content = document.createElement("div");
  content.className = "list-content";
  content.style.display = "none";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = list.name;
  nameInput.placeholder = "List Name";
  nameInput.addEventListener("change", (e) => {
    lists[index].name = e.target.value;
    header.querySelector("strong").textContent = e.target.value;
  });

  const textArea = document.createElement("textarea");
  textArea.placeholder = "Names (one per line)";
  textArea.value = list.names.join("\n");

  const preview = document.createElement("div");
  preview.className = "list-preview";
  preview.textContent = `${list.names.slice(0, 3).join(", ")}${list.names.length > 3 ? "..." : ""}`;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove List";
  removeBtn.className = "remove-btn";
  removeBtn.addEventListener("click", () => {
    lists.splice(index, 1);
    renderLists();
  });

  header.querySelector(".expand-btn").addEventListener("click", (e) => {
    const isHidden = content.style.display === "none";
    content.style.display = isHidden ? "block" : "none";
    e.target.textContent = isHidden ? "Collapse" : "Expand";
    preview.style.display = isHidden ? "none" : "block";
  });

  content.appendChild(colorInput);
  content.appendChild(nameInput);
  content.appendChild(textArea);
  content.appendChild(removeBtn);

  div.appendChild(header);
  div.appendChild(preview);
  div.appendChild(content);

  return div;
}

function renderLists() {
  listsContainer.innerHTML = "";
  lists.forEach((list, index) => {
    listsContainer.appendChild(createListElement(list, index));
  });
}

importFile.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const names = text
      .split(/[\n,]/)
      .map((n) => n.trim())
      .filter(Boolean);
    lists.push({
      id: Date.now().toString(),
      name: file.name,
      color: "#ff8c00",
      names: names,
    });
    renderLists();
  };
  reader.readAsText(file);
});

chrome.storage.sync.get(["lists", "names"], (data) => {
  if (data.lists) {
    lists = data.lists;
  } else if (data.names) {
    lists = [
      {
        id: Date.now().toString(),
        name: "Harper's Letter Signatories",
        color: "#ff8c00",
        names: data.names,
      },
    ];
  }
  renderLists();
});

addListBtn.addEventListener("click", () => {
  lists.push({
    id: Date.now().toString(),
    name: "New List",
    color: "#ff8c00",
    names: [],
  });
  renderLists();
});

saveBtn.addEventListener("click", () => {
  // Update names from textareas before saving
  document.querySelectorAll(".list-container").forEach((container, index) => {
    // Ensure we are updating the correct list based on its unique identifier if possible,
    // or rely on the order from renderLists.
    const textArea = container.querySelector("textarea");
    lists[index].names = textArea.value
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
  });

  chrome.storage.sync.set({ lists }, () => {
    // Notify content scripts of the change
    chrome.tabs.query({ url: "<all_urls>" }, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          chrome.tabs
            .sendMessage(tab.id, { action: "refresh" })
            .catch((error) => {
              // Ignore errors if the tab is no longer available or content script not injected
              if (
                error.message !==
                "Could not establish connection. Receiving end does not exist."
              ) {
                console.warn("[Options] Error sending message to tab: ", error);
              }
            });
        }
      });
    });
    alert("Lists saved!");
    window.close(); // Close the popup after saving
  });
});
