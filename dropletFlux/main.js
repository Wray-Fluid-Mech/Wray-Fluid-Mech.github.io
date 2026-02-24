import createModule from "./flux_pair.mjs";

const $ = (s) => document.querySelector(s);
const setStatus = (t) => { $("#status").textContent = t; };

function waitForPlotly() {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      if (window.Plotly) return resolve(window.Plotly);
      if (performance.now() - t0 > 8000) return reject(new Error("Plotly failed to load"));
      requestAnimationFrame(tick);
    };
    tick();
  });
}

const RED_BLUE = [
  [0.0, "rgb(0, 80, 200)"],
  [0.5, "rgb(220, 235, 255)"],
  [1.0, "rgb(200, 30, 30)"]
];

function clampMinB(b, a) { return Math.max(b, 2 * a + 1e-6); }

function fillZ2D(grid, nx, ny, z2d) {
  let zmin = +Infinity, zmax = -Infinity;
  for (let j = 0; j < ny; j++) {
    const row = z2d[j];
    const base = j * nx;
    for (let i = 0; i < nx; i++) {
      const v = grid[base + i];
      if (Number.isFinite(v)) {
        row[i] = v;
        if (v < zmin) zmin = v;
        if (v > zmax) zmax = v;
      } else row[i] = null;
    }
  }
  if (!Number.isFinite(zmin)) { zmin = 0; zmax = 1; }
  return { zmin, zmax };
}

function approxPercentileFinite2D(z2d, p, stride = 6) {
  const sample = [];
  const ny = z2d.length;
  const nx = z2d[0].length;

  for (let j = 0; j < ny; j += stride) {
    const row = z2d[j];
    for (let i = 0; i < nx; i += stride) {
      const v = row[i];
      if (v !== null && Number.isFinite(v)) sample.push(v);
    }
  }
  if (!sample.length) return 0.0;

  sample.sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sample.length - 1, Math.floor(p * (sample.length - 1))));
  return sample[idx];
}

function fillLogShift(z2d, out2d, Jmin, eps) {
  for (let j = 0; j < z2d.length; j++) {
    const row = z2d[j];
    const out = out2d[j];
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (v === null) { out[i] = null; continue; }
      out[i] = Math.log(Math.max(v - Jmin, 0) + eps);
    }
  }
}

function computeViewRanges(gd, a, b, zoomA) {
  const cx = -0.5 * b;
  const rect = gd.getBoundingClientRect();
  const aspect = rect.height / Math.max(1, rect.width);
  const xHalf = zoomA * a;
  const yHalf = Math.max(2.2 * a, xHalf * aspect);
  return { xmin: cx - xHalf, xmax: cx + xHalf, ymin: -yHalf, ymax: +yHalf };
}

function scheduleIdle(fn, fallbackMs = 0) {
  if ("requestIdleCallback" in window) {
    return window.requestIdleCallback(() => fn(), { timeout: 2000 });
  }
  return window.setTimeout(fn, fallbackMs);
}

// Chunked conversion so apply step doesn't freeze UI
async function flatTo2DNullChunked(flat, nx, ny, rowsPerYield = 12, shouldAbort = () => false) {
  const out = new Array(ny);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    if (shouldAbort()) return null;
    const row = new Array(nx);
    for (let i = 0; i < nx; i++, k++) {
      const v = flat[k];
      row[i] = Number.isFinite(v) ? v : null;
    }
    out[j] = row;

    if ((j % rowsPerYield) === 0 && j !== 0) {
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
  return out;
}

// --- Ghost overlay (no Plotly calls during drag) ---
function ensureGhostOverlay(gd) {
  if (getComputedStyle(gd).position === "static") gd.style.position = "relative";

  let svg = gd.querySelector("#ghostOverlay");
  if (svg) return svg;

  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "ghostOverlay";
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "20";
  svg.style.display = "none";

  const c1 = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const c2 = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const c of [c1, c2]) {
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "rgba(255,80,80,0.95)");
    c.setAttribute("stroke-width", "2.6");
    c.setAttribute("stroke-dasharray", "6 5");
  }
  c1.id = "ghost1";
  c2.id = "ghost2";
  svg.appendChild(c1);
  svg.appendChild(c2);

  gd.appendChild(svg);
  return svg;
}

