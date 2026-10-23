// End-to-end tests: load the unpacked extension in Chromium and check what it
// does to real pages. Run with `npm run test:e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Test exactly what ships: build the store zip and load it unpacked.
const buildExtension = () => {
  const zip = execFileSync(path.join(REPO, "scripts/package.sh"), { encoding: "utf8" }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-radar-"));
  execFileSync("unzip", ["-q", path.resolve(REPO, zip), "-d", dir]);
  return dir;
};

// --- A tiny site to test against --------------------------------------------------

const PAGES = {
  "/article.html": `<!doctype html><title>Article</title><body>
    <p id="plain">Today Jane Doe and John Roe wrote, and so did Ruth A. Okafor.</p>
    <p id="editable" contenteditable>Editable: Jane Doe</p>
    <textarea>Jane Doe</textarea>
    <svg width="200" height="30"><text x="0" y="20">Jane Doe</text></svg>
    <div id="late"></div>
    <script>setTimeout(() => (document.getElementById("late").textContent = "Later: John Roe"), 300)</script>
  </body>`,

  "/news.html": `<!doctype html><title>News</title><body style="font: 16px sans-serif">
    <p id="p1">Celinda Lake, a pollster, and Doug Heye, a strategist, disagreed.</p>
    <p id="p2">"It's close," Ms. Lake said. Heye was less sure. They met at Lake Tahoe.</p>
    <div style="height: 3000px"></div>
    <p id="bottom">At the end, Doug Heye spoke again.</p>
    <div id="late"></div>
    <script>setTimeout(() => (document.getElementById("late").textContent = "Mr. Heye left early."), 300)</script>
  </body>`,

  "/shadow.html": `<!doctype html><title>Shadow</title><body>
    <div id="open-host"></div><div id="closed-host"></div><div id="late-host"></div>
    <script>
      document.getElementById("open-host").attachShadow({ mode: "open" })
        .innerHTML = "<p>Open root: <b>Jane Doe</b></p>";
      window.closedRoot = document.getElementById("closed-host").attachShadow({ mode: "closed" });
      window.closedRoot.innerHTML = "<p>Closed root: John Roe</p>";
      const late = document.getElementById("late-host").attachShadow({ mode: "open" });
      setTimeout(() => (late.innerHTML = "<p>Late shadow text: Ruth Okafor</p>"), 300);
      // A custom element that renders into its shadow root when connected.
      customElements.define("x-card", class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML = "<span>Card: Jane Doe</span>";
        }
      });
      setTimeout(() => document.body.append(document.createElement("x-card")), 300);
    </script>
  </body>`,
};

let listBody = "# a list served over HTTP\nPat Example | from the URL list\nSam Sample\n";

let server;
let base;

// --- The browser ------------------------------------------------------------------

let context;
let worker;
let extensionId;

const PEOPLE = {
  id: "people",
  name: "People",
  fill: "#ff8c00ff",
  border: "#ff8c00ff",
  borderWidth: 0,
  names: ["Jane Doe | a note about Jane", "John Roe", "Ruth Okafor"],
};

const setStorage = (values) => worker.evaluate((v) => chrome.storage.local.set(v), values);
const getStorage = (key) => worker.evaluate((k) => chrome.storage.local.get(k), key);

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/list.txt") {
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(listBody);
    }
    const page = PAGES[url.pathname];
    res.writeHead(page ? 200 : 404, { "Content-Type": "text/html" });
    res.end(page ?? "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const extension = buildExtension();
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;

  // The welcome tab opened on install isn't needed here.
  await new Promise((r) => setTimeout(r, 500));
  for (const page of context.pages()) if (page.url().startsWith("chrome-extension://")) await page.close();
});

after(async () => {
  await context?.close();
  server?.close();
});

const reset = async (extra = {}) => {
  await setStorage({ lists: [PEOPLE], settings: { paused: false, disabledHosts: [] }, ...extra });
};

const highlights = (page) =>
  page.evaluate(() => {
    const out = [];
    const walk = (root) => {
      root.querySelectorAll(".take-radar-highlight").forEach((s) => out.push(s.textContent));
      root.querySelectorAll("*").forEach((el) => el.shadowRoot && walk(el.shadowRoot));
    };
    walk(document);
    if (window.closedRoot) walk(window.closedRoot);
    return out.sort();
  });

