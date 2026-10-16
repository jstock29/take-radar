const test = require("node:test");
const assert = require("node:assert/strict");

require("../../shared.js");
require("../../matcher.js");
const { createMatcher, createFollowupMatcher, surnameOf, normalizeList } = globalThis.TakeRadar;

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

test("carries the note and list for the hover card", () => {
  const [m] = matcherFor("Jane Doe | former campaign spokeswoman").find("Jane Doe said");
  assert.equal(m.entry.name, "Jane Doe");
  assert.deepEqual(m.entry.lists, [
    { listId: "l", listName: "Test list", note: "former campaign spokeswoman" },
  ]);
});

test("the note isn't part of what's matched", () => {
  assert.deepEqual(found(["Jane Doe | spokeswoman"], "Jane Doe spokeswoman"), ["Jane Doe"]);
});

test("a name on several lists is one match carrying every list, in list order", () => {
  const m = createMatcher([
    normalizeList({ id: "a", name: "A", names: ["Jane Doe | note a"] }),
    normalizeList({ id: "b", name: "B", names: ["Someone Else"] }),
    normalizeList({ id: "c", name: "C", names: ["jane doe | note c"] }),
  ]);
  const matches = m.find("Jane Doe");
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].entry.lists, [
    { listId: "a", listName: "A", note: "note a" },
    { listId: "c", listName: "C", note: "note c" },
  ]);
});

test("spellings that match the same way count as the same person", () => {
  const m = createMatcher([
    normalizeList({ id: "a", name: "A", names: ["Ruth Okafor"] }),
    normalizeList({ id: "b", name: "B", names: ["Ruth A. Okafor"] }),
  ]);
  assert.deepEqual(m.find("Ruth Okafor")[0].entry.lists.map((l) => l.listId), ["a", "b"]);
});

test("a name listed twice on one list appears once, keeping a note", () => {
  const [match] = matcherFor("Jane Doe", "Jane Doe | the note").find("Jane Doe");
  assert.deepEqual(match.entry.lists, [{ listId: "l", listName: "Test list", note: "the note" }]);
});

test("hidden lists are left out", () => {
  const m = createMatcher([
    normalizeList({ id: "a", name: "A", names: ["Jane Doe"], enabled: false }),
    normalizeList({ id: "b", name: "B", names: ["Jane Doe"] }),
  ]);
  assert.deepEqual(m.find("Jane Doe")[0].entry.lists.map((l) => l.listId), ["b"]);
  assert.equal(createMatcher([normalizeList({ names: ["Jane Doe"], enabled: false })]), null);
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

// --- Later mentions by last name ---------------------------------------------------

// Surname-only matches in `text`, given the names found in full on the page.
const followups = (names, text, listOptions = {}) => {
  const m = createMatcher([normalizeList({ id: "l", name: "L", names, ...listOptions })]);
  const f = createFollowupMatcher(m?.entries ?? []);
  return f ? f.find(text).map(({ start, end }) => text.slice(start, end)) : [];
};

test("surnameOf skips suffixes and refuses unusable surnames", () => {
  assert.equal(surnameOf("Harold Ford Jr."), "Ford");
  assert.equal(surnameOf("Celinda Lake"), "Lake");
  assert.equal(surnameOf("Symone Sanders-Townsend"), "Sanders-Townsend");
  assert.equal(surnameOf("Madonna"), null);
  assert.equal(surnameOf("Ann Li"), null); // too short to be safe
  assert.equal(surnameOf("Ludwig van"), null); // lowercase
});

test("later surname mentions match, with or without an honorific", () => {
  assert.deepEqual(followups(["Doug Heye"], "Mr. Heye said so. Later, Heye agreed. Heye's view"), [
    "Heye",
    "Heye",
    "Heye",
  ]);
});

test("surname matches are case-sensitive and whole-word", () => {
  assert.deepEqual(followups(["Doug Heye"], "heye Heyes OHeye"), []);
});

test("skips surnames that look like part of another proper name", () => {
  assert.deepEqual(followups(["Celinda Lake"], "Lake Tahoe and the Great Salt Lake"), []);
});

test("everyday-word surnames need an honorific at the start of a sentence", () => {
  const text = "Short of that, nothing. Mr. Short left. The deal, Short said, was done.";
  assert.deepEqual(followups(["Marc Short"], text), ["Short", "Short"]);
});

test("a surname shared by two people found on the page is ambiguous", () => {
  assert.deepEqual(followups(["Stan Greenberg", "Anna Greenberg"], "Greenberg said"), []);
});

test("lists can turn surname matching off", () => {
  assert.deepEqual(followups(["Doug Heye"], "Mr. Heye said", { followups: false }), []);
});
