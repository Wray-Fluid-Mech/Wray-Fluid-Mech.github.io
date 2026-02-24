// refine_worker.js (module worker)
// Refines fields using FIXED transforms passed from main thread.
// Now includes cooperative yielding so it doesn't hog CPU continuously.

import createModule from "./flux_pair.mjs";

let mod = null;
let fill = null;

let heapBuf = null;
let heapF64 = null;
function getHeapF64() {
  const buf = mod.wasmMemory.buffer;
  if (buf !== heapBuf) {
    heapBuf = buf;
    heapF64 = new Float64Array(buf);
  }
  return heapF64;
}

// Reuse WASM allocations between jobs to reduce malloc/free churn.
let ptrH = 0, capH = 0;
let ptrC = 0, capC = 0;

async function ensureWasm() {
  if (mod) return;
  mod = await createModule({ locateFile: (p) => new URL(p, import.meta.url).toString() });
  fill = mod.cwrap("fill_flux_pair", null, [
    "number","number","number","number","number","number","number","number","number"
  ]);
  heapBuf = mod.wasmMemory.buffer;
  heapF64 = new Float64Array(heapBuf);
}

function ensureCapacity(nH, nC) {
  if (nH > capH) {
    if (ptrH) mod._free(ptrH);
    ptrH = mod._malloc(nH * 8);
    capH = nH;
  }
  if (nC > capC) {
    if (ptrC) mod._free(ptrC);
    ptrC = mod._malloc(nC * 8);
    capC = nC;
  }
}

let latestJobId = 0;

function shadeValue(J, logShade, Jmin, eps) {
  if (!Number.isFinite(J)) return NaN;
  if (!logShade) return J;
  const s = Math.max(J - Jmin, 0) + eps;
  return Math.log(s);
}

function contourValue(J, Jmin, eps) {
  if (!Number.isFinite(J)) return NaN;
  const s = Math.max(J - Jmin, 0) + eps;
  return Math.log(s);
}

const YIELD_EVERY = 65536; // ~ power-of-two chunk; yields often enough to keep UI snappy

function yieldNow() {
  return new Promise((r) => setTimeout(r, 0));
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "refine") return;

  const {
    jobId,
    a, b,
    xmin, xmax, ymin, ymax,

    shade: { logShade, JminShade, epsShade },
    cont: { JminCont, epsCont },

    nxH, nyH, nxC, nyC
  } = msg;

  latestJobId = jobId;

  await ensureWasm();

  const nH = nxH * nyH;
  const nC = nxC * nyC;
  ensureCapacity(nH, nC);

  try {
    // --- refined heat field ---
    fill(a, b, nxH, nyH, xmin, xmax, ymin, ymax, ptrH);
    if (jobId !== latestJobId) return;

    let heap = getHeapF64();
    let JH = heap.subarray(ptrH >> 3, (ptrH >> 3) + nH);

    const shadeFlat = new Float32Array(nH);
    for (let i = 0; i < nH; i++) {
      shadeFlat[i] = shadeValue(JH[i], logShade, JminShade, epsShade);
      if ((i % YIELD_EVERY) === 0) {
        if (jobId !== latestJobId) return;
        await yieldNow();
      }
    }

    // --- refined contour field (log-shift) ---
    fill(a, b, nxC, nyC, xmin, xmax, ymin, ymax, ptrC);
    if (jobId !== latestJobId) return;

    heap = getHeapF64();
    const JC = heap.subarray(ptrC >> 3, (ptrC >> 3) + nC);

    const contFlat = new Float32Array(nC);
    for (let i = 0; i < nC; i++) {
      contFlat[i] = contourValue(JC[i], JminCont, epsCont);
      if ((i % YIELD_EVERY) === 0) {
        if (jobId !== latestJobId) return;
        await yieldNow();
      }
    }

    self.postMessage({
      type: "refined",
      jobId,
      nxH, nyH,
      nxC, nyC,
      heatBuf: shadeFlat.buffer,
      contBuf: contFlat.buffer
    }, [shadeFlat.buffer, contFlat.buffer]);

  } catch (e) {
    // Main thread will ignore stale jobs; only report genuine failures.
    self.postMessage({ type: "error", jobId, message: e?.message ?? String(e) });
  }
};

// Best-effort cleanup if the worker is terminated/reloaded.
self.addEventListener("close", () => {
  try {
    if (mod) {
      if (ptrH) mod._free(ptrH);
      if (ptrC) mod._free(ptrC);
    }
  } catch {}
});