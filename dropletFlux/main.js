// main.js — slider redraw version + footprint circles
// Requires: index.html contains <canvas id="plot"></canvas> and a container (optional).
// Files served from same folder:
//   index.html
//   main.js
//   flux_pair.mjs
//   flux_pair.wasm

import createModule from "./flux_pair.mjs";

// ----- UI helpers -----
function ensureUI() {
  let ui = document.querySelector("#ui");
  if (!ui) {
    ui = document.createElement("div");
    ui.id = "ui";
    ui.style.cssText = "font-family:system-ui; margin:12px 0; display:flex; gap:16px; align-items:center; flex-wrap:wrap;";
    const canvas = document.querySelector("#plot");
    canvas.parentNode.insertBefore(ui, canvas);
  }

  // Separation slider b
  let bWrap = document.querySelector("#bWrap");
  if (!bWrap) {
    bWrap = document.createElement("div");
    bWrap.id = "bWrap";
    bWrap.style.cssText = "display:flex; gap:10px; align-items:center;";
    bWrap.innerHTML = `
      <label for="bSlider" style="white-space:nowrap;">Separation b:</label>
      <input id="bSlider" type="range" min="2.02" max="6.0" step="0.01" value="2.25" style="width:340px;">
      <span id="bReadout" style="min-width:110px;"></span>
    `;
    ui.appendChild(bWrap);
  }

  // Clip slider
  let cWrap = document.querySelector("#cWrap");
  if (!cWrap) {
    cWrap = document.createElement("div");
    cWrap.id = "cWrap";
    cWrap.style.cssText = "display:flex; gap:10px; align-items:center;";
    cWrap.innerHTML = `
      <label for="clipSlider" style="white-space:nowrap;">Clip:</label>
      <input id="clipSlider" type="range" min="0.85" max="0.999" step="0.001" value="0.97" style="width:220px;">
      <span id="clipReadout" style="min-width:90px;"></span>
    `;
    ui.appendChild(cWrap);
  }

  // Log toggle
  let lWrap = document.querySelector("#lWrap");
  if (!lWrap) {
    lWrap = document.createElement("div");
    lWrap.id = "lWrap";
    lWrap.style.cssText = "display:flex; gap:10px; align-items:center;";
    lWrap.innerHTML = `
      <label style="display:flex; gap:8px; align-items:center; white-space:nowrap;">
        <input id="logToggle" type="checkbox" checked>
        Log scale
      </label>
    `;
    ui.appendChild(lWrap);
  }

  return {
    bSlider: document.querySelector("#bSlider"),
    bReadout: document.querySelector("#bReadout"),
    clipSlider: document.querySelector("#clipSlider"),
    clipReadout: document.querySelector("#clipReadout"),
    logToggle: document.querySelector("#logToggle"),
  };
}

// ----- Plot helpers -----
function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

// Simple colour ramp (swap later if you like)
function colour(t) {
  t = clamp01(t);
  const r = Math.round(255 * clamp01(1.6 * t));
  const g = Math.round(255 * clamp01(1.6 * (t - 0.2)));
  const b = Math.round(255 * clamp01(1.6 * (t - 0.45)));
  return [r, g, b];
}