const waitForHighlights = async (page, expected) => {
  const want = [...expected].sort();
  for (let i = 0; i < 40; i++) {
    const got = await highlights(page);
    if (JSON.stringify(got) === JSON.stringify(want)) return got;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(await highlights(page), want);
};

// The hover card's visible text, line by line (null if it isn't showing).
const hoverCard = async (page) => {
  await page.waitForFunction(() => document.querySelector("take-radar-card")?.style.visibility === "visible");
  return page.evaluate(() =>
    [...document.querySelector("take-radar-card").shadowRoot.querySelectorAll(".name, .sub, .list, .note")].map(
      (n) => n.textContent,
    ),
  );
};

const badgeFor = (page) =>
  worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.action.getBadgeText({ tabId: tab.id });
  });

const openPage = async (pathname, host = base) => {
  const page = await context.newPage();
  await page.goto(host + pathname);
  await page.bringToFront();
  return page;
};

// --- Page highlighting ---------------------------------------------------------------

test("highlights names, skips editable areas and SVG, and catches late content", async () => {
  await reset();
  const page = await openPage("/article.html");
  await waitForHighlights(page, ["Jane Doe", "John Roe", "Ruth A. Okafor", "John Roe"]);

  // Hovering shows the card with the list and the note.
  await page.hover("#plain .take-radar-highlight");
  assert.deepEqual(await hoverCard(page), ["Jane Doe", "People", "a note about Jane"]);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("take-radar-card").style.visibility === "hidden");
  await page.close();
});

test("highlights inside open and closed shadow roots, including ones filled later", async () => {
  await reset();
  const page = await openPage("/shadow.html");
  await waitForHighlights(page, ["Jane Doe", "John Roe", "Ruth Okafor", "Jane Doe"]);

  // Styles are inline, so they apply inside shadow roots too.
  const bg = await page.evaluate(
    () => getComputedStyle(document.getElementById("open-host").shadowRoot.querySelector("span")).backgroundColor,
  );
  assert.equal(bg, "rgb(255, 140, 0)");
  await page.close();
});

test("a style change repaints existing highlights without re-scanning", async () => {
  await reset();
  const page = await openPage("/article.html");
  await waitForHighlights(page, ["Jane Doe", "John Roe", "Ruth A. Okafor", "John Roe"]);
  await page.evaluate(() => (window.firstSpan = document.querySelector(".take-radar-highlight")));

  await setStorage({ lists: [{ ...PEOPLE, fill: "#0a84ffff" }] });
  await page.waitForFunction(() => window.firstSpan.style.backgroundColor === "rgb(10, 132, 255)");
  assert.ok(await page.evaluate(() => window.firstSpan.isConnected), "same element, not rebuilt");
  await page.close();
});

// --- Count badge ---------------------------------------------------------------------

test("the toolbar badge counts highlights on the current tab", async () => {
  await reset();
  const page = await openPage("/article.html");
  await waitForHighlights(page, ["Jane Doe", "John Roe", "Ruth A. Okafor", "John Roe"]);
  await page.waitForTimeout(400);
  assert.equal(await badgeFor(page), "4");
  await page.close();
});

// --- Pausing ------------------------------------------------------------------------------

test("pausing removes highlights and shows 'off'; resuming brings them back", async () => {
  await reset();
  const page = await openPage("/article.html");
  await waitForHighlights(page, ["Jane Doe", "John Roe", "Ruth A. Okafor", "John Roe"]);

  await setStorage({ settings: { paused: true, disabledHosts: [] } });
  await waitForHighlights(page, []);
  await page.waitForTimeout(300);
  assert.equal(await badgeFor(page), "off");

  await setStorage({ settings: { paused: false, disabledHosts: [] } });
  await waitForHighlights(page, ["Jane Doe", "John Roe", "Ruth A. Okafor", "John Roe"]);
  await page.close();
});

