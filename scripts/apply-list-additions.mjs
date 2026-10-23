// Adds the names in a "Submit new names" issue to the starter list it names.
// Run by .github/workflows/apply-list-additions.yml for issues opened (or
// edited) by the repository owner; the issue's body is built by
// additionsIssueUrl() in shared.js and parsed here.
//
//   GITHUB_EVENT_PATH  the issue event (set by Actions)
//   GITHUB_OUTPUT      receives status=skip|rejected|nothing|changed, file, count
//   COMMENT_FILE       where to write the reply to post on the issue
//   LISTS_DIR          the folder of list files (default: lists/ in this repo)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("../shared.js");
require("../additions.js");
const { splitEntry, nameKey, ADDITIONS_MARKER } = globalThis.TakeRadar;

export const SECTION = "# Added from the extension (move into a section above when convenient)";
const MAX_ENTRIES = 100;
const MAX_NAME = 80;
const MAX_ENTRY = 300;

/** Why a line can't go in a list file, or "" if it can. */
export const problemWith = (entry) => {
  const { name } = splitEntry(entry);
  if (/[\u0000-\u001f\u007f]/.test(entry)) return "contains control characters";
  if (!name) return "has no name";
  if (name.startsWith("#")) return "would become a comment";
  if (!/\p{L}/u.test(name)) return "the name has no letters";
  if (name.length > MAX_NAME || entry.length > MAX_ENTRY) return "is too long";
  return "";
};

/**
 * Read an additions issue body. Returns null if it isn't one, otherwise
 * { file, entries }. Throws a message fit to post on the issue if it is one
 * but can't be used. `files` are the list files that exist (so the issue
 * can only ever write to one of those).
 */
export const parseIssue = (body, files) => {
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  if (!text.includes(`<!-- ${ADDITIONS_MARKER} -->`)) return null;

  const file = /`lists\/([A-Za-z0-9-]+\.txt)`/.exec(text)?.[1];
  if (!file) throw new Error("I couldn't tell which list this is for. It should name a file like `lists/example.txt`.");
  if (!files.includes(file)) throw new Error(`There's no list file called \`lists/${file}\`.`);

  const block = /^```[^\n]*\n([\s\S]*?)\n?```[ \t]*$/m.exec(text)?.[1];
  if (block == null) throw new Error("I couldn't find the names. They should be one per line inside a ``` code block.");
  const entries = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!entries.length) throw new Error("The code block has no names in it.");
  if (entries.length > MAX_ENTRIES) throw new Error(`That's ${entries.length} names; I take at most ${MAX_ENTRIES} at a time.`);
  return { file, entries };
};

/**
 * Add entries to a list file's text. Names already on the list (in any
 * spelling) or repeated in `entries` are left out, as are lines that can't
 * go in a list file. New names go under SECTION at the end, after any
 * already there. Returns { text, added, duplicates, invalid }.
 */
export const applyAdditions = (text, entries) => {
  const known = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) known.set(nameKey(splitEntry(t).name), splitEntry(t).name);
  }

  const added = [];
  const duplicates = [];
  const invalid = [];
  for (const entry of entries) {
    const problem = problemWith(entry);
    if (problem) {
      invalid.push({ entry, problem });
      continue;
    }
    const { name } = splitEntry(entry);
    const key = nameKey(name);
    if (known.has(key)) {
      duplicates.push({ entry, existing: known.get(key) });
      continue;
    }
    known.set(key, name);
    added.push(entry);
  }
  if (!added.length) return { text, added, duplicates, invalid };

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let at = lines.indexOf(SECTION);
  if (at === -1) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", SECTION);
    at = lines.length - 1;
  }
  // The section runs to the next heading or the end of the file; add after
  // its last name, not after the blank lines that follow it.
  let end = at + 1;
  while (end < lines.length && !lines[end].startsWith("#")) end++;
  while (end > at + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, ...added);

  return { text: lines.join("\n").replace(/\n*$/, "\n"), added, duplicates, invalid };
};

// --- The workflow's entry point ---------------------------------------------------------

const codeBlock = (lines) => ["```", ...lines, "```"].join("\n");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const run = ({ event, listsDir, setOutput, writeComment }) => {
  const files = fs.readdirSync(listsDir).filter((f) => f.endsWith(".txt"));

  let parsed;
  try {
    parsed = parseIssue(event.issue?.body, files);
  } catch (err) {
    setOutput("status", "rejected");
    writeComment(`${err.message}\n\nNothing was changed. Edit this issue to fix it and I'll try again.`);
    return;
  }
  if (!parsed) return setOutput("status", "skip");

  const { file, entries } = parsed;
  const target = path.join(listsDir, file);
  const result = applyAdditions(fs.readFileSync(target, "utf8"), entries);

  const notes = [];
  if (result.duplicates.length) {
    notes.push(
      `Already on the list, so left out:\n${codeBlock(result.duplicates.map((d) => `${splitEntry(d.entry).name} (as ${d.existing})`))}`,
    );
  }
  if (result.invalid.length) {
    notes.push(`Couldn't use these lines:\n${codeBlock(result.invalid.map((i) => `${i.entry}  (${i.problem})`))}`);
  }

  setOutput("file", file);
  setOutput("count", String(result.added.length));
  if (!result.added.length) {
    setOutput("status", "nothing");
    writeComment(["Nothing to add.", ...notes].join("\n\n"));
    return;
  }

  fs.writeFileSync(target, result.text);
  setOutput("status", "changed");
  writeComment(
    [
      `Added ${plural(result.added.length, "name")} to \`lists/${file}\`, under "${SECTION.slice(2)}":`,
      codeBlock(result.added),
      ...notes,
      "The extension drops them from *Your additions* the next time it refreshes the list (within 12 hours, or press Refresh).",
    ].join("\n\n"),
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputs = process.env.GITHUB_OUTPUT;
  run({
    event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
    listsDir: process.env.LISTS_DIR ?? path.join(root, "lists"),
    setOutput: (key, value) => (outputs ? fs.appendFileSync(outputs, `${key}=${value}\n`) : console.log(`${key}=${value}`)),
    writeComment: (text) => fs.writeFileSync(process.env.COMMENT_FILE, text + "\n"),
  });
}
