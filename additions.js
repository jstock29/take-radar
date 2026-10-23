// Names added by hand, and sending them back to the project's lists. Used by
// the background script, the settings page and the list-additions workflow;
// pages never need it, so the content script doesn't load it. Classic script
// that adds to globalThis.TakeRadar; load shared.js first.
(() => {
  const TR = globalThis.TakeRadar;
  const { splitEntry, listEntries, STARTERS } = TR;

  // --- Names you add yourself ---------------------------------------------------
  // A list synced from a URL is read-only and replaced on every refresh, so
  // names added by hand live beside it in `list.added` and survive refreshes.
  // Lists you maintain yourself just take new names in `names`.

  // Two spellings of a name are the same person for adding and de-duplicating:
  // case, accents, punctuation and spacing don't count.
  const nameKey = (name) =>
    String(name)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const MAX_SELECTION_WORDS = 6;

  /**
   * Turn text selected on a page into a name to add, or "" if it can't be
   * one (empty, no letters, a whole sentence, or something containing the
   * | that separates a note).
   */
  const cleanSelection = (text) => {
    const name = String(text ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[("'“”‘’[]+|[)"'“”‘’\],.;:!?]+$/g, "")
      .replace(/['’]s$/i, "") // "Bannon's" -> "Bannon"
      .trim();
    if (!/\p{L}/u.test(name) || name.includes("|")) return "";
    if (name.split(" ").length > MAX_SELECTION_WORDS) return "";
    return name;
  };

  /**
   * Add text selected on a page to a list (mutating it): into `added` for a
   * synced list, `names` otherwise. Returns { status, name } where status is
   * "added", "duplicate" (name is how the list already spells it) or
   * "invalid".
   */
  const addSelection = (list, text) => {
    const name = cleanSelection(text);
    if (!name) return { status: "invalid", name: "" };
    const key = nameKey(name);
    const existing = listEntries(list)
      .map((entry) => splitEntry(entry).name)
      .find((n) => nameKey(n) === key);
    if (existing) return { status: "duplicate", name: existing };
    if (list.source) (list.added ??= []).push(name);
    else list.names.push(name);
    return { status: "added", name };
  };

  /** The additions that a refreshed source doesn't list yet. */
  const pruneAdded = (added = [], sourceNames = []) => {
    const listed = new Set(sourceNames.map((entry) => nameKey(splitEntry(entry).name)));
    return added.filter((entry) => !listed.has(nameKey(splitEntry(entry).name)));
  };

  // --- Sending additions back to the repo ----------------------------------------
  // "Submit new names" (shown in developer mode) opens a pre-filled new issue
  // holding the names. When the
  // repository's owner submits it, a workflow adds them to the list file
  // (.github/workflows/apply-list-additions.yml); from anyone else it's an
  // ordinary suggestion. The body's format is parsed by
  // scripts/apply-list-additions.mjs, so change them together.

  const REPO_URL = "https://github.com/jstock29/take-radar";
  const ADDITIONS_MARKER = "take-radar:additions";
  // Stay well under GitHub's limit on the length of an address.
  const MAX_ISSUE_URL = 7000;

  /** The starter list a synced list comes from, if it comes from this repo. */
  const starterOf = (list) => STARTERS.find((s) => s.url === list.source?.url);

  /** Names among `entries` that have no note. */
  const withoutNote = (entries) =>
    entries.map(splitEntry).filter((e) => !e.note).map((e) => e.name);

  /**
   * The address of a new issue asking for `entries` to be added to a starter
   * list's file, or "" if there are too many to fit in an address.
   */
  const additionsIssueUrl = (starter, entries) => {
    // Backticks would end the code block the names sit in.
    const lines = entries.map((e) => e.replace(/`/g, "'").replace(/\s+/g, " ").trim()).filter(Boolean);
    const body = [
      `<!-- ${ADDITIONS_MARKER} -->`,
      `Names to add to \`${starter.file}\`, sent from the Take Radar extension.`,
      "",
      "```",
      ...lines,
      "```",
      "",
    ].join("\n");
    const title = `Add ${lines.length} name${lines.length === 1 ? "" : "s"} to ${starter.file.split("/").pop()}`;
    const url = `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    return url.length > MAX_ISSUE_URL ? "" : url;
  };

  Object.assign(TR, {
    nameKey,
    cleanSelection,
    addSelection,
    pruneAdded,
    starterOf,
    withoutNote,
    additionsIssueUrl,
    ADDITIONS_MARKER,
  });
})();