function renderDensity(ctx, nx, ny, grid, opts) {
  const { clipP = 0.97, logScale = true } = opts;
  const n = nx * ny;

  // percentile clip
  const finite = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(grid[k])) finite.push(grid[k]);
  finite.sort((a, b) => a - b);
  const vmax = finite.length ? finite[Math.floor(clipP * (finite.length - 1))] : 1.0;

  const img = ctx.createImageData(nx, ny);

  for (let k = 0; k < n; k++) {
    const v = grid[k];
    const idx = 4 * k;

    if (!Number.isFinite(v)) {
      img.data[idx + 3] = 0; // transparent outside
      continue;
    }

    const vclip = Math.min(v, vmax);
    const t = logScale
      ? Math.log(1 + vclip) / Math.log(1 + vmax)
      : (vclip / (vmax || 1));

    const [r, g, b] = colour(t);
    img.data[idx] = r;
    img.data[idx + 1] = g;
    img.data[idx + 2] = b;
    img.data[idx + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
}

function drawFootprints(ctx, nx, ny, a, b, xmin, xmax, ymin, ymax) {
  const W = nx, H = ny;
  const xToPx = (x) => ((x - xmin) / (xmax - xmin)) * (W - 1);
  const yToPy = (y) => (H - 1) - ((y - ymin) / (ymax - ymin)) * (H - 1);

  const c1x = -0.5 * b;
  const c2x = +0.5 * b;

  // radius in pixels (use x-scale)
  const rPx = Math.abs(xToPx(a) - xToPx(0));

  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 1.6;

  ctx.beginPath();
  ctx.arc(xToPx(c1x), yToPy(0), rPx, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(xToPx(c2x), yToPy(0), rPx, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.restore();
}

function drawHUD(ctx, text) {
  ctx.save();
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillText(text, 10, 20);
  ctx.restore();
}

// ----- Main -----
async function run() {
  const mod = await createModule({
  locateFile: (p) => new URL(p, import.meta.url).toString()
});

  const fill_flux_pair = mod.cwrap("fill_flux_pair", null, [
    "number", "number",         // a, b
    "number", "number",         // nx, ny
    "number", "number",         // xmin, xmax
    "number", "number",         // ymin, ymax
    "number"                   // out pointer
  ]);

  const canvas = document.querySelector("#plot");
  if (!canvas) throw new Error("Missing <canvas id='plot'> in index.html");
  const ctx = canvas.getContext("2d");

  // Grid resolution (keep moderate for interactive redraw)
  const nx = 700, ny = 350;
  canvas.width = nx;
  canvas.height = ny;

  // Fixed droplet radius for now
  const a = 1.0;

  // View window (could also adapt to b; kept fixed for simplicity)
  const xmin = -3.2, xmax = 3.2;
  const ymin = -1.8, ymax = 1.8;

  // Allocate output grid once
  const n = nx * ny;
  const ptr = mod._malloc(n * 8);
  const heapF64 = new Float64Array(mod.wasmMemory.buffer);
  const grid = heapF64.subarray(ptr >> 3, (ptr >> 3) + n);

  // UI
  const ui = ensureUI();

  let pending = false;

  function redraw() {
    pending = false;

    const b = Number(ui.bSlider.value);
    const clipP = Number(ui.clipSlider.value);
    const logScale = !!ui.logToggle.checked;

    // enforce b > 2a a touch (avoid overlap)
    const bSafe = Math.max(b, 2.0 * a + 1e-6);

    ui.bReadout.textContent = `b = ${bSafe.toFixed(2)} (2a=${(2*a).toFixed(2)})`;
    ui.clipReadout.textContent = `${Math.round(clipP * 1000) / 10}%`;

    // compute field
    fill_flux_pair(a, bSafe, nx, ny, xmin, xmax, ymin, ymax, ptr);

    // render
    renderDensity(ctx, nx, ny, grid, { clipP, logScale });
    drawFootprints(ctx, nx, ny, a, bSafe, xmin, xmax, ymin, ymax);
    drawHUD(ctx, `log=${logScale ? "on" : "off"}  clip=${Math.round(clipP * 1000) / 10}%`);
  }

  function requestRedraw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(redraw);
  }

  ui.bSlider.addEventListener("input", requestRedraw);
  ui.clipSlider.addEventListener("input", requestRedraw);
  ui.logToggle.addEventListener("change", requestRedraw);

  // first render
  redraw();

  // If you later want clean-up:
  // window.addEventListener("beforeunload", () => mod._free(ptr));
}

run().catch((e) => {
  console.error(e);
  alert(e?.message ?? String(e));
});