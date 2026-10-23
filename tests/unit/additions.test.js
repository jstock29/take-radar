// The workflow that applies "Send to GitHub" issues to the list files
// (scripts/apply-list-additions.mjs).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../../shared.js");
const { STARTERS, additionsIssueUrl, parseListText, splitEntry } = globalThis.TakeRadar;
const script = import("../../scripts/apply-list-additions.mjs");

const GOP = STARTERS.find((s) => s.id === "republican-operatives");
const FILES = ["republican-operatives.txt", "democratic-operatives.txt"];

// What GitHub would store for the issue the extension's button opens.
const issueBodyFor = (entries) => new URL(additionsIssueUrl(GOP, entries)).searchParams.get("body");

const LIST = `# Header
#
# Format: Name | note

# Strategists
Alex Conant | Republican strategist
Zoë O'Neil | Republican strategist

# Commentators
Ana Navarro | Republican strategist
`;

test("an issue made by the extension parses back to the same names", async () => {
  const { parseIssue } = await script;
  const entries = ["Jane Doe | pollster; ran a 2016 campaign", "John Roe | note with | a pipe"];
  assert.deepEqual(parseIssue(issueBodyFor(entries), FILES), { file: "republican-operatives.txt", entries });
});

test("GitHub's CRLF line endings, and surrounding prose, don't matter", async () => {
  const { parseIssue } = await script;
  const body = ["Hi!", "", issueBodyFor(["Jane Doe | pollster"]), "Thanks"].join("\n").replace(/\n/g, "\r\n");
  assert.deepEqual(parseIssue(body, FILES).entries, ["Jane Doe | pollster"]);
});

test("other issues are ignored; broken or hostile additions issues are refused", async () => {
  const { parseIssue } = await script;
  assert.equal(parseIssue("Please add Jane Doe to the list", FILES), null);
  assert.equal(parseIssue(null, FILES), null);

  const marker = "<!-- take-radar:additions -->";
  assert.throws(() => parseIssue(`${marker}\nno file here\n\`\`\`\nA B\n\`\`\``, FILES), /which list/);
  assert.throws(() => parseIssue(`${marker}\n\`lists/nope.txt\`\n\`\`\`\nA B\n\`\`\``, FILES), /no list file called/);
  assert.throws(() => parseIssue(`${marker}\n\`lists/../manifest.json\`\n\`\`\`\nA B\n\`\`\``, FILES), /which list/);
  assert.throws(() => parseIssue(`${marker}\n\`lists/republican-operatives.txt\`\nA B`, FILES), /code block/);
  assert.throws(() => parseIssue(`${marker}\n\`lists/republican-operatives.txt\`\n\`\`\`\n\n\`\`\``, FILES), /no names/);
  const many = Array.from({ length: 101 }, (_, i) => `Person ${i}`).join("\n");
  assert.throws(() => parseIssue(`${marker}\n\`lists/republican-operatives.txt\`\n\`\`\`\n${many}\n\`\`\``, FILES), /at most 100/);
});

test("new names go under one section at the end, in any spelling check", async () => {
  const { applyAdditions, SECTION } = await script;
  const first = applyAdditions(LIST, ["Jane Doe | pollster", "John Roe | strategist"]);
  assert.deepEqual(first.added, ["Jane Doe | pollster", "John Roe | strategist"]);
  assert.equal(first.text, `${LIST}\n${SECTION}\nJane Doe | pollster\nJohn Roe | strategist\n`);

  // Later additions join the same section, even with another heading after it.
  const withAfter = `${first.text}\n# Later section\nSam Late | a note\n`;
  const second = applyAdditions(withAfter, ["Ann Lee | pollster"]);
  assert.equal(
    second.text,
    `${LIST}\n${SECTION}\nJane Doe | pollster\nJohn Roe | strategist\nAnn Lee | pollster\n\n# Later section\nSam Late | a note\n`,
  );
  // Nothing in the original text is lost.
  assert.deepEqual(parseListText(second.text).slice(0, 3), parseListText(LIST));
});

test("names already on the list, repeated, or unusable are reported, not added", async () => {
  const { applyAdditions } = await script;
  const result = applyAdditions(LIST, [
    "zoe o’neil | already here, different spelling",
    "Jane Doe | pollster",
    "JANE DOE | repeated",
    "# a comment",
    "| no name",
    "12345",
    "x".repeat(81),
  ]);
  assert.deepEqual(result.added, ["Jane Doe | pollster"]);
  assert.deepEqual(result.duplicates.map((d) => d.existing), ["Zoë O'Neil", "Jane Doe"]);
  assert.deepEqual(
    result.invalid.map((i) => i.problem),
    ["would become a comment", "has no name", "the name has no letters", "is too long"],
  );
  // Only the one new name is in the file.
  assert.equal(parseListText(result.text).length, parseListText(LIST).length + 1);

  assert.equal(applyAdditions(LIST, ["Alex Conant"]).text, LIST, "no change when nothing is added");
});

test("the script edits the file named in the issue and writes the reply", async () => {
  const { run } = await script;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-radar-lists-"));
  for (const f of FILES) fs.writeFileSync(path.join(dir, f), LIST);
  const outputs = {};
  let comment = "";
  const go = (body) =>
    run({
      event: { issue: { body } },
      listsDir: dir,
      setOutput: (k, v) => (outputs[k] = v),
      writeComment: (t) => (comment = t),
    });

  go("just a regular issue");
  assert.equal(outputs.status, "skip");

  go(issueBodyFor(["Jane Doe | pollster", "Alex Conant | already there"]));
  assert.equal(outputs.status, "changed");
  assert.equal(outputs.file, "republican-operatives.txt");
  assert.equal(outputs.count, "1");
  assert.match(fs.readFileSync(path.join(dir, "republican-operatives.txt"), "utf8"), /\nJane Doe \| pollster\n$/);
  assert.equal(fs.readFileSync(path.join(dir, "democratic-operatives.txt"), "utf8"), LIST, "other lists untouched");
  assert.match(comment, /Added 1 name to `lists\/republican-operatives\.txt`/);
  assert.match(comment, /Alex Conant \(as Alex Conant\)/);

  go(issueBodyFor(["Jane Doe | pollster"]));
  assert.equal(outputs.status, "nothing", "sending the same names again changes nothing");

  go(`<!-- take-radar:additions -->\n\`lists/other.txt\`\n\`\`\`\nA B\n\`\`\``);
  assert.equal(outputs.status, "rejected");
  assert.match(comment, /Nothing was changed/);
});

test("a committed list file stays well formed after additions", async () => {
  const { applyAdditions } = await script;
  const real = fs.readFileSync(path.join(__dirname, "../../lists/republican-operatives.txt"), "utf8");
  const { text } = applyAdditions(real, ["Zzyzx Fixture | a name no real list will ever contain"]);
  const entries = parseListText(text);
  assert.equal(entries.length, parseListText(real).length + 1);
  assert.equal(splitEntry(entries.at(-1)).name, "Zzyzx Fixture");
});
