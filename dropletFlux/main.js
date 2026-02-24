import createModule from "./flux_pair.mjs";

const clamp01 = (t) => Math.max(0, Math.min(1, t));

function colour(t) {
  t = clamp01(t);
  const r = Math.round(255 * clamp01(1.6 * t));
  const g = Math.round(255 * clamp01(1.6 * (t - 0.2)));
  const b = Math.round(255 * clamp01(1.6 * (t - 0.45)));
  return [r, g, b];
}

function drawFootprints(ctx, nx, ny, a, b, xmin, xmax, ymin, ymax) {
  const xToPx = (x) => ((x - xmin) / (xmax - xmin)) * (nx - 1);
  const yToPy = (y) => (ny - 1) - ((y - ymin) / (ymax - ymin)) * (ny - 1);

  const c1x = -0.5 * b;
  const c2x = +0.5 * b;
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

// fast-ish percentile estimate by subsampling every `stride` points
function approxPercentileFinite(grid, p, stride = 8) {
  const sample = [];
  for (let i = 0; i < grid.length; i += stride) {
    const v = grid[i];
    if (Number.isFinite(v)) sample.push(v);
  }
  if (!sample.length) return 1.0;
  sample.sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sample.length - 1, Math.floor(p * (sample.length - 1))));
  return sample[idx];
}

async function main() {
  const mod = await createModule({
    // GitHub Pages / subpath safe:
    locateFile: (p) => new URL(p, import.meta.url).toString(),
  });

  const fill_flux_pair = mod.cwrap("fill_flux_pair", null, [
    "number","number","number","number","number","number","number","number","number"
  ]);

  // ---- UI ----
  const bSlider = document.querySelector("#b");
  const clipSlider = document.querySelector("#clip");
  const logToggle = document.querySelector("#log");
  const bVal = document.querySelector("#bVal");
  const clipVal = document.querySelector("#clipVal");

  // ---- canvas ----
  const canvas = document.querySelector("#plot");
  const ctx = canvas.getContext("2d");

  // resolution
  const nx = 700, ny = 350;
  canvas.width = nx;
  canvas.height = ny;

  // parameters
  const a = 1.0;
  const xmin = -3.2, xmax = 3.2;
  const ymin = -1.8, ymax = 1.8;

  // allocate once
  const n = nx * ny;
  const ptr = mod._malloc(n * 8);

  // persistent image buffer (avoid realloc each redraw)
  const img = ctx.createImageData(nx, ny);
  const pix = img.data;

  let pending = false;

  function redraw() {
    pending = false;

    const bRaw = Number(bSlider.value);
    const b = Math.max(bRaw, 2 * a + 1e-6);
    const clipP = Number(clipSlider.value);
    const logScale = !!logToggle.checked;

    bVal.textContent = `b=${b.toFixed(2)} (2a=${(2*a).toFixed(2)})`;
    clipVal.textContent = `${Math.round(clipP * 1000) / 10}%`;

    // make / refresh Float64 view (handle rare memory growth)
    let heapF64 = new Float64Array(mod.wasmMemory.buffer);
    let grid = heapF64.subarray(ptr >> 3, (ptr >> 3) + n);

    fill_flux_pair(a, b, nx, ny, xmin, xmax, ymin, ymax, ptr);

    // refresh view if memory grew during call
    if (heapF64.buffer !== mod.wasmMemory.buffer) {
      heapF64 = new Float64Array(mod.wasmMemory.buffer);
      grid = heapF64.subarray(ptr >> 3, (ptr >> 3) + n);
    }

    const vmax = approxPercentileFinite(grid, clipP, 8);

    // rasterise
    for (let k = 0; k < n; k++) {
      const v = grid[k];
      const idx = 4 * k;

      if (!Number.isFinite(v)) {
        pix[idx + 3] = 0;
        continue;
      }

      const vclip = Math.min(v, vmax);
      const t = logScale
        ? Math.log(1 + vclip) / Math.log(1 + vmax)
        : (vclip / (vmax || 1));

      const [r, g, bb] = colour(t);
      pix[idx] = r;
      pix[idx + 1] = g;
      pix[idx + 2] = bb;
      pix[idx + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);
    drawFootprints(ctx, nx, ny, a, b, xmin, xmax, ymin, ymax);
  }

  function requestRedraw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(redraw);
  }

  bSlider.addEventListener("input", requestRedraw);
  clipSlider.addEventListener("input", requestRedraw);
  logToggle.addEventListener("change", requestRedraw);

  redraw();
}

main().catch((e) => {
  console.error(e);
  alert(e?.message ?? String(e));
});