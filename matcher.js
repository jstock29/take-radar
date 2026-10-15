// Finding names in text. Pure functions, no DOM: shared by the content script
// and the unit tests. Classic script that adds to globalThis.TakeRadar.
(() => {
  const TR = (globalThis.TakeRadar ??= {});

  // Characters that don't decompose under NFD but should still match their
  // plain-ASCII spelling.
  const EXTRA_FOLDS = {
    ø: "o", Ø: "O", ł: "l", Ł: "L", đ: "d", Đ: "D", ß: "ss",
    æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ı: "i",
  };
  const INVISIBLE = /[­​-‍⁠﻿]/; // soft hyphen, zero-width
  const APOSTROPHES = /[‘’ʼ`´]/;
  const DASHES = /[‐-―−]/;

  // Fold one character to a comparable form: strip accents, unify apostrophes
  // and dashes, and drop invisible characters.
  const foldChar = (ch) => {
    if (EXTRA_FOLDS[ch]) return EXTRA_FOLDS[ch];
    if (INVISIBLE.test(ch)) return "";
    if (APOSTROPHES.test(ch)) return "'";
    if (DASHES.test(ch)) return "-";
    return ch.normalize("NFD").replace(/\p{M}/gu, "");
  };

  // Fold a whole string, keeping a map from each folded char back to the
  // original string so matches can be located in the real text. Plain ASCII
  // (most of any page) takes a fast path; only other characters go through
  // foldChar.
  const foldWithMap = (text) => {
    const parts = [];
    const starts = [];
    const ends = [];
    let run = 0; // start of the current run of ASCII chars copied as-is
    const flush = (i) => {
      if (i > run) parts.push(text.slice(run, i));
      for (let k = run; k < i; k++) {
        starts.push(k);
        ends.push(k + 1);
      }
    };
    for (let i = 0; i < text.length; ) {
      const code = text.charCodeAt(i);
      if (code < 0x80 && code !== 0x60 /* ` */) {
        i++;
        continue;
      }
      flush(i);
      const ch = String.fromCodePoint(text.codePointAt(i));
      const f = foldChar(ch);
      for (let k = 0; k < f.length; k++) {
        starts.push(i);
        ends.push(i + ch.length);
      }
      parts.push(f);
      i += ch.length;
      run = i;
    }
    flush(text.length);
    return { folded: parts.join(""), starts, ends };
  };

  const fold = (text) => foldWithMap(text).folded;

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Matching runs on folded text, where Latin letters have lost their
  // accents, so the per-name regexes can use plain ASCII classes. (Unicode
  // property classes like \p{L} made each of hundreds of regexes slow to
  // compile, in every frame of every page.) Word boundaries are checked once
  // per match with the shared WORD_CHAR instead.
  const WORD_CHAR = /[\p{L}\p{N}]/u;
  // What may sit between two words of a name: spaces, periods, hyphens,
  // apostrophes — so "J.K.", "J. K." and "JK" all line up.
  const SEP = "[\\s.'\\-]*";
  // An optional middle initial, so "David Blight" also finds "David W. Blight".
  const MIDDLE_INITIAL = `(?:[a-z](?![a-z0-9])\\.?${SEP})?`;

  /**
   * Turn one name into { source, firstToken } (source is a regex body that
   * must be matched at the start of a word), or null if the name is empty.
   */
  const compileName = (name) => {
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
    return { source: body, firstToken: core[0].toLowerCase() };
  };

  // Where words start in folded text. A match can only begin at one of these.
  const WORD_START = /(?<![\p{L}\p{N}])[\p{L}\p{N}]/gu;

  // Names are bucketed by the first two letters of their first word (or the
  // one letter, for names starting with an initial), so each word in the
  // text is only tried against the handful of names that could start there.
  // One big alternation regex tried every name at every position, which got
  // slow (hundreds of ms per page) once lists reached a few hundred names.
  const keyOf = (s, n) => s.slice(0, n).toLowerCase();

  /**
   * Build a matcher for a set of normalized lists. Returns null when there's
   * nothing to match. `find(text)` returns non-overlapping matches as
   * { start, end, entry } with offsets into the original text; entry has
   * { listId, listName, name, note }.
   */
  const createMatcher = (lists) => {
    const seen = new Set();
    const entries = [];
    lists.forEach((list) => {
      list.names.forEach((line) => {
        const { name, note } = TR.splitEntry(line);
        const compiled = compileName(name);
        if (!compiled || seen.has(compiled.source)) return;
        seen.add(compiled.source);
        entries.push({
          regex: new RegExp(compiled.source, "iy"),
          key: keyOf(compiled.firstToken, 2),
          length: fold(name).length,
          listId: list.id,
          listName: list.name,
          name,
          note,
        });
      });
    });
    if (!entries.length) return null;

    // Longer names first, so "Nicholas A. Christakis" wins over "Nicholas".
    entries.sort((a, b) => b.length - a.length);
    const buckets = new Map();
    for (const entry of entries) {
      if (!buckets.has(entry.key)) buckets.set(entry.key, []);
      buckets.get(entry.key).push(entry);
    }

    const candidatesAt = (folded, i) => {
      const two = buckets.get(keyOf(folded.slice(i), 2));
      const one = buckets.get(keyOf(folded.slice(i), 1));
      if (!two) return one ?? [];
      if (!one || one === two) return two;
      return [...two, ...one].sort((a, b) => b.length - a.length);
    };

    const find = (text) => {
      const { folded, starts, ends } = foldWithMap(text);
      const found = [];
      let last = 0; // end of the previous match, in folded offsets
      WORD_START.lastIndex = 0;
      let w;
      while ((w = WORD_START.exec(folded))) {
        const i = w.index;
        if (i < last) continue;
        for (const entry of candidatesAt(folded, i)) {
          entry.regex.lastIndex = i;
          const m = entry.regex.exec(folded);
          if (!m) continue;
          const endFolded = i + m[0].length;
          if (WORD_CHAR.test(folded[endFolded] ?? "")) continue; // mid-word
          found.push({ start: starts[i], end: ends[endFolded - 1], entry });
          last = endFolded;
          WORD_START.lastIndex = endFolded;
          break;
        }
      }
      return found;
    };

    return { entries, find };
  };

  Object.assign(TR, { fold, createMatcher });
})();
