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

  // --- Lists --------------------------------------------------------------

  /**
   * Bring a stored list up to the current shape. Versions before 0.4 stored
   * a single opaque `color`; that becomes the fill.
   */
  const normalizeList = (list = {}) => {
    const fill = parseColor(list.fill) ?? parseColor(list.color);
    const border = parseColor(list.border);
    return {
      id: list.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: typeof list.name === "string" ? list.name : "Untitled",
      fill: fill ? toHex8(fill) : DEFAULT_FILL,
      border: border ? toHex8(border) : fill ? toHex8({ ...fill, a: 1 }) : DEFAULT_BORDER,
      borderWidth: clamp(Math.round(Number(list.borderWidth) || 0), 0, MAX_BORDER_WIDTH),
      names: Array.isArray(list.names) ? list.names.filter((n) => typeof n === "string") : [],
    };
  };

  // Black or white, whichever reads better on the given color.
  const contrastText = ({ r, g, b }) =>
    0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";

  /**
   * The inline CSS for a list's highlight, as [property, value] pairs. The
   * border is drawn with box-shadow so it never shifts the page's layout
   * vertically, and it survives line wraps thanks to box-decoration-break.
   */
  const highlightStyle = (list) => {
    const fill = parseColor(list.fill) ?? parseColor(DEFAULT_FILL);
    const border = parseColor(list.border) ?? parseColor(DEFAULT_BORDER);
    const width = list.borderWidth || 0;
    const hasBorder = width > 0 && border.a > 0;
    const style = [
      ["background-color", toCss(list.fill)],
      ["box-shadow", hasBorder ? `0 0 0 ${width}px ${toCss(list.border)}` : "none"],
      ["margin", hasBorder ? `0 ${width}px` : "0"],
    ];
    // Only override the page's text color when the fill is solid enough to
    // be what the text actually sits on.
    if (fill.a >= 0.5) style.push(["color", contrastText(fill)]);
    return style;
  };

  globalThis.TakeRadar = {
    ext,
    DEFAULT_FILL,
    DEFAULT_BORDER,
    MAX_BORDER_WIDTH,
    clamp,
    parseColor,
    toHex8,
    toCss,
    rgbToHsv,
    hsvToRgb,
    normalizeList,
    highlightStyle,
  };
})();
