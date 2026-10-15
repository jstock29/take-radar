const test = require("node:test");
const assert = require("node:assert/strict");

require("../../shared.js");
require("../../matcher.js");
const { createMatcher, normalizeList } = globalThis.TakeRadar;

const matcherFor = (...names) =>
  createMatcher([normalizeList({ id: "l", name: "Test list", names })]);

// The exact substrings of `text` that get highlighted.
const found = (names, text) =>
  matcherFor(...names)
    .find(text)
    .map(({ start, end }) => text.slice(start, end));

test("finds a plain full name", () => {
  assert.deepEqual(found(["Ruth Okafor"], "A piece by Ruth Okafor today."), ["Ruth Okafor"]);
});

test("is case-insensitive", () => {
  assert.deepEqual(found(["Ruth Okafor"], "RUTH OKAFOR said"), ["RUTH OKAFOR"]);
});

test("ignores accents in either direction", () => {
  assert.deepEqual(found(["Tomas Ibarra"], "Tomás Ibarra wrote"), ["Tomás Ibarra"]);
  assert.deepEqual(found(["Tomás Ibarra"], "Tomas Ibarra wrote"), ["Tomas Ibarra"]);
});

test("folds letters that don't decompose (ø, ł, ß)", () => {
  assert.deepEqual(found(["Soren Lokke"], "Søren Løkke spoke"), ["Søren Løkke"]);
  assert.deepEqual(found(["Lukasz Grass"], "Łukasz Graß"), ["Łukasz Graß"]);
});

test("allows a middle initial the list doesn't have", () => {
  assert.deepEqual(found(["Ruth Okafor"], "Ruth A. Okafor"), ["Ruth A. Okafor"]);
  assert.deepEqual(found(["Ruth Okafor"], "Ruth A Okafor"), ["Ruth A Okafor"]);
});

test("matches initials written different ways", () => {
  for (const text of ["J.K. Lund", "JK Lund", "J. K. Lund", "J K Lund"]) {
    assert.deepEqual(found(["J.K. Lund"], `by ${text}.`), [text], text);
  }
});

test("treats curly and straight apostrophes alike", () => {
  assert.deepEqual(found(["Conan O'Brien"], "Conan O’Brien hosted"), ["Conan O’Brien"]);
});

test("ignores soft hyphens and zero-width characters inside names", () => {
  const text = "Ruth Oka­for and Ruth​ Okafor";
  assert.deepEqual(found(["Ruth Okafor"], text), ["Ruth Oka­for", "Ruth​ Okafor"]);
});

test("needs whole words", () => {
  assert.deepEqual(found(["Ann Lee"], "Joann Leeds and Ann Leeway"), []);
  assert.deepEqual(found(["Michael Steel"], "Michael Steele"), []);
});

test("prefers the longest name when names overlap", () => {
  const matches = matcherFor("Nicholas", "Nicholas A. Christakis").find("Nicholas A. Christakis wrote");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entry.name, "Nicholas A. Christakis");
});

test("returns offsets into the original (unfolded) text", () => {
  const text = "Ça va, Tomás Ibarra?";
  const [m] = matcherFor("Tomas Ibarra").find(text);
  assert.equal(text.slice(m.start, m.end), "Tomás Ibarra");
});

test("carries the note and list for the tooltip", () => {
  const [m] = matcherFor("Jane Doe | former campaign spokeswoman").find("Jane Doe said");
  assert.equal(m.entry.name, "Jane Doe");
  assert.equal(m.entry.note, "former campaign spokeswoman");
  assert.equal(m.entry.listName, "Test list");
});

test("the note isn't part of what's matched", () => {
  assert.deepEqual(found(["Jane Doe | spokeswoman"], "Jane Doe spokeswoman"), ["Jane Doe"]);
});

test("first list wins when two lists share a name", () => {
  const m = createMatcher([
    normalizeList({ id: "a", name: "A", names: ["Jane Doe"] }),
    normalizeList({ id: "b", name: "B", names: ["Jane Doe"] }),
  ]);
  assert.equal(m.find("Jane Doe")[0].entry.listId, "a");
});

test("returns null when there is nothing to match", () => {
  assert.equal(createMatcher([]), null);
  assert.equal(matcherFor("", "   "), null);
});

test("escapes regex characters in names", () => {
  assert.deepEqual(found(["A+ (B)"], "x A+ (B) y"), ["A+ (B)"]);
  assert.deepEqual(found(["Jo$h Smith"], "Jo$h Smith"), ["Jo$h Smith"]);
});

test("non-Latin names still match", () => {
  assert.deepEqual(found(["Юлия Навальная"], "Сегодня Юлия Навальная сказала"), ["Юлия Навальная"]);
  assert.deepEqual(found(["Юлия Навальная"], "Юлия Навальнаяя"), []);
});

test("handles many names quickly", () => {
  const names = Array.from({ length: 2000 }, (_, i) => `Person${i} Surname${i}`);
  const m = matcherFor(...names);
  const text = "Lorem ipsum ".repeat(2000) + "Person1999 Surname1999";
  const t0 = performance.now();
  const matches = m.find(text);
  assert.equal(matches.length, 1);
  assert.ok(performance.now() - t0 < 1000, "matching 24k chars against 2000 names took over 1s");
});
