(() => {
  const TR = globalThis.TakeRadar ?? {};
  const { ext, normalizeList, normalizeSettings, highlightStyle, createMatcher } = TR;
  if (!ext?.runtime?.id || !document.body) return;

  const HIGHLIGHT_CLASS = "take-radar-highlight";
  const LIST_ATTR = "data-take-radar-list";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "title",
    "textarea", "input", "select", "option",
    "iframe", "canvas", "svg", "math",
  ]);

  // The site the user sees in the address bar, even inside an iframe, so
  // "off on this site" covers embedded frames too. (Firefox has no
  // ancestorOrigins; there a frame falls back to its own host.)
  const siteHost = (() => {
    try {
      const origins = location.ancestorOrigins;
      if (origins?.length) return new URL(origins[origins.length - 1]).hostname;
    } catch {}
    return location.hostname;
  })();

  let lists = [];
  let settings = normalizeSettings();
  let matcher = null;
  let styles = new Map(); // list id -> [[property, value], ...]
  let matchKey = null; // what the current matcher and highlights were built from

  const isActive = () => !settings.paused && !settings.disabledHosts.includes(siteHost);

  // --- Shadow DOM -------------------------------------------------------------
  // Text inside shadow roots is invisible to a normal tree walk and to an
  // observer on document.body, so every shadow root found is scanned and
  // observed too. Closed roots are reachable from extensions in Chrome
  // (chrome.dom) and Firefox (openOrClosedShadowRoot), not Safari.

  const shadowRootOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return ext.dom?.openOrClosedShadowRoot?.(el) ?? el.openOrClosedShadowRoot ?? null;
    } catch {
      return null;
    }
  };

  // Everything we observe and search: the body plus each shadow root seen.
  const roots = new Set([document.body]);
  const liveRoots = () => {
    for (const root of roots) {
      const host = root === document.body ? root : root.host;
      if (!host?.isConnected) roots.delete(root);
    }
    return roots;
  };

  // --- Highlighting -------------------------------------------------------------

  const applyStyle = (span) => {
    const style = styles.get(span.getAttribute(LIST_ATTR));
    if (!style) return;
    span.style.cssText = "";
    style.forEach(([prop, value]) => span.style.setProperty(prop, value, "important"));
  };

  const makeHighlight = (text, entry) => {
    const span = document.createElement("span");
    span.className = HIGHLIGHT_CLASS;
    span.textContent = text;
    span.title = entry.note ? `${entry.listName}\n${entry.note}` : entry.listName;
    span.setAttribute(LIST_ATTR, entry.listId);
    applyStyle(span);
    return span;
  };

  const highlightTextNode = (node) => {
    const text = node.nodeValue;
    const matches = matcher.find(text);
    if (!matches.length) return;

    const frag = document.createDocumentFragment();
    let last = 0;
    for (const { start, end, entry } of matches) {
      frag.append(text.slice(last, start), makeHighlight(text.slice(start, end), entry));
      last = end;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  };

  // Elements whose text we never touch. Anything outside the HTML namespace
  // (SVG, MathML) is skipped too: a <span> inside an SVG <text> breaks it.
  const isOffLimits = (el) =>
    el.namespaceURI !== HTML_NS ||
    SKIP_TAGS.has(el.localName) ||
    el.classList.contains(HIGHLIGHT_CLASS) ||
    el.isContentEditable;

  // Walk up through ancestors, crossing out of shadow roots into their hosts.
  const insideOffLimits = (el) => {
    for (let e = el; e; e = e.parentElement ?? e.getRootNode()?.host ?? null) {
      if (isOffLimits(e)) return true;
    }
    return false;
  };

  const watch = (root) => {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, OBSERVE_OPTIONS);
  };

  // Highlight every text node under root (an element or shadow root),
  // descending into shadow roots along the way.
  const scan = (root) => {
    const shadows = [];
    if (root.nodeType === Node.ELEMENT_NODE) {
      const own = shadowRootOf(root);
      if (own) shadows.push(own);
    }
    // Rejecting an element prunes its whole subtree, so each node is only
    // checked once instead of walking up to the root for every text node.
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          }
          if (isOffLimits(node)) return NodeFilter.FILTER_REJECT;
          const shadow = shadowRootOf(node);
          if (shadow) shadows.push(shadow);
          return NodeFilter.FILTER_SKIP;
        },
      },
    );
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(highlightTextNode);

    shadows.forEach((shadow) => {
      watch(shadow);
      scan(shadow);
    });
  };

  const highlightIn = (node) => {
    if (!matcher || !node?.isConnected) return;
    // The element that decides whether this node is off limits. Text sitting
    // directly in a shadow root has no parent element, only the root's host.
    let owner = null;
    if (node.nodeType === Node.TEXT_NODE) owner = node.parentElement ?? node.parentNode?.host;
    else if (node.nodeType === Node.ELEMENT_NODE) owner = node;
    else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) owner = node.host;
    if (!owner || insideOffLimits(owner)) return;

    if (node.nodeType === Node.TEXT_NODE) highlightTextNode(node);
    else scan(node);
  };

  const allHighlights = () =>
    [...liveRoots()].flatMap((root) => [...root.querySelectorAll(`.${HIGHLIGHT_CLASS}`)]);

  const clearHighlights = () => {
    const parents = new Set();
    allHighlights().forEach((span) => {
      parents.add(span.parentNode);
      span.replaceWith(span.textContent);
    });
    parents.forEach((p) => p?.normalize());
  };

  // --- Match count for the toolbar badge -----------------------------------------

  let lastReport = null;
  const report = () => {
    const off = !isActive();
    const count = off ? 0 : allHighlights().length;
    const key = off ? "off" : count;
    if (key === lastReport) return;
    lastReport = key;
    ext.runtime.sendMessage({ type: "count", count, off })?.catch?.(() => {});
  };

  // --- Watching the page for new content ---------------------------------------

  const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };
  const pending = new Set();
  let flushTimer = null;

  // Run DOM changes without our observer seeing (and reacting to) them.
  const quietly = (fn) => {
    observer.disconnect();
    try {
      fn();
    } finally {
      liveRoots().forEach((root) => observer.observe(root, OBSERVE_OPTIONS));
    }
  };

  const flush = () => {
    flushTimer = null;
    const nodes = [...pending];
    pending.clear();
    quietly(() => nodes.forEach(highlightIn));
    report();
  };

  const observer = new MutationObserver((records) => {
    if (!matcher) return;
    records.forEach((r) => {
      if (r.type === "characterData") pending.add(r.target);
      else r.addedNodes.forEach((n) => pending.add(n));
    });
    if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 200);
  });

  // --- Settings and lists ------------------------------------------------------

  const update = () => {
    const active = isActive();
    styles = new Map(lists.map((l) => [l.id, highlightStyle(l, { base: true })]));

    // A style-only change (e.g. dragging a color) just repaints existing
    // highlights instead of re-scanning the page.
    const key = active ? JSON.stringify(lists.map((l) => [l.id, l.name, l.names])) : "off";
    if (key === matchKey) {
      allHighlights().forEach(applyStyle);
      return;
    }
    matchKey = key;
    matcher = active ? createMatcher(lists) : null;
    quietly(() => {
      clearHighlights();
      if (matcher) highlightIn(document.body);
    });
    report();
  };

  ext.storage.local.get(["lists", "settings"]).then(
    (data) => {
      lists = (Array.isArray(data?.lists) ? data.lists : []).map(normalizeList);
      settings = normalizeSettings(data?.settings);
      update();
    },
    () => {}, // Extension reloaded or storage unavailable; nothing to do.
  );

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.lists || changes.settings)) return;
    if (changes.lists) {
      lists = (changes.lists.newValue ?? []).map(normalizeList);
    }
    if (changes.settings) settings = normalizeSettings(changes.settings.newValue);
    update();
  });

  // Back/forward cache restores a page without re-running this script, and
  // the badge was reset for the navigation in between.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      lastReport = null;
      report();
    }
  });
})();
