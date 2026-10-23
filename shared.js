// Shared by the content script, the background script and the settings page.
// Classic script (not a module) so it can be listed in content_scripts and
// pulled into a service worker with importScripts().
(() => {
  // Safari and Firefox expose the promise-based `browser`; Chrome only has
  // `chrome`, which also returns promises under MV3.
  const ext = globalThis.browser ?? globalThis.chrome;

  const DEFAULT_FILL = "#ff8c00ff";
  const DEFAULT_BORDER = "#ff8c00ff";
  const MAX_BORDER_WIDTH = 4;

  // --- Colors -------------------------------------------------------------
  // Colors are stored as 8-digit hex (#rrggbbaa) so alpha travels with them.

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** Parse #rgb, #rgba, #rrggbb or #rrggbbaa into {r, g, b, a} (a in 0..1). */
  const parseColor = (str) => {
    let hex = String(str ?? "").trim().replace(/^#/, "");
    if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
    if (hex.length === 6) hex += "ff";
    const n = parseInt(hex, 16) >>> 0;
    return {
      r: (n >>> 24) & 255,
      g: (n >>> 16) & 255,
      b: (n >>> 8) & 255,
      a: (n & 255) / 255,
    };
  };

  const toHex8 = ({ r, g, b, a = 1 }) =>
    "#" +
    [r, g, b, Math.round(clamp(a, 0, 1) * 255)]
      .map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0"))
      .join("");

  const toCss = (hex) => {
    const c = parseColor(hex) ?? { r: 0, g: 0, b: 0, a: 0 };
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${+c.a.toFixed(3)})`;
  };

  const rgbToHsv = ({ r, g, b }) => {
    [r, g, b] = [r / 255, g / 255, b / 255];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  };

  const hsvToRgb = ({ h, s, v }) => {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
    };
    return { r: f(5), g: f(3), b: f(1) };
  };

  // --- Names and list files -------------------------------------------------
  // A list entry is "Name" or "Name | note"; the note shows in the tooltip.

  const splitEntry = (line) => {
    const i = line.indexOf("|");
    if (i === -1) return { name: line.trim(), note: "" };
    return { name: line.slice(0, i).trim(), note: line.slice(i + 1).trim() };
  };

  // Split one CSV line, honoring double-quoted cells.
  const csvCells = (line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') (cell += '"'), i++;
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") cells.push(cell), (cell = "");
      else cell += ch;
    }
    cells.push(cell);
    return cells.map((c) => c.trim());
  };

  /**
   * Parse a list file into entries ("Name" or "Name | note").
   * - Text: one entry per line; blank lines and lines starting with # skipped.
   * - CSV with a header row containing "name": that column, plus a
   *   "note"/"notes"/"description"/"role" column if present.
   * - Other CSV: every cell is a name.
   */
  const parseListText = (text, { csv = false } = {}) => {
    const lines = String(text)
      .replace(/^﻿/, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    if (!csv) return lines.map(splitEntry).filter((e) => e.name).map(joinEntry);

    const rows = lines.map(csvCells);
    const header = (rows[0] ?? []).map((h) => h.toLowerCase());
    const nameCol = header.indexOf("name");
    if (nameCol !== -1) {
      const noteCol = header.findIndex((h) =>
        ["note", "notes", "description", "role"].includes(h),
      );
      return rows
        .slice(1)
        .map((r) => ({ name: r[nameCol] ?? "", note: noteCol === -1 ? "" : r[noteCol] ?? "" }))
        .filter((e) => e.name)
        .map(joinEntry);
    }
    return rows.flat().filter(Boolean);
  };

  const joinEntry = ({ name, note }) => (note ? `${name} | ${note}` : name);

  // --- Entries on a list ---------------------------------------------------------
  // A list synced from a URL is read-only and replaced on every refresh, so
  // names added by hand live beside it in `list.added` (see additions.js).

  /** Every entry a list matches on: its names, then the ones you added. */
  const listEntries = (list) => (list.added?.length ? [...list.names, ...list.added] : list.names);

  /** Fetch and parse a list from a URL (CSV if the path ends in .csv). */
  const fetchList = async (url) => {
    const res = await fetch(url, { cache: "no-cache", credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = /\.csv$/i.test(new URL(url).pathname) || /csv/i.test(res.headers.get("content-type") ?? "");
    return parseListText(await res.text(), { csv });
  };

  // Lists anyone can opt into. Each is bundled (so it works offline and on
  // first add) and synced from the repo, so fixes reach users between releases.
  const LISTS_BASE = "https://raw.githubusercontent.com/jstock29/take-radar/main/lists/";
  const STARTERS = [
    {
      id: "republican-operatives",
      name: "Republican operatives",
      description: "Strategists, pollsters, campaign and party staff, including ones now working in media.",
      file: "lists/republican-operatives.txt",
      requireNotes: true, // every entry says who the person is (enforced by the unit tests)
      style: { fill: "#ff3b3026", border: "#ff3b30ff", borderWidth: 1 },
    },
    {
      id: "democratic-operatives",
      name: "Democratic operatives",
      description: "Strategists, pollsters, campaign and party staff, including ones now working in media.",
      file: "lists/democratic-operatives.txt",
      requireNotes: true,
      style: { fill: "#0a84ff26", border: "#0a84ffff", borderWidth: 1 },
    },
    {
      id: "harpers",
      name: "Harper's Letter signatories",
      description: "Signers of the 2020 open letter on justice and open debate.",
      file: "lists/harpers-letter.txt",
      style: { fill: "#ff8c00ff", border: "#ff8c00ff", borderWidth: 0 },
    },
  ].map((s) => ({ ...s, url: LISTS_BASE + s.file.split("/").pop() }));

  // --- Stored lists ------------------------------------------------------------

  /**
   * Bring a stored list up to the current shape. Versions before 0.4 stored
   * a single opaque `color`; that becomes the fill. A list synced from a URL
   * carries `source: { url, updatedAt, error }` and may have `added`, names
   * you put on it yourself. `enabled: false` hides a list without deleting
   * it; `followups: false` turns off last-name-only matches for it.
   */
  const normalizeList = (list = {}) => {
    const fill = parseColor(list.fill) ?? parseColor(list.color);
    const border = parseColor(list.border);
    const out = {
      id: list.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: typeof list.name === "string" ? list.name : "Untitled",
      fill: fill ? toHex8(fill) : DEFAULT_FILL,
      border: border ? toHex8(border) : fill ? toHex8({ ...fill, a: 1 }) : DEFAULT_BORDER,
      borderWidth: clamp(Math.round(Number(list.borderWidth) || 0), 0, MAX_BORDER_WIDTH),
      names: Array.isArray(list.names) ? list.names.filter((n) => typeof n === "string") : [],
    };
    // Both default to on; only `false` is stored.
    if (list.enabled === false) out.enabled = false;
    if (list.followups === false) out.followups = false;
    if (typeof list.starterId === "string") out.starterId = list.starterId;
    if (list.source && typeof list.source.url === "string") {
      out.source = {
        url: list.source.url,
        updatedAt: Number(list.source.updatedAt) || 0,
        error: typeof list.source.error === "string" ? list.source.error : "",
      };
    }
    // Additions only exist beside a source; on a list you edit directly
    // they're just more names.
    const added = Array.isArray(list.added) ? list.added.filter((n) => typeof n === "string") : [];
    if (out.source && added.length) out.added = added;
    else out.names = out.names.concat(added);
    return out;
  };

  // --- Settings ---------------------------------------------------------------

  const DEFAULT_SETTINGS = { paused: false, disabledHosts: [], developerMode: false };

  const normalizeSettings = (s = {}) => ({
    paused: Boolean(s?.paused),
    disabledHosts: Array.isArray(s?.disabledHosts)
      ? s.disabledHosts.filter((h) => typeof h === "string")
      : [],
    // Shows maintainer-only controls (submitting names to the project's lists).
    developerMode: Boolean(s?.developerMode),
  });

  // --- Highlight style --------------------------------------------------------

  // Black or white, whichever reads better on the given color.
  const contrastText = ({ r, g, b }) =>
    0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";

  // Everything is set inline (no stylesheet) so highlights inside shadow
  // roots, which page-level CSS can't reach, look the same as the rest.
  const BASE_STYLE = [
    ["padding", "0 2px"],
    ["border-radius", "3px"],
    ["-webkit-box-decoration-break", "clone"],
    ["box-decoration-break", "clone"],
    ["cursor", "help"],
  ];

  /**
   * The inline CSS for a list's highlight, as [property, value] pairs. The
   * border is drawn with box-shadow so it never shifts the page's layout
   * vertically, and it survives line wraps thanks to box-decoration-break.
   * Pass { base: true } to include padding, radius and cursor.
   */
  const highlightStyle = (list, { base = false } = {}) => {
    const fill = parseColor(list.fill) ?? parseColor(DEFAULT_FILL);
    const border = parseColor(list.border) ?? parseColor(DEFAULT_BORDER);
    const width = list.borderWidth || 0;
    const hasBorder = width > 0 && border.a > 0;
    const style = [
      ...(base ? BASE_STYLE : []),
      ["background-color", toCss(list.fill)],
      ["box-shadow", hasBorder ? `0 0 0 ${width}px ${toCss(list.border)}` : "none"],
      ["margin", hasBorder ? `0 ${width}px` : "0"],
    ];
    // Only override the page's text color when the fill is solid enough to
    // be what the text actually sits on.
    if (fill.a >= 0.5) style.push(["color", contrastText(fill)]);
    return style;
  };

  const STRIPE_PX = 5;

  /**
   * Style for a name that's on several lists: diagonal stripes of each
   * list's fill, and one border ring per list that has a border, nested
   * outward in list order. A single list gets its normal style.
   */
  const combinedHighlightStyle = (lists, { base = false } = {}) => {
    if (lists.length === 1) return highlightStyle(lists[0], { base });

    const fills = lists.map((l) => parseColor(l.fill) ?? parseColor(DEFAULT_FILL));
    const stops = lists
      .map((l, i) => `${toCss(l.fill)} ${i * STRIPE_PX}px ${(i + 1) * STRIPE_PX}px`)
      .join(", ");

    let spread = 0;
    const rings = [];
    for (const l of lists) {
      const border = parseColor(l.border);
      if (l.borderWidth > 0 && border?.a > 0) {
        spread += l.borderWidth;
        rings.push(`0 0 0 ${spread}px ${toCss(l.border)}`);
      }
    }

    const style = [
      ...(base ? BASE_STYLE : []),
      ["background-color", "transparent"],
      ["background-image", `repeating-linear-gradient(135deg, ${stops})`],
      ["box-shadow", rings.length ? rings.join(", ") : "none"],
      ["margin", spread ? `0 ${spread}px` : "0"],
    ];
    // Force a text color only if every stripe is solid enough to sit on,
    // and pick it for the average of the stripe colors.
    if (fills.every((f) => f.a >= 0.5)) {
      const avg = (k) => fills.reduce((sum, f) => sum + f[k], 0) / fills.length;
      style.push(["color", contrastText({ r: avg("r"), g: avg("g"), b: avg("b") })]);
    }
    return style;
  };

  Object.assign((globalThis.TakeRadar ??= {}), {
    ext,
    DEFAULT_FILL,
    DEFAULT_BORDER,
    MAX_BORDER_WIDTH,
    DEFAULT_SETTINGS,
    STARTERS,
    clamp,
    parseColor,
    toHex8,
    toCss,
    rgbToHsv,
    hsvToRgb,
    splitEntry,
    parseListText,
    listEntries,
    fetchList,
    normalizeList,
    normalizeSettings,
    highlightStyle,
    combinedHighlightStyle,
  });
})();
