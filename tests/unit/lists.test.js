const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../../shared.js");
require("../../matcher.js");
const {
  parseListText,
  splitEntry,
  normalizeList,
  normalizeSettings,
  highlightStyle,
  combinedHighlightStyle,
  listEntries,
  cleanSelection,
  addSelection,
  pruneAdded,
  starterOf,
  withoutNote,
  additionsIssueUrl,
  createMatcher,
  STARTERS,
} = globalThis.TakeRadar;

test("text lists: one per line, # comments and blanks skipped", () => {
  const text = "# header\n\nJane Doe\n  John Roe  \n# another\r\nAnn Lee | pollster\n";
  assert.deepEqual(parseListText(text), ["Jane Doe", "John Roe", "Ann Lee | pollster"]);
});

test("text lists: a byte-order mark doesn't end up in the first name", () => {
  assert.deepEqual(parseListText("﻿Jane Doe\nJohn Roe"), ["Jane Doe", "John Roe"]);
});

test("splitEntry separates the note at the first |", () => {
  assert.deepEqual(splitEntry("Jane Doe | a | b"), { name: "Jane Doe", note: "a | b" });
  assert.deepEqual(splitEntry("Jane Doe"), { name: "Jane Doe", note: "" });
});

test("CSV with a name column uses it, plus a note column", () => {
  const csv = 'id,Name,Role\n1,"Doe, Jane",pollster\n2,John Roe,\n3,,ignored';
  assert.deepEqual(parseListText(csv, { csv: true }), ["Doe, Jane | pollster", "John Roe"]);
});

test("CSV handles escaped quotes", () => {
  const csv = 'name,note\nJane Doe,"said ""no"""';
  assert.deepEqual(parseListText(csv, { csv: true }), ['Jane Doe | said "no"']);
});

test("CSV without a header treats every cell as a name", () => {
  assert.deepEqual(parseListText("Jane Doe,John Roe\nAnn Lee", { csv: true }), [
    "Jane Doe",
    "John Roe",
    "Ann Lee",
  ]);
});

test("normalizeList upgrades the 0.3 `color` field and keeps sources", () => {
  const list = normalizeList({
    id: "x",
    name: "Old",
    color: "#ff0000",
    names: ["A", 3, "B"],
    source: { url: "https://example.com/a.txt", updatedAt: "5" },
  });
  assert.equal(list.fill, "#ff0000ff");
  assert.deepEqual(list.names, ["A", "B"]);
  assert.deepEqual(list.source, { url: "https://example.com/a.txt", updatedAt: 5, error: "" });
});

test("normalizeSettings fills defaults and drops junk", () => {
  assert.deepEqual(normalizeSettings(undefined), { paused: false, disabledHosts: [] });
  assert.deepEqual(normalizeSettings({ paused: 1, disabledHosts: ["a.com", 2] }), {
    paused: true,
    disabledHosts: ["a.com"],
  });
});

test("highlight text color is only forced on mostly-opaque fills", () => {
  const props = (fill) => Object.fromEntries(highlightStyle({ fill, border: "#000000ff" }));
  assert.equal(props("#ff8c00ff").color, "#000");
  assert.equal(props("#000080ff").color, "#fff");
  assert.equal(props("#ff8c0026").color, undefined);
});

test("normalizeList keeps enabled/followups only when turned off", () => {
  assert.equal("enabled" in normalizeList({ enabled: true }), false);
  assert.equal(normalizeList({ enabled: false }).enabled, false);
  assert.equal(normalizeList({ followups: false }).followups, false);
});