test("turning a site off only affects that site", async () => {
  await reset({ settings: { paused: false, disabledHosts: ["localhost"] } });
  const off = await openPage("/article.html", base.replace("127.0.0.1", "localhost"));
  const on = await openPage("/article.html");
  await waitForHighlights(on, ["Jane Doe", "John Roe", "Ruth A. Okafor", "John Roe"]);
  await off.waitForTimeout(500);
  assert.deepEqual(await highlights(off), []);
  await off.close();
  await on.close();
});

// --- The settings panel --------------------------------------------------------------------

const openPanel = async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page;
};

test("starter lists are opt-in and add from the bundled copy", async () => {
  await setStorage({ lists: [] });
  const panel = await openPanel();
  await panel.waitForSelector(".starter");
  assert.equal(await panel.locator(".list").count(), 0, "nothing is pre-installed");
  assert.equal(await panel.locator(".starter").count(), 3);

  await panel.locator(".starter", { hasText: "Republican operatives" }).getByRole("button").click();
  await panel.waitForSelector(".list");
  assert.equal(await panel.locator(".starter").count(), 2, "added starter disappears from the offer");

  const { lists } = await getStorage("lists");
  assert.equal(lists.length, 1);
  assert.equal(lists[0].starterId, "republican-operatives");
  assert.ok(lists[0].names.length > 50);
  assert.match(lists[0].source.url, /lists\/republican-operatives\.txt$/);
  await panel.close();
});

test("a list can be added from a URL and refreshed later", async () => {
  await setStorage({ lists: [] });
  const panel = await openPanel();
  await panel.click("#urlBtn");
  await panel.fill("#urlInput", `${base}/list.txt`);
  await panel.click("#urlForm button[type=submit]");
  await panel.waitForSelector(".list");

  await panel.waitForTimeout(400); // debounced save
  let { lists } = await getStorage("lists");
  assert.equal(lists[0].name, "List");
  assert.deepEqual(lists[0].names, ["Pat Example | from the URL list", "Sam Sample"]);

  // The list changes upstream; a refresh picks it up and the card updates.
  listBody = "Pat Example\nSam Sample\nNew Person\n";
  const result = await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "refresh-lists", ids: [id] }), lists[0].id);
  assert.equal(result[lists[0].id], "ok");
  ({ lists } = await getStorage("lists"));
  assert.deepEqual(lists[0].names, ["Pat Example", "Sam Sample", "New Person"]);
  await panel.waitForFunction(() => document.querySelector(".count").textContent === "3 names");
  await panel.close();
});

test("the panel's on/off switch pauses highlighting", async () => {
  await reset();
  const panel = await openPanel();
  await panel.click("#powerBtn");
  await panel.waitForTimeout(200);
  assert.equal((await getStorage("settings")).settings.paused, true);
  assert.equal(await panel.getAttribute("#powerBtn", "aria-checked"), "false");
  await panel.click("#powerBtn");
  await panel.waitForTimeout(200);
  assert.equal((await getStorage("settings")).settings.paused, false);
  await panel.close();
});

// --- Names on several lists, and later mentions -----------------------------------------

const GOP = {
  id: "r",
  name: "Republican operatives",
  fill: "#ff3b3026",
  border: "#ff3b30ff",
  borderWidth: 1,
  names: ["Doug Heye | GOP strategist", "Celinda Lake"],
};
const DEM = {
  id: "d",
  name: "Democratic operatives",
  fill: "#0a84ff26",
  border: "#0a84ffff",
  borderWidth: 1,
  names: ["Celinda Lake | Democratic pollster"],
};
const NEWS_ALL = ["Celinda Lake", "Doug Heye", "Doug Heye", "Heye", "Heye", "Lake"];

test("a name on two lists is hatched, and the card shows both lists", async () => {
  await reset({ lists: [GOP, DEM] });
  const page = await openPage("/news.html");
  await waitForHighlights(page, NEWS_ALL);

  const lake = page.locator("#p1 .take-radar-highlight", { hasText: "Celinda Lake" });
  assert.equal(await lake.getAttribute("data-take-radar-list"), "r,d");
  assert.match(await lake.evaluate((s) => getComputedStyle(s).backgroundImage), /repeating-linear-gradient/);
  assert.match(await lake.evaluate((s) => getComputedStyle(s).boxShadow), /rgb\(255, 59, 48\).*rgb\(10, 132, 255\)/);

  await lake.hover();
  assert.deepEqual(await hoverCard(page), [
    "Celinda Lake",
    "Republican operatives",
    "Democratic operatives",
    "Democratic pollster",
  ]);
  await page.close();
});

