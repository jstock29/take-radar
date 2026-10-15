const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../../shared.js");
require("../../matcher.js");
const { parseListText, splitEntry, normalizeList, normalizeSettings, highlightStyle, STARTERS } =
  globalThis.TakeRadar;

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

    if (starter.id.endsWith("operatives")) {
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