test("a name on several lists gets stripes and nested border rings", () => {
  const a = { fill: "#ff0000ff", border: "#ff0000ff", borderWidth: 1 };
  const b = { fill: "#0000ff26", border: "#0000ffff", borderWidth: 2 };
  const c = { fill: "#00ff0000", border: "#00ff00ff", borderWidth: 0 };
  const props = Object.fromEntries(combinedHighlightStyle([a, b, c]));
  assert.match(props["background-image"], /^repeating-linear-gradient\(135deg, /);
  assert.equal(
    props["background-image"],
    "repeating-linear-gradient(135deg, rgba(255, 0, 0, 1) 0px 5px, rgba(0, 0, 255, 0.149) 5px 10px, rgba(0, 255, 0, 0) 10px 15px)",
  );
  // Rings nest outward in list order; lists without a border add none.
  assert.equal(props["box-shadow"], "0 0 0 1px rgba(255, 0, 0, 1), 0 0 0 3px rgba(0, 0, 255, 1)");
  assert.equal(props.margin, "0 3px");
  assert.equal(props.color, undefined, "translucent stripes leave the page's text color alone");
});

test("solid stripes pick a text color for their average", () => {
  const dark = { fill: "#000080ff", border: "#000000ff", borderWidth: 0 };
  const darker = { fill: "#200000ff", border: "#000000ff", borderWidth: 0 };
  assert.equal(Object.fromEntries(combinedHighlightStyle([dark, darker])).color, "#fff");
});

test("a single list keeps its normal style", () => {
  const list = { fill: "#ff8c00ff", border: "#ff8c00ff", borderWidth: 0 };
  assert.deepEqual(combinedHighlightStyle([list]), highlightStyle(list));
});

// --- Names you add yourself ----------------------------------------------------------

test("selected text is tidied into a name, or refused", () => {
  assert.equal(cleanSelection("  Jane\n  Doe "), "Jane Doe");
  assert.equal(cleanSelection("\u201cJane Doe,\u201d"), "Jane Doe");
  assert.equal(cleanSelection("Bannon\u2019s"), "Bannon");
  assert.equal(cleanSelection("Ruth A. Okafor."), "Ruth A. Okafor");
  assert.equal(cleanSelection("Zo\u00eb O'Neil"), "Zo\u00eb O'Neil");
  assert.equal(cleanSelection(""), "");
  assert.equal(cleanSelection("12345"), "", "needs a letter");
  assert.equal(cleanSelection("Jane | note"), "", "a | would split off a note");
  assert.equal(cleanSelection("This is a whole sentence and not a name"), "");
});

test("adding to a synced list goes in `added`; to your own list, in `names`", () => {
  const synced = normalizeList({ names: ["Jane Doe | pollster"], source: { url: "https://x.test/a.txt" } });
  assert.deepEqual(addSelection(synced, "John Roe"), { status: "added", name: "John Roe" });
  assert.deepEqual(synced.names, ["Jane Doe | pollster"], "the synced names are left alone");
  assert.deepEqual(synced.added, ["John Roe"]);

  const own = normalizeList({ names: ["Jane Doe"] });
  addSelection(own, "John Roe");
  assert.deepEqual(own.names, ["Jane Doe", "John Roe"]);
  assert.equal("added" in own, false);
});

test("adding someone already on the list (in any spelling) does nothing", () => {
  const list = normalizeList({
    names: ["Zo\u00eb O'Neil | strategist"],
    added: ["Jane Doe"],
    source: { url: "https://x.test/a.txt" },
  });
  assert.deepEqual(addSelection(list, "zoe o\u2019neil"), { status: "duplicate", name: "Zo\u00eb O'Neil" });
  assert.deepEqual(addSelection(list, "JANE  DOE"), { status: "duplicate", name: "Jane Doe" });
  assert.deepEqual(addSelection(list, "not a name !!"), { status: "added", name: "not a name" });
  assert.deepEqual(addSelection(list, "..."), { status: "invalid", name: "" });
  assert.deepEqual(list.added, ["Jane Doe", "not a name"]);
});

test("additions are matched like any other name, with their notes", () => {
  const list = normalizeList({
    id: "gop",
    name: "GOP",
    names: ["Jane Doe"],
    added: ["John Roe | added by hand"],
    source: { url: "https://x.test/a.txt" },
  });
  assert.deepEqual(listEntries(list), ["Jane Doe", "John Roe | added by hand"]);
  const found = createMatcher([list]).find("Then John Roe spoke.");
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].entry.lists, [{ listId: "gop", listName: "GOP", note: "added by hand" }]);
});

