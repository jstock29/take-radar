(() => {
  const TR = globalThis.TakeRadar ?? {};
  const {
    ext,
    normalizeList,
    normalizeSettings,
    highlightStyle,
    combinedHighlightStyle,
    createMatcher,
    createFollowupMatcher,
    listEntries,
  } = TR;
  if (!ext?.runtime?.id || !document.body) return;

  const HIGHLIGHT_CLASS = "take-radar-highlight";
  const LIST_ATTR = "data-take-radar-list"; // comma-separated list ids
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
  let listById = new Map();
  let settings = normalizeSettings();
  let matcher = null; // full names
  let followupMatcher = null; // surnames of people already found on this page
  let foundKey = ""; // which people the follow-up matcher was built for
  let matchKey = null; // what the current matcher and highlights were built from
  let styleCache = new Map(); // "id1,id2" -> [[property, value], ...]

  // span -> { entry, followup } for every highlight we've made.
  const spanInfo = new WeakMap();

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

  // --- Highlight spans ------------------------------------------------------------

  const styleFor = (idsKey) => {
    if (!styleCache.has(idsKey)) {
      const onLists = idsKey
        .split(",")
        .map((id) => listById.get(id))
        .filter(Boolean);
      styleCache.set(idsKey, onLists.length ? combinedHighlightStyle(onLists, { base: true }) : null);
    }
    return styleCache.get(idsKey);
  };

  const applyStyle = (span) => {
    const style = styleFor(span.getAttribute(LIST_ATTR) ?? "");
    if (!style) return;
    span.style.cssText = "";
    style.forEach(([prop, value]) => span.style.setProperty(prop, value, "important"));
  };

  const makeHighlight = (text, entry, followup) => {
    const span = document.createElement("span");
    span.className = HIGHLIGHT_CLASS;
    span.textContent = text;
    span.setAttribute(LIST_ATTR, entry.lists.map((l) => l.listId).join(","));
    spanInfo.set(span, { entry, followup });
    applyStyle(span);
    return span;
  };

  const highlightTextNode = (node, using, followup) => {
    const text = node.nodeValue;
    const matches = using.find(text);
    if (!matches.length) return;

    const frag = document.createDocumentFragment();
    let last = 0;
    for (const { start, end, entry } of matches) {
      frag.append(text.slice(last, start), makeHighlight(text.slice(start, end), entry, followup));
      last = end;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  };

  // --- Walking the page -------------------------------------------------------------

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
    // Events from inside a closed root never show its contents to listeners
    // outside it, so the hover card listens on the root itself.
    if (root.host && root.host.shadowRoot !== root) listenForHover(root);
  };

  // Highlight every text node under root (an element or shadow root),
  // descending into shadow roots along the way.
  const scan = (root, using, followup) => {
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
    nodes.forEach((node) => highlightTextNode(node, using, followup));

    shadows.forEach((shadow) => {
      watch(shadow);
      scan(shadow, using, followup);
    });
  };

  const highlightIn = (node, using, followup = false) => {
    if (!using || !node?.isConnected) return;
    // The element that decides whether this node is off limits. Text sitting
    // directly in a shadow root has no parent element, only the root's host.
    let owner = null;
    if (node.nodeType === Node.TEXT_NODE) owner = node.parentElement ?? node.parentNode?.host;
    else if (node.nodeType === Node.ELEMENT_NODE) owner = node;
    else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) owner = node.host;
    if (!owner || insideOffLimits(owner)) return;

    if (node.nodeType === Node.TEXT_NODE) highlightTextNode(node, using, followup);
    else scan(node, using, followup);
  };

  const allHighlights = () =>
    [...liveRoots()].flatMap((root) => [...root.querySelectorAll(`.${HIGHLIGHT_CLASS}`)]);

  const clearHighlights = ({ followupsOnly = false } = {}) => {
    const parents = new Set();
    allHighlights().forEach((span) => {
      if (followupsOnly && !spanInfo.get(span)?.followup) return;
      parents.add(span.parentNode);
      span.replaceWith(span.textContent);
    });
    parents.forEach((p) => p?.normalize());
  };

  // --- Later mentions by last name --------------------------------------------------

  // People found on the page by full name, by entry id.
  const foundByFullName = () => {
    const found = new Map();
    for (const span of allHighlights()) {
      const info = spanInfo.get(span);
      if (info && !info.followup) found.set(info.entry.id, info.entry);
    }
    return found;
  };

  // After full names are highlighted: if the set of people found changed,
  // rebuild the surname matcher and redo surname matches page-wide (a newly
  // found person can make a surname ambiguous); otherwise only check the
  // newly added content.
  const updateFollowups = (changedNodes) => {
    const found = foundByFullName();
    const key = [...found.keys()].sort((a, b) => a - b).join(",");
    if (key !== foundKey) {
      foundKey = key;
      clearHighlights({ followupsOnly: true });
      followupMatcher = createFollowupMatcher([...found.values()]);
      highlightIn(document.body, followupMatcher, true);
    } else if (followupMatcher && changedNodes) {
      changedNodes.forEach((node) => highlightIn(node, followupMatcher, true));
    }
  };

  // --- Hover card ----------------------------------------------------------------------
  // Replaces the browser's title tooltip, which takes a second to appear and
  // can't show colors or more than one list. It lives in a shadow root so
  // page CSS can't touch it, and ignores the pointer.

  const card = (() => {
    let host = null;
    let box = null;
    let timer = null;
    let current = null;

    const CSS = `
      .card {
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #f5f5f7; background: #1d1d1f; border-radius: 8px; padding: 8px 10px;
        max-width: 300px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
        text-align: left; white-space: normal; letter-spacing: normal;
      }
      .name { font-weight: 600; font-size: 13px; }
      .sub { color: #a1a1a6; font-size: 11px; }
      .row { display: flex; gap: 8px; align-items: flex-start; margin-top: 6px; }
      .chip { flex: none; font-size: 10px; font-weight: 600; line-height: 16px;
        padding: 0 4px; border-radius: 3px; margin: 1px 2px 0; color: #f5f5f7; }
      .list { font-weight: 500; }
      .note { color: #c7c7cc; }
    `;

    const build = () => {
      host = document.createElement("take-radar-card");
      host.style.cssText =
        "all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none; visibility: hidden;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CSS;
      box = document.createElement("div");
      box.className = "card";
      box.setAttribute("role", "tooltip");
      shadow.append(style, box);
      document.documentElement.append(host);
    };

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    };

    const render = (info) => {
      const { entry, followup } = info;
      const parts = [el("div", "name", entry.name)];
      if (followup) parts.push(el("div", "sub", "Mentioned by last name"));
      for (const { listId, listName, note } of entry.lists) {
        const list = listById.get(listId);
        if (!list) continue;
        const chip = el("span", "chip", "Aa");
        highlightStyle(list).forEach(([prop, value]) => chip.style.setProperty(prop, value));
        const text = el("div", "");
        text.append(el("div", "list", listName));
        if (note) text.append(el("div", "note", note));
        const row = el("div", "row");
        row.append(chip, text);
        parts.push(row);
      }
      box.replaceChildren(...parts);
    };

    const place = (span, x, y) => {
      // Anchor to the line fragment under the pointer (a highlight can wrap).
      const rects = [...span.getClientRects()];
      const rect =
        rects.find((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) ??
        rects[0] ??
        span.getBoundingClientRect();
      const { width, height } = box.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
      let top = rect.bottom + 6;
      if (top + height > innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };

    const show = (span, x, y) => {
      if (span === current) return;
      current = span;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const info = spanInfo.get(span);
        if (!info || !span.isConnected) return;
        if (!host?.isConnected) build();
        render(info);
        place(span, x, y);
        host.style.visibility = "visible";
      }, 120);
    };

    const hide = () => {
      clearTimeout(timer);
      current = null;
      if (host) host.style.visibility = "hidden";
    };

    return { show, hide, isShowing: (span) => span === current };
  })();

  // --- Confirmation after adding a name from the right-click menu ------------------------

  const toast = (() => {
    let host = null;
    let timer = null;

    return (text) => {
      host?.remove();
      host = document.createElement("take-radar-toast");
      host.style.cssText =
        "all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; pointer-events: none;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        .toast {
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #f5f5f7; background: #1d1d1f; border-radius: 8px; padding: 8px 12px;
          max-width: 320px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
        }
      `;
      const box = document.createElement("div");
      box.className = "toast";
      box.setAttribute("role", "status");
      box.textContent = text;
      shadow.append(style, box);
      document.documentElement.append(host);
      clearTimeout(timer);
      timer = setTimeout(() => host.remove(), 2800);
    };
  })();

  const highlightFrom = (e) =>
    e.composedPath().find((n) => n.classList?.contains?.(HIGHLIGHT_CLASS)) ?? null;

  function listenForHover(target) {
    target.addEventListener(
      "mouseover",
      (e) => {
        const span = highlightFrom(e);
        if (span) card.show(span, e.clientX, e.clientY);
      },
      true,
    );
    target.addEventListener(
      "mouseout",
      (e) => {
        const span = highlightFrom(e);
        if (!span || !card.isShowing(span)) return;
        if (e.relatedTarget && span.contains(e.relatedTarget)) return;
        card.hide();
      },
      true,
    );
  }
  listenForHover(document);
  addEventListener("scroll", card.hide, { capture: true, passive: true });
  addEventListener("blur", card.hide);

  // --- Reporting: badge count and who's on the page ------------------------------------

  const peopleOnPage = () => {
    const people = new Map();
    for (const span of allHighlights()) {
      const info = spanInfo.get(span);
      if (!info) continue;
      const { entry } = info;
      if (!people.has(entry.id)) {
        people.set(entry.id, { name: entry.name, lists: entry.lists.map((l) => l.listId), count: 0 });
      }
      people.get(entry.id).count++;
    }
    return [...people.values()];
  };

  let lastReport = null;
  const report = () => {
    const off = !isActive();
    const people = off ? [] : peopleOnPage();
    const count = people.reduce((sum, p) => sum + p.count, 0);
    const key = off ? "off" : JSON.stringify(people);
    if (key === lastReport) return;
    lastReport = key;
    ext.runtime.sendMessage({ type: "count", count, off, people })?.catch?.(() => {});
  };

  // The popup's "On this page" list asks a frame to scroll to someone; each
  // click moves to the next mention.
  const revealed = new Map();
  ext.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toast") return void toast(String(msg.text ?? ""));
    if (msg?.type !== "reveal") return;
    const spans = allHighlights().filter((s) => spanInfo.get(s)?.entry.name === msg.name);
    if (!spans.length) return;
    const i = ((revealed.get(msg.name) ?? -1) + 1) % spans.length;
    revealed.set(msg.name, i);
    const span = spans[i];
    span.scrollIntoView({ block: "center", behavior: "smooth" });
    span.animate?.(
      [
        { outline: "3px solid rgba(255, 140, 0, 0.95)", outlineOffset: "2px" },
        { outline: "3px solid rgba(255, 140, 0, 0)", outlineOffset: "8px" },
      ],
      { duration: 1400, delay: 300, easing: "ease-out" },
    );
  });

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
    // Highlighting replaces text nodes, so remember where they were for the
    // surname pass that follows.
    const places = nodes.map((n) => (n.nodeType === Node.TEXT_NODE ? n.parentNode : n));
    quietly(() => {
      nodes.forEach((node) => highlightIn(node, matcher));
      updateFollowups(places);
    });
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
    listById = new Map(lists.map((l) => [l.id, l]));
    styleCache = new Map();

    // A style-only change (e.g. dragging a color) just repaints existing
    // highlights instead of re-scanning the page.
    const enabled = lists.filter((l) => l.enabled !== false);
    const key = active
      ? JSON.stringify(enabled.map((l) => [l.id, l.name, listEntries(l), l.followups !== false]))
      : "off";
    if (key === matchKey) {
      allHighlights().forEach(applyStyle);
      return;
    }
    matchKey = key;
    matcher = active ? createMatcher(lists) : null;
    foundKey = "";
    followupMatcher = null;
    card.hide();
    quietly(() => {
      clearHighlights();
      if (matcher) {
        highlightIn(document.body, matcher);
        updateFollowups();
      }
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