test("later mentions by last name are highlighted, but not look-alikes", async () => {
  await reset({ lists: [GOP, DEM] });
  const page = await openPage("/news.html");
  // "Ms. Lake" and both "Heye" mentions (one added late); not "Lake Tahoe".
  await waitForHighlights(page, NEWS_ALL);

  await page.locator("#p2 .take-radar-highlight", { hasText: "Heye" }).hover();
  assert.deepEqual(await hoverCard(page), [
    "Doug Heye",
    "Mentioned by last name",
    "Republican operatives",
    "GOP strategist",
  ]);
  await page.close();
});

test("a list can turn off last-name matches, or be hidden entirely", async () => {
  await reset({ lists: [{ ...GOP, followups: false }, DEM] });
  const page = await openPage("/news.html");
  // Heye is only on the list with follow-ups off; Lake is also on DEM.
  await waitForHighlights(page, ["Celinda Lake", "Doug Heye", "Doug Heye", "Lake"]);

  await setStorage({ lists: [{ ...GOP, enabled: false }, DEM] });
  await waitForHighlights(page, ["Celinda Lake", "Lake"]);
  assert.equal(await page.getAttribute("#p1 .take-radar-highlight", "data-take-radar-list"), "d");
  await page.close();
});

test("the popup can list who's on the page and scroll to each mention", async () => {
  await reset({ lists: [GOP, DEM] });
  const page = await openPage("/news.html");
  await waitForHighlights(page, NEWS_ALL);
  await page.waitForTimeout(400); // the count report is debounced

  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab.id;
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/options.html`);
  const people = await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "page-summary", tabId: id }), tabId);
  assert.deepEqual(people, [
    { name: "Doug Heye", lists: ["r"], count: 4 },
    { name: "Celinda Lake", lists: ["r", "d"], count: 2 },
  ]);
  await panel.close();

  // Each reveal moves to the next mention; one of them is far down the page.
  let deepest = 0;
  for (let i = 0; i < 4; i++) {
    await worker.evaluate(({ id }) => chrome.tabs.sendMessage(id, { type: "reveal", name: "Doug Heye" }), { id: tabId });
    await page.waitForTimeout(700);
    deepest = Math.max(deepest, await page.evaluate(() => scrollY));
  }
  assert.ok(deepest > 1500, `never scrolled to the mention at the bottom (max scrollY ${deepest})`);
  await page.close();
});

test("the per-list switches in the panel save", async () => {
  await reset({ lists: [GOP] });
  const panel = await openPanel();
  await panel.click(".list .toggle");
  await panel.getByLabel("Highlight this list").uncheck();
  await panel.getByLabel(/later mentions by last name/).uncheck();
  await panel.waitForTimeout(400);
  const { lists } = await getStorage("lists");
  assert.equal(lists[0].enabled, false);
  assert.equal(lists[0].followups, false);
  assert.equal(await panel.textContent(".list .count"), "Hidden");
  await panel.close();
});

// --- Names added by hand ---------------------------------------------------------------

const SYNCED = {
  ...PEOPLE,
  id: "synced",
  name: "Synced",
  names: ["Pat Example | from the URL list"],
  source: { url: "", updatedAt: 1, error: "" },
};
const syncedList = (extra = {}) => ({ ...SYNCED, source: { ...SYNCED.source, url: `${base}/list.txt` }, ...extra });

// What the right-click menu does when you pick a list, for the active tab.
const pickFromMenu = (listId, selectionText) =>
  worker.evaluate(
    async ([id, text]) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await handleMenuClick({ menuItemId: `add-to-list:${id}`, selectionText: text }, tab);
    },
    [listId, selectionText],
  );

const toastText = async (page, expected) => {
  await page.waitForFunction(
    (want) => document.querySelector("take-radar-toast")?.shadowRoot.querySelector(".toast")?.textContent === want,
    expected,
  );
};

const refresh = (id) => worker.evaluate((i) => refreshLists([i]), id);

test("a name added from the page goes beside a synced list, and outlasts refreshes", async () => {
  listBody = "Pat Example | from the URL list\nSam Sample\n";
  await reset({ lists: [syncedList()] });
  const page = await openPage("/article.html");
  await waitForHighlights(page, []);

  await pickFromMenu("synced", "  Jane\n Doe, ");
  await waitForHighlights(page, ["Jane Doe"]);
  await toastText(page, "Added “Jane Doe” to Synced");
  let { lists } = await getStorage("lists");
  assert.deepEqual(lists[0].added, ["Jane Doe"]);
  assert.deepEqual(lists[0].names, ["Pat Example | from the URL list"], "the synced names are untouched");

  // The same name again, and something that isn't a name.
  await pickFromMenu("synced", "jane doe");
  await toastText(page, "“Jane Doe” is already on Synced");
  await pickFromMenu("synced", "...");
  await toastText(page, "Select just a person’s name to add it");

  // A refresh replaces the synced names but keeps what you added.
  listBody = "Pat Example\nSam Sample\nNew Person\n";
  assert.equal((await refresh("synced"))["synced"], "ok");
  ({ lists } = await getStorage("lists"));
  assert.deepEqual(lists[0].names, ["Pat Example", "Sam Sample", "New Person"]);
  assert.deepEqual(lists[0].added, ["Jane Doe"]);
  await waitForHighlights(page, ["Jane Doe"]);

  // Once the source lists them itself, the local copy is dropped.
  listBody = "Pat Example\nJane Doe | now upstream\n";
  await refresh("synced");
  ({ lists } = await getStorage("lists"));
  assert.equal("added" in lists[0], false);
  assert.deepEqual(lists[0].names, ["Pat Example", "Jane Doe | now upstream"]);
  await waitForHighlights(page, ["Jane Doe"]);
  await page.close();
});

test("a name added from the page goes straight into a list you maintain", async () => {
  await reset();
  const page = await openPage("/article.html");
  await waitForHighlights(page, ["Jane Doe", "John Roe", "Ruth A. Okafor", "John Roe"]);
  await pickFromMenu("people", "Sam Sample");
  const { lists } = await getStorage("lists");
  assert.deepEqual(lists[0].names, [...PEOPLE.names, "Sam Sample"]);
  assert.equal("added" in lists[0], false);
  await page.close();
});

test("the panel lets you add to a synced list, and Stop syncing keeps your additions", async () => {
  await reset({ lists: [syncedList({ added: ["Jane Doe"] })] });
  const panel = await openPanel();
  await panel.click(".list .toggle");
  assert.equal(await panel.textContent(".list .count"), "2 names");
  assert.equal(await panel.getByLabel("Names", { exact: true }).isEditable(), false, "synced names are read-only");
  const mine = panel.getByRole("textbox", { name: "Your additions" });
  assert.equal(await mine.inputValue(), "Jane Doe");

  await mine.fill("Jane Doe\nJohn Roe | by hand");
  await panel.waitForTimeout(400);
  let { lists } = await getStorage("lists");
  assert.deepEqual(lists[0].added, ["Jane Doe", "John Roe | by hand"]);
  assert.equal(await panel.textContent(".list .count"), "3 names");

  await panel.getByRole("button", { name: "Stop syncing" }).click();
  await panel.waitForTimeout(400);
  ({ lists } = await getStorage("lists"));
  assert.equal("source" in lists[0], false);
  assert.equal("added" in lists[0], false);
  assert.deepEqual(lists[0].names, ["Pat Example | from the URL list", "Jane Doe", "John Roe | by hand"]);
  assert.equal(await panel.getByRole("textbox", { name: "Your additions" }).isVisible(), false);
  await panel.close();
});

test("an open panel picks up a name added from the page instead of overwriting it", async () => {
  await reset({ lists: [PEOPLE, syncedList()] });
  const panel = await openPanel();
  await panel.waitForSelector(".list");

  const page = await openPage("/article.html");
  await pickFromMenu("people", "Sam Sample");
  await pickFromMenu("synced", "Lee Tester");
  await page.close();

  // The panel shows both, so its next save keeps them.
  await panel.waitForFunction(() => document.querySelector(".list .count").textContent === "4 names");
  const second = panel.locator(".list").nth(1);
  await second.locator(".toggle").click();
  await second.getByLabel(/Highlight this list/).uncheck();
  await panel.waitForTimeout(400);
  const { lists } = await getStorage("lists");
  assert.deepEqual(lists[0].names, [...PEOPLE.names, "Sam Sample"]);
  assert.deepEqual(lists[1].added, ["Lee Tester"]);
  assert.equal(lists[1].enabled, false, "the panel's own change still saved");
  await panel.close();
});

// --- Sending additions to GitHub -----------------------------------------------------------

const DEVELOPER = { paused: false, disabledHosts: [], developerMode: true };
const GOP_SOURCE = "https://raw.githubusercontent.com/jstock29/take-radar/main/lists/republican-operatives.txt";
const gopList = (added) => ({
  ...PEOPLE,
  id: "gop",
  name: "Republican operatives",
  names: ["Alex Conant | Republican strategist"],
  source: { url: GOP_SOURCE, updatedAt: 1, error: "" },
  added,
});
// Click "Submit new names" and return the address it tries to open. Tab
// addresses aren't visible to an extension without the "tabs" permission, so
// the panel's tabs.create is replaced to capture it (and to keep the test off
// the network).
const sendToGitHub = async (panel) => {
  await panel.evaluate(() => {
    window.__opened = [];
    chrome.tabs.create = async ({ url }) => void window.__opened.push(url);
  });
  await panel.getByRole("button", { name: /Submit new names?/ }).click();
  await panel.waitForFunction(() => window.__opened.length > 0);
  const opened = await panel.evaluate(() => window.__opened);
  assert.equal(opened.length, 1, "opens exactly one tab");
  return new URL(opened[0]);
};

test("Submit new names opens a pre-filled issue, but only once every operative has a note", async () => {
  await reset({ lists: [gopList(["Jane Doe"])], settings: DEVELOPER });
  const panel = await openPanel();
  await panel.click(".list .toggle");

  // No note: refused, with the names that need one.
  await panel.getByRole("button", { name: /Submit new names?/ }).click();
  assert.match(await panel.textContent(".added-block .sync-error"), /needs a note.*: Jane Doe$/);

  await panel.getByRole("textbox", { name: "Your additions" }).fill("Jane Doe | pollster\nJohn Roe | strategist");
  const url = await sendToGitHub(panel);
  assert.equal(url.origin + url.pathname, "https://github.com/jstock29/take-radar/issues/new");
  assert.equal(url.searchParams.get("title"), "Add 2 names to republican-operatives.txt");
  assert.match(url.searchParams.get("body"), /```\nJane Doe \| pollster\nJohn Roe \| strategist\n```/);
  assert.equal(await panel.locator(".added-block .sync-error").isVisible(), false, "the refusal clears once it works");
  await panel.close();
});

test("Submit new names is only offered for lists from this repo, and only with additions", async () => {
  const other = syncedList({ added: ["Jane Doe"] });
  await reset({ lists: [other, gopList(undefined)], settings: DEVELOPER });
  const panel = await openPanel();
  const submit = (list) => list.getByRole("button", { name: /Submit new names?/ });
  const [a, b] = [panel.locator(".list").nth(0), panel.locator(".list").nth(1)];
  await a.locator(".toggle").click();
  assert.equal(await a.getByRole("button", { name: "Copy" }).isVisible(), true);
  assert.equal(await submit(a).isVisible(), false, "a URL list from elsewhere");
  await b.locator(".toggle").click();
  assert.equal(await submit(b).isVisible(), false, "nothing to submit yet");

  await b.getByRole("textbox", { name: "Your additions" }).fill("Jane Doe | pollster");
  assert.equal(await submit(b).textContent(), "Submit new name");
  await b.getByRole("textbox", { name: "Your additions" }).fill("Jane Doe | pollster\nJohn Roe | strategist");
  assert.equal(await submit(b).textContent(), "Submit new names");
  await panel.close();
});

test("Developer mode is off by default, hides the button, and is switched on in the full-page view", async () => {
  await reset({ lists: [gopList(["Jane Doe | pollster"])] });

  // The popup-sized view has no switch, and no button.
  let panel = await openPanel();
  await panel.click(".list .toggle");
  await panel.click("#about summary");
  assert.equal(await panel.locator("#developer").isVisible(), false);
  assert.equal(await panel.getByRole("button", { name: /Submit new names?/ }).isVisible(), false);
  assert.equal(await panel.getByRole("button", { name: "Copy" }).isVisible(), true, "copying isn't affected");
  await panel.close();

  // The full-page view has the switch; turning it on saves and shows the button.
  panel = await context.newPage();
  await panel.setViewportSize({ width: 900, height: 700 });
  await panel.goto(`chrome-extension://${extensionId}/options.html`);
  await panel.click(".list .toggle");
  await panel.click("#about summary");
  assert.equal(await panel.getByLabel("Developer mode").isChecked(), false);
  assert.equal(await panel.getByRole("button", { name: /Submit new names?/ }).isVisible(), false);
  await panel.getByLabel("Developer mode").check();
  await panel.getByRole("button", { name: "Submit new name" }).waitFor();
  await panel.waitForTimeout(400);
  const { settings } = await getStorage("settings");
  assert.equal(settings.developerMode, true);
  assert.equal(settings.paused, false, "other settings are kept");

  // Once on, the popup-sized view shows the button and keeps the switch so it can be turned off.
  const small = await openPanel();
  await small.click(".list .toggle");
  await small.click("#about summary");
  assert.equal(await small.getByRole("button", { name: "Submit new name" }).isVisible(), true);
  await small.getByLabel("Developer mode").uncheck();
  assert.equal(await small.getByRole("button", { name: /Submit new names?/ }).isVisible(), false);
  await small.waitForTimeout(400);
  assert.equal((await getStorage("settings")).settings.developerMode, false);
  // ...and the other open view follows.
  await panel.waitForFunction(() => !document.querySelector("#developerMode").checked);
  await small.close();
  await panel.close();
});

