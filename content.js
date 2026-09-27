(() => {
  const HIGHLIGHT_CLASS = "take-radar-highlight";
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
  ]);

  // Characters that don't decompose under NFD but should still match their
  // plain-ASCII spelling.
  const EXTRA_FOLDS = {
    ø: "o", Ø: "O", ł: "l", Ł: "L", đ: "d", Đ: "D", ß: "ss",
    æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ı: "i",
  };

  // Fold one character to a comparable form: strip accents, unify apostrophes
  // and dashes, and drop invisible characters (soft hyphens, zero-width spaces).
  const foldChar = (ch) => {
    if (EXTRA_FOLDS[ch]) return EXTRA_FOLDS[ch];
    if (/[­​-‍⁠﻿]/.test(ch)) return "";
    if (/[‘’ʼ`´]/.test(ch)) return "'";
    if (/[‐-―−]/.test(ch)) return "-";
    return ch.normalize("NFD").replace(/\p{M}/gu, "");
  };

  // Fold a whole string, keeping a map from each folded char back to the
  // original string so matches can be located in the real text.
  const foldWithMap = (text) => {
    let folded = "";
    const starts = [];
    const ends = [];
    let i = 0;
    for (const ch of text) {
      const f = foldChar(ch);
      for (let k = 0; k < f.length; k++) {
        starts.push(i);
        ends.push(i + ch.length);
      }
      folded += f;
      i += ch.length;
    }
    return { folded, starts, ends };
  };

  const fold = (text) => foldWithMap(text).folded;

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
  const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";
  // What may sit between two words of a name: spaces, periods, hyphens,
  // apostrophes — so "J.K.", "J. K." and "JK" all line up.
  const SEP = "[\\s.'\\-]*";
  // An optional middle initial, so "David Blight" also finds "David W. Blight".
  const MIDDLE_INITIAL = `(?:\\p{L}(?![\\p{L}\\p{N}])\\.?${SEP})?`;

  // Turn one name into a regex source string, or null if it's empty.
  const nameToPattern = (name) => {
    const tokens = fold(name)
      .split(/[\s.'\-]+/)
      .filter(Boolean);
    if (!tokens.length) return null;

    // Interior single-letter initials are covered by MIDDLE_INITIAL instead.
    const core = tokens.filter(
      (t, i) => i === 0 || i === tokens.length - 1 || t.length > 1,
    );
    const body = core
      .map(escapeRegExp)
      .join(core.length > 1 ? `${SEP}${MIDDLE_INITIAL}` : "");
    return `${NOT_WORD_BEFORE}(${body})${NOT_WORD_AFTER}`;
  };

  // Pick black or white text so highlights stay readable on any color.
  const textColorFor = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#000";
    const n = parseInt(m[1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";
  };

  let matcher = null;

  const buildMatcher = (lists) => {
    const seen = new Set();
    const entries = [];
    lists.forEach((list) => {
      (list.names || []).forEach((name) => {
        const pattern = nameToPattern(name);
        if (!pattern || seen.has(pattern)) return;
        seen.add(pattern);
        entries.push({
          pattern,
          length: fold(name).length,
          listName: list.name,
          color: list.color,
          textColor: textColorFor(list.color),
        });
      });
    });
    if (!entries.length) return null;

    // Longer names first, so "Nicholas A. Christakis" wins over "Nicholas".
    entries.sort((a, b) => b.length - a.length);
    return {
      entries,
      regex: new RegExp(entries.map((e) => e.pattern).join("|"), "giu"),
    };
  };

  const makeHighlight = (text, entry) => {
    const span = document.createElement("span");
    span.className = HIGHLIGHT_CLASS;
    span.textContent = text;
    span.title = entry.listName;
    span.style.setProperty("background-color", entry.color, "important");
    span.style.setProperty("color", entry.textColor, "important");
    return span;
  };

  const highlightTextNode = (node) => {
    const text = node.nodeValue;
    const { folded, starts, ends } = foldWithMap(text);
    const { regex, entries } = matcher;

    regex.lastIndex = 0;
    let frag = null;
    let last = 0;
    let m;
    while ((m = regex.exec(folded))) {
      const groupIndex = m.findIndex((g, i) => i > 0 && g !== undefined);
      const entry = entries[groupIndex - 1];
      const start = starts[m.index];
      const end = ends[m.index + m[0].length - 1];
      if (!entry || start < last) continue;

      frag ??= document.createDocumentFragment();
      frag.append(text.slice(last, start), makeHighlight(text.slice(start, end), entry));
      last = end;
    }

    if (frag) {
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  };

  const shouldSkip = (el) => {
    for (let e = el; e; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName) || e.classList.contains(HIGHLIGHT_CLASS)) {
        return true;
      }
    }
    return el.isContentEditable;
  };

  const highlightIn = (root) => {
    if (!matcher || !root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (root.parentElement && !shouldSkip(root.parentElement)) {
        highlightTextNode(root);
      }
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || shouldSkip(root)) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue.trim() && !shouldSkip(node.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(highlightTextNode);
  };

  const clearHighlights = () => {
    const parents = new Set();
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((span) => {
      parents.add(span.parentNode);
      span.replaceWith(span.textContent);
    });
    parents.forEach((p) => p?.normalize());
  };

  // --- Watching the page for new content ---

  const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };
  const pending = new Set();
  let flushTimer = null;

  // Run DOM changes without our observer seeing (and reacting to) them.
  const quietly = (fn) => {
    observer.disconnect();
    try {
      fn();
    } finally {
      observer.observe(document.body, OBSERVE_OPTIONS);
    }
  };

  const flush = () => {
    flushTimer = null;
    const roots = [...pending].filter((n) => n.isConnected);
    pending.clear();
    quietly(() => roots.forEach(highlightIn));
  };

  const observer = new MutationObserver((records) => {
    if (!matcher) return;
    records.forEach((r) => {
      if (r.type === "characterData") pending.add(r.target);
      else r.addedNodes.forEach((n) => pending.add(n));
    });
    if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 200);
  });

  const refresh = (lists) => {
    matcher = buildMatcher(lists || []);
    quietly(() => {
      clearHighlights();
      highlightIn(document.body);
    });
  };

  if (!document.body || !chrome.runtime?.id) return;

  chrome.storage.local.get("lists", (data) => {
    if (chrome.runtime.lastError) return;
    refresh(data.lists);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.lists) refresh(changes.lists.newValue);
  });
})();