function setOverlayViewBox(svg, gd) {
  const w = gd.clientWidth || 1;
  const h = gd.clientHeight || 1;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
}

function setGhost(svg, show) {
  svg.style.display = show ? "block" : "none";
}

function updateGhost(svg, gd, a, bGhost) {
  const fl = gd._fullLayout;
  if (!fl || !fl.xaxis || !fl.yaxis) return;

  const xa = fl.xaxis;
  const ya = fl.yaxis;

  const x0px = xa._offset, y0px = ya._offset;
  const xLen = xa._length, yLen = ya._length;

  const xr = xa.range;
  const yr = ya.range;

  const xMin = xr[0], xMax = xr[1];
  const yMin = yr[0], yMax = yr[1];

  const sx = xLen / Math.abs(xMax - xMin || 1);
  const sy = yLen / Math.abs(yMax - yMin || 1);
  const rpx = a * Math.min(Math.abs(sx), Math.abs(sy));

  const xToPx = (x) => x0px + (x - xMin) / (xMax - xMin) * xLen;
  const yToPx = (y) => y0px + (yMax - y) / (yMax - yMin) * yLen;

  const c1x = -0.5 * bGhost;
  const c2x = +0.5 * bGhost;

  const c1 = svg.querySelector("#ghost1");
  const c2 = svg.querySelector("#ghost2");

  c1.setAttribute("cx", xToPx(c1x));
  c1.setAttribute("cy", yToPx(0));
  c1.setAttribute("r", rpx);

  c2.setAttribute("cx", xToPx(c2x));
  c2.setAttribute("cy", yToPx(0));
  c2.setAttribute("r", rpx);
}

