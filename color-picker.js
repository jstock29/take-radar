// An in-page color picker with alpha.
//
// Why not <input type="color">? In Chrome (notably on macOS) the native
// picker opens as a separate OS window; the extension popup loses focus and
// Chrome closes it, taking the picker with it. The native input also has no
// alpha channel. Drawing the picker in the page avoids both problems.

const { parseColor, toHex8, rgbToHsv, hsvToRgb, clamp } = globalThis.TakeRadar;

const SWATCHES = [
  "#ff8c00", "#ffd60a", "#34c759", "#00c7be", "#0a84ff",
  "#5e5ce6", "#bf5af2", "#ff375f", "#ff3b30", "#8e8e93", "#000000",
];

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/**
 * @param {{ value: string, label: string, onInput: (hex8: string) => void }} opts
 * @returns {{ el: HTMLElement, setValue: (hex8: string) => void, focus: () => void }}
 */
export function createColorPicker({ value, label, onInput }) {
  // Hue is kept separately so it survives passing through grey/black.
  let hsv = { h: 0, s: 1, v: 1 };
  let alpha = 1;

  const thumb = el("div", { className: "cp-sv-thumb" });
  const sv = el("div", {
    className: "cp-sv",
    tabIndex: 0,
    role: "slider",
    ariaLabel: `${label}: saturation and brightness`,
  }, thumb);

  const hue = el("input", {
    type: "range", min: 0, max: 360, step: 1,
    className: "cp-range cp-hue",
    ariaLabel: `${label}: hue`,
  });
  const alphaRange = el("input", {
    type: "range", min: 0, max: 100, step: 1,
    className: "cp-range cp-alpha",
    ariaLabel: `${label}: opacity`,
  });
  const alphaTrack = el("div", { className: "cp-alpha-wrap" }, alphaRange);
  const alphaLabel = el("span", { className: "cp-alpha-value" });

  const hex = el("input", {
    type: "text",
    className: "cp-hex",
    spellcheck: false,
    autocomplete: "off",
    maxLength: 9,
    ariaLabel: `${label}: hex value`,
  });

  const swatches = el("div", { className: "cp-swatches" });
  SWATCHES.forEach((color) => {
    const b = el("button", { type: "button", className: "cp-swatch", title: color });
    b.style.setProperty("--swatch", color);
    b.addEventListener("click", () => {
      hsv = rgbToHsv(parseColor(color));
      if (alpha === 0) alpha = 1;
      render();
      emit();
    });
    swatches.append(b);
  });
  const clearBtn = el("button", {
    type: "button",
    className: "cp-swatch cp-swatch-none",
    title: "Transparent",
  });
  clearBtn.addEventListener("click", () => {
    alpha = 0;
    render();
    emit();
  });
  swatches.append(clearBtn);

  const root = el(
    "div",
    { className: "cp" },
    sv,
    el("div", { className: "cp-sliders" }, hue, el("div", { className: "cp-alpha-row" }, alphaTrack, alphaLabel)),
    el("div", { className: "cp-row" }, hex, swatches),
  );

  const current = () => toHex8({ ...hsvToRgb(hsv), a: alpha });
  const emit = () => onInput(current());

  function render({ keepHexField = false } = {}) {
    const { r, g, b } = hsvToRgb(hsv);
    const solid = `rgb(${r}, ${g}, ${b})`;
    root.style.setProperty("--cp-hue", `hsl(${hsv.h}, 100%, 50%)`);
    root.style.setProperty("--cp-solid", solid);
    thumb.style.left = `${hsv.s * 100}%`;
    thumb.style.top = `${(1 - hsv.v) * 100}%`;
    sv.ariaValueText = `saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`;
    hue.value = Math.round(hsv.h);
    alphaRange.value = Math.round(alpha * 100);
    alphaLabel.textContent = `${Math.round(alpha * 100)}%`;
    if (!keepHexField) {
      const h8 = current();
      hex.value = h8.endsWith("ff") ? h8.slice(0, 7) : h8;
    }
  }

  // --- Saturation / brightness square ---

  const setFromPointer = (e) => {
    const rect = sv.getBoundingClientRect();
    hsv.s = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    hsv.v = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
    if (alpha === 0) alpha = 1;
    render();
    emit();
  };
  sv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sv.focus();
    sv.setPointerCapture(e.pointerId);
    setFromPointer(e);
  });
  sv.addEventListener("pointermove", (e) => {
    if (sv.hasPointerCapture(e.pointerId)) setFromPointer(e);
  });
  sv.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves = {
      ArrowLeft: ["s", -step], ArrowRight: ["s", step],
      ArrowDown: ["v", -step], ArrowUp: ["v", step],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    hsv[move[0]] = clamp(hsv[move[0]] + move[1], 0, 1);
    render();
    emit();
  });

  // --- Sliders and hex field ---

  hue.addEventListener("input", () => {
    hsv.h = Number(hue.value);
    if (hsv.s === 0) hsv.s = 1; // Moving hue on grey should show a color.
    if (hsv.v === 0) hsv.v = 1;
    render();
    emit();
  });
  alphaRange.addEventListener("input", () => {
    alpha = Number(alphaRange.value) / 100;
    render();
    emit();
  });
  hex.addEventListener("input", () => {
    const c = parseColor(hex.value);
    hex.classList.toggle("invalid", !c);
    if (!c) return;
    setInternal(c);
    render({ keepHexField: true });
    emit();
  });
  hex.addEventListener("blur", () => {
    hex.classList.remove("invalid");
    render();
  });
  hex.addEventListener("keydown", (e) => e.key === "Enter" && hex.blur());

  function setInternal(c) {
    const next = rgbToHsv(c);
    // Keep hue (and saturation) when the new color can't express them.
    if (next.s === 0 || next.v === 0) next.h = hsv.h;
    if (next.v === 0) next.s = hsv.s;
    hsv = next;
    alpha = c.a;
  }

  const setValue = (hex8) => {
    const c = parseColor(hex8);
    if (!c) return;
    setInternal(c);
    render();
  };

  setValue(value);
  return { el: root, setValue, focus: () => sv.focus() };
}
