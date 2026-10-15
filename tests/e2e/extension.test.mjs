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

  const title = await page.$eval("#plain .take-radar-highlight", (s) => s.title);
  assert.equal(title, "People\na note about Jane");
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