// -------------------- MAIN --------------------
async function main() {
  setStatus("loading WASM + Plotly…");

  const [Plotly, mod] = await Promise.all([
    waitForPlotly(),
    createModule({ locateFile: (p) => new URL(p, import.meta.url).toString() })
  ]);

  const fill_flux_pair = mod.cwrap("fill_flux_pair", null, [
    "number","number","number","number","number","number","number","number","number"
  ]);

  // Controls
  const bSlider = $("#b");
  const zoomSlider = $("#zoom");
  const ncontSlider = $("#ncont");
  const showContours = $("#showContours");
  const showFootprints = $("#showFootprints");
  const liveContours = $("#liveContours");
  const logShade = $("#logShade");
  const clipToggle = $("#clip");

  const bVal = $("#bVal");
  const zoomVal = $("#zoomVal");
  const contVal = $("#contVal");

  const a = 1.0;
  const gd = $("#plot");

  // Coarse grids
  const nxH = 360, nyH = 240;
  const nH = nxH * nyH;
  const ptrH = mod._malloc(nH * 8);
  const zH = Array.from({ length: nyH }, () => Array(nxH).fill(null));
  const zHlog = Array.from({ length: nyH }, () => Array(nxH).fill(null));

  const nxC = 140, nyC = 95;
  const nC = nxC * nyC;
  const ptrC = mod._malloc(nC * 8);
  const zC = Array.from({ length: nyC }, () => Array(nxC).fill(null));
  const zClog = Array.from({ length: nyC }, () => Array(nxC).fill(null));

  // Plotly traces
  const heat = {
    type: "heatmap",
    z: zH,
    x0: 0, dx: 1,
    y0: 0, dy: 1,
    colorscale: RED_BLUE,
    zsmooth: false,
    hovertemplate: "x=%{x:.3f}<br>y=%{y:.3f}<br>value=%{z:.4e}<extra></extra>",
    colorbar: { title: "shading" }
  };

  const cont = {
    type: "contour",
    z: zClog,
    x0: 0, dx: 1,
    y0: 0, dy: 1,
    showscale: false,
    hoverinfo: "skip",
    line: { width: 1.2, color: "rgba(255,255,255,0.55)" },
    contours: { coloring: "none", showlines: true, start: 0, end: 1, size: 0.1 },
    visible: false
  };

  const layout = {
    margin: { l: 60, r: 20, t: 18, b: 50 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { title: "x", gridcolor: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.78)" },
    yaxis: {
      title: "y",
      gridcolor: "rgba(255,255,255,0.08)",
      color: "rgba(255,255,255,0.78)",
      scaleanchor: "x",
      scaleratio: 1
    },
    shapes: []
  };

  const config = { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ["select2d","lasso2d"] };
  await Plotly.newPlot(gd, [heat, cont], layout, config);

  // Ghost overlay
  const ghost = ensureGhostOverlay(gd);
  setOverlayViewBox(ghost, gd);

  // Cached heap view
  let heapBuf = null;
  let heapF64 = null;
  function getHeapF64() {
    const buf = mod.wasmMemory.buffer;
    if (buf !== heapBuf) { heapBuf = buf; heapF64 = new Float64Array(buf); }
    return heapF64;
  }

  // Refinement worker
  const refineWorker = new Worker(new URL("./refine_worker.js", import.meta.url), { type: "module" });
  let refineJobId = 0;
  let refineTimer = null;
  let pendingRefine = null;
  let applyScheduled = false;

  // Interaction tracking
  let userActiveUntil = 0;
  function noteUserActivity() { userActiveUntil = performance.now() + 900; } // ms
  function userIsActive() { return performance.now() < userActiveUntil; }

  // State
  const state = {
    bRendered: clampMinB(Number(bSlider.value), a),
    zoomRendered: Number(zoomSlider.value),
    rangesRendered: null,
    shadeFrozen: null, // {zmin,zmax,title,logShade,Jmin,eps}
    contFrozen: null   // {start,end,size,Jmin,eps}
  };

  let isRendering = false;
  let needsRerender = false;
  let ghostActive = false;

  let contourToken = 0;
  let contourTimer = null;

  function updateReadouts() {
    const b = clampMinB(Number(bSlider.value), a);
    const zoomA = Number(zoomSlider.value);
    const ncont = Number(ncontSlider.value);
    bVal.textContent = `b=${b.toFixed(2)} (2a=${(2*a).toFixed(2)})`;
    zoomVal.textContent = `±${zoomA.toFixed(1)}a`;
    contVal.textContent = `${ncont} levels`;
  }

  async function hideContoursNow() {
    await Plotly.restyle(gd, { visible: [false] }, [1]);
  }

  async function restoreContoursVisibility() {
    await Plotly.restyle(gd, { visible: [showContours.checked ? true : false] }, [1]);
  }

  function scheduleContours(delayMs) {
    clearTimeout(contourTimer);
    const myToken = ++contourToken;

    if (!showContours.checked) {
      restoreContoursVisibility();
      return;
    }

    contourTimer = setTimeout(() => {
      scheduleIdle(() => {
        if (myToken !== contourToken) return;
        updateContours();
      }, 0);
    }, delayMs);
  }

  async function updateContours() {
    if (!showContours.checked) {
      await restoreContoursVisibility();
      return;
    }

    const b = state.bRendered;
    const zoomA = state.zoomRendered;
    const ncont = Number(ncontSlider.value);

    const ranges = state.rangesRendered ?? computeViewRanges(gd, a, b, zoomA);
    const { xmin, xmax, ymin, ymax } = ranges;

    const dxC = (xmax - xmin) / (nxC - 1);
    const dyC = (ymax - ymin) / (nyC - 1);

    fill_flux_pair(a, b, nxC, nyC, xmin, xmax, ymin, ymax, ptrC);
    const heap = getHeapF64();
    const gridC = heap.subarray(ptrC >> 3, (ptrC >> 3) + nC);

    const { zmin, zmax } = fillZ2D(gridC, nxC, nyC, zC);

    const span = Math.max(1e-12, (zmax - zmin));
    const eps = 1e-12 * span + 1e-12;

    fillLogShift(zC, zClog, zmin, eps);

    let Lmin = +Infinity, Lmax = -Infinity;
    for (let j = 0; j < nyC; j++) {
      const row = zClog[j];
      for (let i = 0; i < nxC; i++) {
        const v = row[i];
        if (v !== null && Number.isFinite(v)) {
          if (v < Lmin) Lmin = v;
          if (v > Lmax) Lmax = v;
        }
      }
    }
    if (!Number.isFinite(Lmin) || !Number.isFinite(Lmax) || !(Lmax > Lmin)) { Lmin = 0; Lmax = 1; }

    const start = Lmin;
    const end = Lmax;
    const size = (end - start) / Math.max(1, (ncont - 1));

    state.contFrozen = { start, end, size, Jmin: zmin, eps };

    setStatus("updating contours…");

    await Plotly.restyle(gd, {
      z: [zClog],
      x0: [xmin], dx: [dxC],
      y0: [ymin], dy: [dyC],
      "contours.start": [start],
      "contours.end": [end],
      "contours.size": [size],
      visible: [false]
    }, [1]);

    await restoreContoursVisibility();
    setStatus("ready");

    scheduleRefine();
  }

  // ---- Refinement scheduling + apply (idle only) ----
  function cancelRefine() {
    refineJobId++;
    pendingRefine = null;
  }

  function scheduleRefine() {
    clearTimeout(refineTimer);
    // start refinement only after user has been idle for a bit
    refineTimer = setTimeout(() => {
      if (ghostActive || isRendering || userIsActive()) return;
      kickoffRefine();
    }, 900);
  }

  function kickoffRefine() {
    if (!state.rangesRendered || !state.shadeFrozen || !state.contFrozen) return;

    const jobId = ++refineJobId;

    const nxH2 = 720, nyH2 = 480;
    const nxC2 = 280, nyC2 = 190;

    const { xmin, xmax, ymin, ymax } = state.rangesRendered;

    refineWorker.postMessage({
      type: "refine",
      jobId,
      a,
      b: state.bRendered,
      xmin, xmax, ymin, ymax,
      shade: {
        logShade: !!state.shadeFrozen.logShade,
        JminShade: state.shadeFrozen.Jmin,
        epsShade: state.shadeFrozen.eps
      },
      cont: {
        JminCont: state.contFrozen.Jmin,
        epsCont: state.contFrozen.eps
      },
      nxH: nxH2, nyH: nyH2,
      nxC: nxC2, nyC: nyC2
    });
  }

  function scheduleApplyRefine() {
    if (applyScheduled) return;
    applyScheduled = true;

    const attempt = () => {
      applyScheduled = false;
      if (!pendingRefine) return;

      // Don't apply while interacting; reschedule
      if (ghostActive || isRendering || userIsActive()) {
        scheduleRefine(); // try again later
        return;
      }

      scheduleIdle(() => {
        // Re-check at execution time
        if (ghostActive || isRendering || userIsActive()) {
          scheduleRefine();
          return;
        }
        applyRefine(pendingRefine).catch(console.error);
      }, 0);
    };

    // slight delay so quick subsequent interactions win
    setTimeout(attempt, 0);
  }

  async function applyRefine(msg) {
    if (msg.jobId !== refineJobId) return;
    if (!state.rangesRendered || !state.shadeFrozen || !state.contFrozen) return;

    const shouldAbort = () => ghostActive || isRendering || userIsActive() || msg.jobId !== refineJobId;

    const { xmin, xmax, ymin, ymax } = state.rangesRendered;

    // Heat
    const heatFlat = new Float32Array(msg.heatBuf);
    const zRefined = await flatTo2DNullChunked(heatFlat, msg.nxH, msg.nyH, 10, shouldAbort);
    if (!zRefined) return; // aborted due to interaction

    const dxH2 = (xmax - xmin) / (msg.nxH - 1);
    const dyH2 = (ymax - ymin) / (msg.nyH - 1);

    await Plotly.restyle(gd, {
      z: [zRefined],
      x0: [xmin], dx: [dxH2],
      y0: [ymin], dy: [dyH2],
      zmin: [state.shadeFrozen.zmin],
      zmax: [state.shadeFrozen.zmax],
      "colorbar.title": [state.shadeFrozen.title]
    }, [0]);

    // Contours
    if (showContours.checked) {
      const contFlat = new Float32Array(msg.contBuf);
      const zContRefined = await flatTo2DNullChunked(contFlat, msg.nxC, msg.nyC, 10, shouldAbort);
      if (!zContRefined) return;

      const dxC2 = (xmax - xmin) / (msg.nxC - 1);
      const dyC2 = (ymax - ymin) / (msg.nyC - 1);

      await Plotly.restyle(gd, { visible: [false] }, [1]);
      await Plotly.restyle(gd, {
        z: [zContRefined],
        x0: [xmin], dx: [dxC2],
        y0: [ymin], dy: [dyC2],
        "contours.start": [state.contFrozen.start],
        "contours.end": [state.contFrozen.end],
        "contours.size": [state.contFrozen.size]
      }, [1]);
      await restoreContoursVisibility();
    }
  }

  refineWorker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "refined") return;
    if (msg.jobId !== refineJobId) return;

    pendingRefine = msg;
    scheduleApplyRefine();
  };

  async function renderFull() {
    if (isRendering) { needsRerender = true; return; }
    isRendering = true;
    setStatus("rendering…");

    ghostActive = false;
    setGhost(ghost, false);
    cancelRefine();

    try {
      await hideContoursNow();

      const b = clampMinB(Number(bSlider.value), a);
      const zoomA = Number(zoomSlider.value);
      updateReadouts();

      const ranges = computeViewRanges(gd, a, b, zoomA);
      state.bRendered = b;
      state.zoomRendered = zoomA;
      state.rangesRendered = ranges;

      const { xmin, xmax, ymin, ymax } = ranges;

      const dxH = (xmax - xmin) / (nxH - 1);
      const dyH = (ymax - ymin) / (nyH - 1);

      fill_flux_pair(a, b, nxH, nyH, xmin, xmax, ymin, ymax, ptrH);
      const heap = getHeapF64();
      const gridH = heap.subarray(ptrH >> 3, (ptrH >> 3) + nH);

      const { zmin, zmax } = fillZ2D(gridH, nxH, nyH, zH);

      const span = Math.max(1e-12, (zmax - zmin));
      const eps = 1e-12 * span + 1e-12;

      let zShade = zH;
      let shadeTitle = "J";
      if (logShade.checked) {
        fillLogShift(zH, zHlog, zmin, eps);
        zShade = zHlog;
        shadeTitle = "log(J − Jmin + ε)";
      }

      const pLo = clipToggle.checked ? 0.02 : 0.0;
      const pHi = clipToggle.checked ? 0.98 : 1.0;
      let zminShade = approxPercentileFinite2D(zShade, pLo, 6);
      let zmaxShade = approxPercentileFinite2D(zShade, pHi, 6);
      if (!(zmaxShade > zminShade + 1e-12)) zmaxShade = zminShade + 1e-6;

      state.shadeFrozen = {
        zmin: zminShade,
        zmax: zmaxShade,
        title: shadeTitle,
        logShade: !!logShade.checked,
        Jmin: zmin,
        eps
      };

      await Plotly.restyle(gd, {
        z: [zShade],
        x0: [xmin], dx: [dxH],
        y0: [ymin], dy: [dyH],
        zmin: [zminShade],
        zmax: [zmaxShade],
        "colorbar.title": [shadeTitle]
      }, [0]);

      await Plotly.relayout(gd, {
        "xaxis.range": [xmin, xmax],
        "yaxis.range": [ymin, ymax]
      });

      // footprints (optional)
      if (showFootprints.checked) {
        const c1x = -0.5 * b, c2x = +0.5 * b;
        await Plotly.relayout(gd, {
          shapes: [
            { type: "circle", xref: "x", yref: "y", x0: c1x - a, x1: c1x + a, y0: -a, y1: +a, line: { width: 2, color: "rgba(255,255,255,0.85)" }, fillcolor: "rgba(0,0,0,0)" },
            { type: "circle", xref: "x", yref: "y", x0: c2x - a, x1: c2x + a, y0: -a, y1: +a, line: { width: 2, color: "rgba(255,255,255,0.85)" }, fillcolor: "rgba(0,0,0,0)" }
          ]
        });
      } else {
        await Plotly.relayout(gd, { shapes: [] });
      }

      scheduleContours(0);
    } finally {
      isRendering = false;
      setStatus("ready");
      if (needsRerender) { needsRerender = false; renderFull(); }
    }
  }

  // ---- Drag UX (still buttery) ----
  function beginBDrag() {
    noteUserActivity();
    updateReadouts();
    ghostActive = true;
    cancelRefine();
    setOverlayViewBox(ghost, gd);
    setGhost(ghost, true);
    updateGhost(ghost, gd, a, clampMinB(Number(bSlider.value), a));
    setStatus("dragging…");
  }

  function duringBDrag() {
    noteUserActivity();
    updateReadouts();
    if (!ghostActive) return;
    updateGhost(ghost, gd, a, clampMinB(Number(bSlider.value), a));
  }

  function endBDrag() {
    noteUserActivity();
    updateReadouts();
    ghostActive = false;
    setGhost(ghost, false);
    renderFull();
  }

  // Events
  bSlider.addEventListener("pointerdown", beginBDrag);
  bSlider.addEventListener("mousedown", beginBDrag);
  bSlider.addEventListener("input", duringBDrag);
  bSlider.addEventListener("change", endBDrag);

  zoomSlider.addEventListener("input", () => { noteUserActivity(); updateReadouts(); setStatus("dragging…"); });
  zoomSlider.addEventListener("change", () => { noteUserActivity(); updateReadouts(); renderFull(); });

  ncontSlider.addEventListener("input", () => { noteUserActivity(); updateReadouts(); setStatus("adjusting…"); });
  ncontSlider.addEventListener("change", async () => {
    noteUserActivity();
    updateReadouts();
    cancelRefine();
    await hideContoursNow();
    scheduleContours(0);
  });

  showContours.addEventListener("change", async () => {
    noteUserActivity();
    cancelRefine();
    await hideContoursNow();
    scheduleContours(0);
  });

  showFootprints.addEventListener("change", () => { noteUserActivity(); renderFull(); });
  logShade.addEventListener("change", () => { noteUserActivity(); cancelRefine(); renderFull(); });
  clipToggle.addEventListener("change", () => { noteUserActivity(); cancelRefine(); renderFull(); });
  liveContours.addEventListener("change", () => { noteUserActivity(); cancelRefine(); renderFull(); });

  window.addEventListener("resize", () => {
    noteUserActivity();
    clearTimeout(window.__rz);
    cancelRefine();
    setOverlayViewBox(ghost, gd);
    if (ghostActive) duringBDrag();
    window.__rz = setTimeout(renderFull, 280);
  });

  // First render
  updateReadouts();
  await renderFull();
}

main().catch((e) => {
  console.error(e);
  setStatus("error");
  alert(e?.message ?? String(e));
});