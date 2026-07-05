(() => {
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const fetchLists = () =>
    new Promise((resolve) => {
      if (chrome.runtime.id) {
        chrome.storage.sync.get("lists", (data) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[NameHighlighter] Storage access failed:",
              chrome.runtime.lastError,
            );
            resolve([]);
          } else {
            resolve(data.lists || []);
          }
        });
      } else {
        resolve([]);
      }
    });

  const run = async () => {
    const lists = await fetchLists();
    if (!lists.length) return;

    const patternData = [];
    lists.forEach((list) => {
      list.names.forEach((name) => {
        const target = name.trim();
        if (!target) return;

        const words = target.split(/\s+/).filter(Boolean);
        const pattern = words.map(escapeRegExp).join("[\\s\\w.\\-]*?");

        patternData.push({
          pattern: `(${pattern})`,
          listName: list.name,
          color: list.color,
        });
      });
    });

    const combinedRegex = new RegExp(
      patternData.map((p) => p.pattern).join("|"),
      "gi",
    );

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false,
    );
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      if (
        node.parentElement?.tagName === "SCRIPT" ||
        node.parentElement?.classList.contains("name-highlight")
      )
        return;

      const text = node.textContent;
      const newText = text.replace(combinedRegex, (...args) => {
        let matchedIndex = -1;
        for (let i = 1; i < args.length - 2; i++) {
          if (args[i] !== undefined) {
            matchedIndex = i - 1;
            break;
          }
        }

        if (matchedIndex === -1) return args[0];

        const info = patternData[matchedIndex];
        return `<span class="name-highlight" style="background-color: ${info.color}" title="${info.listName}">${args[0]}</span>`;
      });

      if (newText !== text) {
        const span = document.createElement("span");
        span.innerHTML = newText;
        node.parentNode.replaceChild(span, node);
      }
    });
    console.log("[NameHighlighter] Highlight pass complete.");
  };

  chrome.runtime.onMessage.addListener(
    (req) => req.action === "refresh" && run(),
  );
  const observer = new MutationObserver(() => run());
  observer.observe(document.body, { childList: true, subtree: true });

  run();
  setTimeout(run, 1000);
})();
