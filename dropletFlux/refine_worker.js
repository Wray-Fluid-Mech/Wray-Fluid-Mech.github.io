// refine_worker.js (module worker)
// Refines fields using FIXED transforms passed from main thread.
// Now includes cooperative yielding so it doesn't hog CPU continuously.

import createModule from "./flux_pair.mjs";

let modPromise = null;
async function getMod() {
  if (!modPromise) {
    modPromise = createModule({ locateFile: (p) => new URL(p, import.meta.url).toString() });
  }
  return modPromise;
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

  const mod = await getMod();
  const fill = mod.cwrap("fill_flux_pair", null, [
    "number","number","number","number","number","number","number","number","number"
  ]);

  const nH = nxH * nyH;
  const ptrH = mod._malloc(nH * 8);

  const nC = nxC * nyC;
  const ptrC = mod._malloc(nC * 8);

  try {
    // --- refined heat field ---
    fill(a, b, nxH, nyH, xmin, xmax, ymin, ymax, ptrH);
    if (jobId !== latestJobId) return;

    let heapF64 = new Float64Array(mod.wasmMemory.buffer);
    let JH = heapF64.subarray(ptrH >> 3, (ptrH >> 3) + nH);

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

    heapF64 = new Float64Array(mod.wasmMemory.buffer);
    const JC = heapF64.subarray(ptrC >> 3, (ptrC >> 3) + nC);

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

  } finally {
    mod._free(ptrH);
    mod._free(ptrC);
  }
};