/* content.js – replace the whole file with this */
(() => {
  /* --- 1. Helpers ----------------------------------------------------- */
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /* --- 2. Fetch the names list ---------------------------------------- */
  const fetchNames = () =>
    new Promise((resolve) => {
      chrome.storage.sync.get("names", (data) => {
        const list = Array.isArray(data.names) ? data.names : [];
        console.log("[NameHighlighter] Loaded names:", list);
        resolve(list);
      });
    });

  /* --- 3. Build a regex that accepts hyphens/apostrophes inside a name */
  const buildRegex = (names) => {
    if (!names.length) return null;
    const pattern = names.map(escapeRegExp).join("|");
    // (?<!\S)  – previous char is whitespace or start
    // (?!\S)   – next char is whitespace or end
    // So “Jean‑Claude” matches as a single token.
    const regex = new RegExp(`(?<!\\S)(${pattern})(?!\\S)`, "giu");
    console.log("[NameHighlighter] Regex:", regex);
    return regex;
  };

  /* --- 4. Highlight the names ------------------------------------------ */
  const highlight = (regex) => {
    if (!regex) return;
    const body = document.body;
    if (!body) return;

    const walker = document.createTreeWalker(
      body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      const newText = node.textContent.replace(regex, (match) => {
        return `<span class="name-highlight">${match}</span>`;
      });
      if (newText !== node.textContent) {
        const span = document.createElement("span");
        span.innerHTML = newText;
        node.parentNode.replaceChild(span, node);
      }
    });
    console.log("[NameHighlighter] Highlighting done.");
  };

  /* --- 5. Run everything ----------------------------------------------- */
  const run = async () => {
    console.log("[NameHighlighter] Content script started.");
    const names = await fetchNames();
    const regex = buildRegex(names);
    highlight(regex);
  };

  /* --- 6. If the page loads dynamically, keep watching ---------------- */
  const observer = new MutationObserver(() => {
    console.log("[NameHighlighter] DOM changed – re‑highlighting.");
    run();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  /* --- 7. Initial run ----------------------------------------------- */
  run();
})();
