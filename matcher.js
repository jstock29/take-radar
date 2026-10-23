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
   * Build a matcher for a set of normalized lists (disabled lists are left
   * out). Returns null when there's nothing to match. `find(text)` returns
   * non-overlapping matches as { start, end, entry } with offsets into the
   * original text.
   *
   * A name on several lists is one entry, carrying every list it's on in
   * list order: entry = { id, name, lists: [{ listId, listName, note }],
   * followups }. Spellings that compile to the same pattern ("Ruth Okafor",
   * "Ruth A. Okafor") count as the same name.
   */
  const createMatcher = (lists) => {
    const bySource = new Map();
    const entries = [];
    lists.forEach((list) => {
      if (list.enabled === false) return;
      TR.listEntries(list).forEach((line) => {
        const { name, note } = TR.splitEntry(line);
        const compiled = compileName(name);
        if (!compiled) return;
        // Matching ignores case, so merging must too ("jane doe" is Jane Doe).
        const key = compiled.source.toLowerCase();
        let entry = bySource.get(key);
        if (!entry) {
          entry = {
            id: entries.length,
            regex: new RegExp(compiled.source, "iy"),
            key: keyOf(compiled.firstToken, 2),
            length: fold(name).length,
            name,
            lists: [],
            followups: false,
          };
          bySource.set(key, entry);
          entries.push(entry);
        }
        const onList = entry.lists.find((l) => l.listId === list.id);
        if (onList) {
          // Listed twice on the same list: keep the first note found.
          if (!onList.note && note) onList.note = note;
          return;
        }
        entry.lists.push({ listId: list.id, listName: list.name, note });
        if (list.followups !== false) entry.followups = true;
      });
    });
    if (!entries.length) return null;

    // Longer names first, so "Nicholas A. Christakis" wins over "Nicholas".
    const ordered = [...entries].sort((a, b) => b.length - a.length);
    const buckets = new Map();
    for (const entry of ordered) {
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

  // --- Later mentions by last name ------------------------------------------------
  // News writing names someone in full once ("Celinda Lake, a Democratic
  // pollster") and by surname after that ("Ms. Lake said"). Once a full name
  // has been found on a page, its surname alone is highlighted too.

  const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const HONORIFICS = new Set([
    "mr", "mrs", "ms", "mx", "dr", "prof", "sen", "senator", "rep", "gov",
    "governor", "president", "secretary", "judge", "justice", "gen", "col",
  ]);

  /** The surname used for later mentions, or null if the name has none. */
  const surnameOf = (name) => {
    const words = fold(name).trim().split(/\s+/);
    while (words.length > 1 && SUFFIXES.has(words.at(-1).replace(/[.,]/g, "").toLowerCase())) {
      words.pop();
    }
    if (words.length < 2) return null;
    const surname = words.at(-1).replace(/[.,]+$/, "");
    // Short or lowercase "surnames" are too likely to be ordinary words.
    if (surname.length < 3 || !/^\p{Lu}/u.test(surname)) return null;
    return surname;
  };

  const isUpper = (ch) => /\p{Lu}/u.test(ch ?? "");

  // Surnames that are also everyday words. At the start of a sentence these
  // are more likely the word ("Short of that, ...") than the person, so
  // there they need an honorific ("Mr. Short said").
  const COMMON_WORDS = new Set(
    (
      "bell best bird black bliss bloom brown burns bush cash case chase cook " +
      "cooper cross day dean english fair field fish ford fox frank free " +
      "friend gay gold good grace gray green grey hall hand hart hay heart " +
      "hill hope house hunt king lake lamb land lane law little long love " +
      "major march mark marsh mason may miller moody moon more north page " +
      "park parker pope power price reed rich rice rose ross sharp short " +
      "small smart snow south spain spring stark steel stone story strong " +
      "summer swift taylor tower turner walker wall ward warren waters " +
      "weaver well wells west white wise wolf wood woods young"
    ).split(" "),
  );

  /**
   * A matcher for the surnames of entries already found on the page. A
   * surname shared by two found people ("Stan Greenberg", "Anna Greenberg")
   * is skipped as ambiguous. Matches are case-sensitive and skipped when
   * they look like part of a longer proper name ("Lake Tahoe", "Great Salt
   * Lake"); honorifics before them are fine ("Ms. Lake", "Sen Short").
   */
  const createFollowupMatcher = (foundEntries) => {
    const bySurname = new Map();
    for (const entry of foundEntries) {
      if (!entry.followups) continue;
      const surname = surnameOf(entry.name);
      if (!surname) continue;
      if (!bySurname.has(surname)) bySurname.set(surname, []);
      bySurname.get(surname).push(entry);
    }
    const usable = [...bySurname].filter(([, list]) => list.length === 1);
    if (!usable.length) return null;

    const entryFor = new Map(usable.map(([surname, [entry]]) => [surname, entry]));
    const regex = new RegExp(
      `(?<![\\p{L}\\p{N}\\-'])(?:${usable.map(([s]) => escapeRegExp(s)).join("|")})(?![\\p{L}\\p{N}])`,
      "gu",
    );

    const find = (text) => {
      const { folded, starts, ends } = foldWithMap(text);
      const found = [];
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(folded))) {
        const i = m.index;
        const end = i + m[0].length;

        // The word after: "Lake Tahoe" is a place, not Ms. Lake.
        const after = /^ +(\S)/.exec(folded.slice(end, end + 3));
        if (after && isUpper(after[1])) continue;

        // The word before: a capitalized word that isn't an honorific and
        // doesn't end a sentence suggests a different full name.
        const before = /(\S+)( +)$/.exec(folded.slice(Math.max(0, i - 40), i));
        const word = before?.[1] ?? "";
        const afterHonorific = HONORIFICS.has(word.replace(/[.,]+$/, "").toLowerCase());
        const opensQuote = /["“(]$/.test(folded.slice(Math.max(0, i - 1), i));
        if (before && !opensQuote) {
          const endsClause = /[.!?:;,"“”)\]]$/.test(word);
          if (isUpper(word[0]) && !afterHonorific && !endsClause) continue;
        }

        // Everyday-word surnames need more than a capital letter at the
        // start of a sentence (or of the text, or of a quote).
        const sentenceStart = !before || opensQuote || /[.!?]["”)]*$/.test(word);
        if (sentenceStart && !afterHonorific && COMMON_WORDS.has(m[0].toLowerCase())) continue;

        found.push({ start: starts[i], end: ends[end - 1], entry: entryFor.get(m[0]) });
      }
      return found;
    };

    return { find };
  };

  Object.assign(TR, { fold, createMatcher, createFollowupMatcher, surnameOf });
})();