test("a name added from the page reaches an options tab left in the background, even with its box focused", async () => {
  await reset({ lists: [syncedList()] });
  const panel = await openPanel();
  await panel.click(".list .toggle");
  const box = panel.getByRole("textbox", { name: "Your additions" });
  await box.focus();

  // Another tab comes to the front; the panel keeps its focused box but loses focus itself.
  const page = await openPage("/article.html");
  await pickFromMenu("synced", "Lee Tester");
  await panel.waitForFunction(() => document.querySelector("textarea.added").value === "Lee Tester");

  // Typing on afterwards adds to it rather than replacing it.
  await panel.bringToFront();
  await box.press("Control+End");
  await box.pressSequentially("\nPat Added | note");
  await panel.waitForTimeout(400);
  const { lists } = await getStorage("lists");
  assert.deepEqual(lists[0].added, ["Lee Tester", "Pat Added | note"]);
  await page.close();
  await panel.close();
});

// --- About ---------------------------------------------------------------------------------

test("the options page shows its version and an About panel, collapsed until asked for", async () => {
  await reset({ lists: [] });
  const panel = await openPanel();
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));

  // A quiet version line is always there; the details aren't until opened.
  assert.equal(await panel.textContent("#version"), `Take Radar v${version}`);
  assert.equal(await panel.locator(".about-body").isVisible(), false);
  assert.match(await panel.textContent(".empty"), /Nothing highlighted yet/);

  await panel.click("#about summary");
  assert.equal(await panel.locator(".about-body").isVisible(), true);
  assert.match(await panel.textContent("#shortcut"), /Alt\+Shift\+R pauses and resumes|No keyboard shortcut/);
  assert.match(await panel.textContent(".about-body"), /stay in this browser/);
  const links = await panel.locator(".about-links a").evaluateAll((as) => as.map((a) => [a.href, a.target, a.rel]));
  assert.deepEqual(links, [
    ["https://github.com/jstock29/take-radar", "_blank", "noreferrer"],
    ["https://github.com/jstock29/take-radar/issues", "_blank", "noreferrer"],
  ]);
  await panel.close();
});