test("a refresh drops additions the source now lists, and keeps the rest", () => {
  const source = ["Jane Doe | pollster", "Zo\u00eb O'Neil"];
  assert.deepEqual(pruneAdded(["jane doe", "John Roe | by hand", "Zoe O'Neil"], source), ["John Roe | by hand"]);
  assert.deepEqual(pruneAdded(undefined, source), []);
});

test("the operative lists require notes; the Harper's list doesn't", () => {
  assert.deepEqual(
    STARTERS.filter((s) => s.requireNotes).map((s) => s.id),
    ["republican-operatives", "democratic-operatives"],
  );
});

test("a synced list is matched to its starter by source URL, and notes are checked", () => {
  const gop = STARTERS[0];
  assert.equal(starterOf({ source: { url: gop.url } }), gop);
  assert.equal(starterOf({ source: { url: "https://example.com/other.txt" } }), undefined);
  assert.equal(starterOf({}), undefined);
  assert.deepEqual(withoutNote(["Jane Doe | pollster", "John Roe", "Ann Lee |  "]), ["John Roe", "Ann Lee"]);
});

test("the issue address holds the file and names, and gives up when there are too many", () => {
  const gop = STARTERS[0];
  const url = new URL(additionsIssueUrl(gop, ["Jane Doe | pollster", "John `Roe` | a   b"]));
  assert.equal(url.origin + url.pathname, "https://github.com/jstock29/take-radar/issues/new");
  assert.equal(url.searchParams.get("title"), "Add 2 names to republican-operatives.txt");
  const body = url.searchParams.get("body");
  assert.match(body, /^<!-- take-radar:additions -->\n/);
  assert.match(body, /`lists\/republican-operatives\.txt`/);
  assert.match(body, /```\nJane Doe \| pollster\nJohn 'Roe' \| a b\n```/, "backticks and runs of spaces are cleaned");
  assert.equal(new URL(additionsIssueUrl(gop, ["Solo"])).searchParams.get("title"), "Add 1 name to republican-operatives.txt");

  const many = Array.from({ length: 200 }, (_, i) => `Person Number${i} | a fairly long note about who this person is`);
  assert.equal(additionsIssueUrl(gop, many), "");
});

test("normalizeList keeps `added` only beside a source", () => {
  const synced = normalizeList({ names: ["A"], added: ["B", 3], source: { url: "https://x.test/a.txt" } });
  assert.deepEqual(synced.added, ["B"]);
  assert.equal("added" in normalizeList({ names: ["A"], source: { url: "https://x.test/a.txt" } }), false);
  // A list that stopped syncing folds its additions into its names.
  const own = normalizeList({ names: ["A"], added: ["B"] });
  assert.deepEqual(own.names, ["A", "B"]);
  assert.equal("added" in own, false);
});

// --- The bundled starter lists ------------------------------------------------------

const root = path.join(__dirname, "../..");

for (const starter of STARTERS) {
  test(`starter list ${starter.id} is well formed`, () => {
    const text = fs.readFileSync(path.join(root, starter.file), "utf8");
    const entries = parseListText(text);
    assert.ok(entries.length >= 20, "suspiciously short");

    const names = entries.map((e) => splitEntry(e).name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, [], "duplicate names");

    if (starter.requireNotes) {
      const missing = entries.filter((e) => !splitEntry(e).note);
      assert.deepEqual(missing, [], "every operative needs a note saying who they are");
    }
    assert.ok(starter.url.endsWith(path.basename(starter.file)), "sync URL points at the same file");
  });
}

test("the two operative lists don't share anyone", () => {
  const read = (id) => {
    const s = STARTERS.find((x) => x.id === id);
    return parseListText(fs.readFileSync(path.join(root, s.file), "utf8")).map((e) => splitEntry(e).name);
  };
  const r = new Set(read("republican-operatives"));
  assert.deepEqual(read("democratic-operatives").filter((n) => r.has(n)), []);
});
