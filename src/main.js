/**
 * ALTM hay splat viewer — Chunks B + D.
 *
 * Three.js + Spark. Loads a Gaussian splat (procedural haystack by default),
 * runs a GPU spring simulation driven by pointer strokes (src/flow.js) and a
 * wind sway (src/sway.js), both as Spark objectModifiers.
 *
 * Splat sources:
 *   - GUI "source": haystack (procedural), butterfly (Spark sample)
 *   - drop a .spz / .ply / .splat / .ksplat on the window
 *   - ?splat=/splats/haystack.spz  (files in public/splats/)
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import GUI from "lil-gui";
import { createSwayModifier } from "./sway.js";
import { createFlowSim, createFlowModifier, FLOW_DEFAULTS } from "./flow.js";
import { buildHaystack, haystackSplatCount, HAYSTACK_DEFAULTS } from "./haystack.js";
import { buildStemTargets, createMorphModifier, MORPH_DEFAULTS } from "./morph.js";
import { createBlobLayer, BLOB_DEFAULTS } from "./blobs.js";
import { patchSparkMaterial, RING_DEFAULTS } from "./rings.js";
import { createPlexus, PLEXUS_DEFAULTS } from "./plexus.js";
import { createLook, LOOK_DEFAULTS } from "./look.js";

const SAMPLE_SPLAT = "https://sparkjs.dev/assets/splats/butterfly.spz";

const app = document.getElementById("app");
const status = document.getElementById("status");
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
renderer.setClearColor(new THREE.Color(LOOK_DEFAULTS.background), 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.52;

const spark = new SparkRenderer({ renderer, autoUpdate: true });
scene.add(spark);

const grid = new THREE.GridHelper(4, 16, 0x1a2a36, 0x0f171d);
grid.material.transparent = true;
grid.material.opacity = LOOK_DEFAULTS.floorOpacity;
scene.add(grid);

// Look pass: ring contours patched into Spark's splat shader (fails loudly if Spark changed).
let rings = null;
try {
  rings = patchSparkMaterial(spark);
} catch (err) {
  console.warn("Ring contour patch disabled:", err);
}

// ---------------------------------------------------------------- modifiers
const sway = createSwayModifier();
sway.uniforms.swayAmplitude.value = 0.012;
sway.uniforms.swayFrequency.value = 0.9;

const flow = createFlowSim(renderer);
const flowMod = createFlowModifier(flow);
const morphMod = createMorphModifier();
/** @type {ReturnType<typeof buildStemTargets> | null} */
let morphTargets = null;
let morphDirty = false;

const plexus = createPlexus(flow, morphMod);
scene.add(plexus.object);
const look = createLook(document.body);
/** Current splat's bounding box in sim space (for the HUD) and its rest buffer. */
let simBox = null;
let restSim = null;
let splatLabel = "";
let splatCount = 0;
let pointerOver = false;

/** @type {ReturnType<typeof createBlobLayer> | null} */
let blobLayer = null;

const blobParam = params.get("blobs"); // ?blobs=webcam or ?blobs=ws://host:9980
const settings = {
  source: params.get("splat") ? "url" : "haystack",
  morph: { ...MORPH_DEFAULTS },
  blobs: {
    ...BLOB_DEFAULTS,
    source: blobParam === "webcam" ? "webcam" : blobParam?.startsWith("ws") ? "websocket" : "none",
    wsUrl: blobParam?.startsWith("ws") ? blobParam : BLOB_DEFAULTS.wsUrl,
  },
  flow: { ...FLOW_DEFAULTS },
  sway: { enabled: true, amplitude: sway.uniforms.swayAmplitude.value, frequency: sway.uniforms.swayFrequency.value, tilt: 0.6 },
  hay: { ...HAYSTACK_DEFAULTS },
  look: { ...LOOK_DEFAULTS },
  rings: { ...RING_DEFAULTS },
  plexus: { ...PLEXUS_DEFAULTS },
  autoRotate: false,
  resetView: () => frameSplat(),
  resetSim: () => flow.reset(),
};

const gui = new GUI({ title: "ALTM hay" });
gui.add(settings, "source", ["haystack", "butterfly"]).onChange(loadSource);
gui.add(settings, "autoRotate").onChange((v) => (controls.autoRotate = v));
gui.add(settings, "resetView");

const gMorph = gui.addFolder("morph (haystack → stem)");
gMorph.add(settings.morph, "amount", 0, 1, 0.001).listen().onChange(applyMorph);
gMorph.add(settings.morph, "animate");
gMorph.add(settings.morph, "speed", 0.02, 1, 0.01);
gMorph.add(settings.morph, "stagger", 0, 0.95, 0.01).onChange(applyMorph);
gMorph.add(settings.morph, "arc", 0, 0.5, 0.005).onChange(applyMorph);
gMorph.add(settings.morph, "lag", 0, 1, 0.01).onChange(applyMorph);
const gStem = gMorph.addFolder("stem (rebuild)");
gStem.add(settings.morph, "stemLength", 0.3, 3, 0.01);
gStem.add(settings.morph, "stemRadius", 0.01, 0.2, 0.001);
gStem.add(settings.morph, "node", 0, 1, 0.01);
gStem.add(settings.morph, "nodeBump", 0, 1, 0.01);
gStem.add(settings.morph, "twist", 0, 3, 0.01);
gStem.add(settings.morph, "fibreLength", 0.02, 0.6, 0.005);
gStem.add({ rebuild: () => buildMorph() }, "rebuild");
gStem.close();

const gFlow = gui.addFolder("flow (spring sim)");
gFlow.add(settings.flow, "enabled").onChange(applyFlow);
gFlow.add(settings.flow, "force", 0, 10, 0.1).onChange(applyFlow);
gFlow.add(settings.flow, "stiffness", 1, 60, 0.5).onChange(applyFlow);
gFlow.add(settings.flow, "damping", 0, 20, 0.1).onChange(applyFlow);
gFlow.add(settings.flow, "curl", 0, 3, 0.01).onChange(applyFlow);
gFlow.add(settings.flow, "limit", 0.01, 0.6, 0.01).onChange(applyFlow);
gFlow.add(settings.flow, "variation", 0, 1, 0.01).onChange(applyFlow);
gFlow.add(settings.flow, "brushRadius", 10, 500, 1).onChange(applyFlow);
gFlow.add(settings, "resetSim");
const gAlign = gFlow.addFolder("alignment + streaks");
gAlign.add(settings.flow, "alignment", 0, 1, 0.01).onChange(applyFlow);
gAlign.add(settings.flow, "alignDirect").onChange(applyFlow);
gAlign.add(settings.flow, "alignSpeed", 0.01, 2, 0.01).onChange(applyFlow);
gAlign.add(settings.flow, "alignFollow", 0, 30, 0.1).onChange(applyFlow);
gAlign.add(settings.flow, "alignReturn", 0.1, 20, 0.1).onChange(applyFlow);
gAlign.add(settings.flow, "streakAmount", 0, 1, 0.01).onChange(applyFlow);
gAlign.add(settings.flow, "streakSize", 0.1, 3, 0.01).onChange(applyFlow);
gAlign.add(settings.flow, "streakThickness", 0.01, 1, 0.01).onChange(applyFlow);
gAlign.close();

const gLook = gui.addFolder("look");
gLook.addColor(settings.look, "background").onChange(applyLook);
gLook.add(settings.look, "floor").onChange(applyLook);
gLook.add(settings.look, "floorOpacity", 0, 1, 0.01).onChange(applyLook);
gLook.add(settings.look, "grain").onChange(applyLook);
gLook.add(settings.look, "grainOpacity", 0, 0.6, 0.01).onChange(applyLook);
gLook.add(settings.look, "grainSize", 0.5, 4, 0.05).onChange(applyLook);
gLook.add(settings.look, "vignette").onChange(applyLook);
gLook.add(settings.look, "vignetteAmount", 0, 1, 0.01).onChange(applyLook);
gLook.add(settings.look, "vignetteStart", 0, 100, 1).onChange(applyLook);
gLook.add(settings.look, "hud").onChange(applyLook);
gLook.addColor(settings.look, "hudColor").onChange(applyLook);
gLook.add(settings.look, "hudOpacity", 0, 1, 0.01).onChange(applyLook);
gLook.add(settings.look, "title").onFinishChange(applyLook);
const gRings = gLook.addFolder("ring contours + grade");
gRings.add(settings.rings, "enabled").onChange(applyRings);
gRings.add(settings.rings, "amount", 0, 1, 0.01).onChange(applyRings);
gRings.add(settings.rings, "radius", 0.1, 2, 0.01).onChange(applyRings);
gRings.add(settings.rings, "width", 0.2, 3, 0.01).onChange(applyRings);
gRings.add(settings.rings, "strength", 0, 1, 0.01).onChange(applyRings);
gRings.add(settings.rings, "fill", 0, 1, 0.01).onChange(applyRings);
gRings.add(settings.rings, "stretch", 1, 200, 1).onChange(applyRings);
gRings.add(settings.rings, "colorMix", 0, 1, 0.01).onChange(applyRings);
gRings.addColor(settings.rings, "color").onChange(applyRings);
gRings.add(settings.rings, "saturation", 0, 2, 0.01).onChange(applyRings);
gRings.add(settings.rings, "brightness", 0, 2, 0.01).onChange(applyRings);
gRings.add(settings.rings, "contrast", 0.5, 2, 0.01).onChange(applyRings);
gRings.close();
const gPlexus = gLook.addFolder("plexus / scan");
gPlexus.add(settings.plexus, "enabled").onChange(applyPlexus);
gPlexus.add(settings.plexus, "points", 100, 6000, 50).onFinishChange(applyPlexus);
gPlexus.add(settings.plexus, "linkRadius", 0.01, 0.3, 0.005).onFinishChange(applyPlexus);
gPlexus.add(settings.plexus, "maxLinks", 0, 8, 1).onFinishChange(applyPlexus);
gPlexus.add(settings.plexus, "dotSize", 0.5, 8, 0.1).onChange(applyPlexus);
gPlexus.add(settings.plexus, "opacity", 0, 1, 0.01).onChange(applyPlexus);
gPlexus.add(settings.plexus, "lineOpacity", 0, 1, 0.01).onChange(applyPlexus);
gPlexus.add(settings.plexus, "stretchFade", 1.05, 5, 0.05).onChange(applyPlexus);
gPlexus.addColor(settings.plexus, "color").onChange(applyPlexus);
gPlexus.close();
gLook.close();

function applyLook() {
  look.configure(settings.look);
  renderer.setClearColor(new THREE.Color(settings.look.background), 1);
  grid.visible = settings.look.floor;
  grid.material.opacity = settings.look.floorOpacity;
}
function applyRings() {
  rings?.configure(settings.rings, renderer.getPixelRatio());
}
function applyPlexus() {
  const rebuild = plexus.configure(settings.plexus, renderer.getPixelRatio());
  if (rebuild && restSim) plexus.build(restSim, splatCount);
}

const gBlobs = gui.addFolder("blobs (tracking)");
gBlobs.add(settings.blobs, "source", ["none", "webcam", "websocket"]).onChange(applyBlobs);
gBlobs.add(settings.blobs, "threshold", 4, 120, 1).onChange(applyBlobs);
gBlobs.add(settings.blobs, "learning", 0, 0.2, 0.001).onChange(applyBlobs);
gBlobs.add(settings.blobs, "minArea", 1, 200, 1).onChange(applyBlobs);
gBlobs.add(settings.blobs, "maxBlobs", 1, 8, 1).onChange(applyBlobs);
gBlobs.add(settings.blobs, "smoothing", 0, 0.95, 0.01).onChange(applyBlobs);
gBlobs.add(settings.blobs, "mirror").onChange(applyBlobs);
gBlobs.add(settings.blobs, "debug").onChange(applyBlobs);
gBlobs.add(settings.blobs, "wsUrl").onFinishChange(applyBlobs);
if (settings.blobs.source === "none") gBlobs.close();

function applyBlobs() {
  blobLayer?.configure(settings.blobs);
}

const gSway = gui.addFolder("sway (wind)");
gSway.add(settings.sway, "enabled").onChange(applyModifiers);
gSway.add(settings.sway, "amplitude", 0, 0.2, 0.001).onChange((v) => (sway.uniforms.swayAmplitude.value = v));
gSway.add(settings.sway, "frequency", 0, 6, 0.01).onChange((v) => (sway.uniforms.swayFrequency.value = v));
gSway.add(settings.sway, "tilt", 0, 1, 0.01).onChange((v) => (sway.uniforms.swayTilt.value = v));
gSway.close();

const gHay = gui.addFolder("haystack (rebuild)");
gHay.add(settings.hay, "seed", 1, 999, 1);
gHay.add(settings.hay, "strands", 200, 20000, 100);
gHay.add(settings.hay, "looseStrands", 0, 4000, 50);
gHay.add(settings.hay, "skirtStrands", 0, 4000, 50);
gHay.add(settings.hay, "segments", 2, 16, 1);
gHay.add(settings.hay, "strandLength", 0.05, 1, 0.01);
gHay.add(settings.hay, "thickness", 0.001, 0.03, 0.0005);
gHay.add(settings.hay, "height", 0.2, 1.5, 0.01);
gHay.add(settings.hay, "droop", 0, 4, 0.1);
gHay.add(settings.hay, "waviness", 0, 1, 0.01);
gHay.add({ rebuild: () => loadSource("haystack") }, "rebuild");
gHay.close();

function applyFlow() {
  flow.configure(settings.flow);
  flowMod.configure(settings.flow);
  applyModifiers();
}

function applyMorph() {
  flow.configureMorph(settings.morph);
  morphMod.configure(settings.morph);
  morphDirty = true;
}

/** (Re)build the stem targets for the current splat. */
function buildMorph() {
  if (!mesh) return;
  morphTargets?.dispose();
  const count = mesh.packedSplats?.numSplats ?? 0;
  morphTargets = buildStemTargets(mesh, {
    count,
    segments: currentSegments,
    objToSim: simToObject.clone().invert(),
    simToObjectScale: simToObject3.elements[0],
    opts: settings.morph,
  });
  morphMod.setTargets(morphTargets);
  morphMod.setSimToObject(simToObject);
  flow.setMorph(morphTargets.centers);
  plexus.setMorphEnabled(true);
  applyMorph();
  applyModifiers();
}

// ---------------------------------------------------------------- splat state
/** @type {SplatMesh | null} */
let mesh = null;
/** sim space -> world. Sim space = splat centred and scaled to width 1. */
const simToWorld = new THREE.Matrix4();
/** sim space -> splat object space (mat4), and its mat3 part (for the modifiers). */
const simToObject = new THREE.Matrix4();
const simToObject3 = new THREE.Matrix3();
/** Splats per strand of the current splat (1 for anything not built procedurally). */
let currentSegments = 1;

function setStatus(text) {
  status.textContent = text;
}

function applyModifiers() {
  if (!mesh) return;
  const list = [];
  if (morphTargets) list.push(morphMod.modifier); // first: moves the rest state
  if (settings.flow.enabled) list.push(flowMod.modifier);
  if (settings.sway.enabled) list.push(sway.modifier);
  mesh.objectModifiers = list.length ? list : undefined;
  mesh.updateGenerator();
}

async function loadSource(source) {
  if (source === "haystack") {
    const hay = { ...settings.hay };
    return loadSplat({
      label: `procedural haystack (seed ${hay.seed})`,
      segments: hay.segments,
      maxSplats: haystackSplatCount(hay),
      constructSplats: (splats) => buildHaystack(splats, hay),
    });
  }
  if (source === "butterfly") return loadSplat({ url: SAMPLE_SPLAT });
  if (source === "url") return loadSplat({ url: params.get("splat") });
}

async function loadSplat(source) {
  if (mesh) {
    scene.remove(mesh);
    mesh.dispose();
    mesh = null;
  }
  const { label: givenLabel, segments = 1, ...options } = source;
  const label = givenLabel ?? source.fileName ?? source.url;
  currentSegments = segments;
  setStatus(`loading ${label}…`);

  const next = new SplatMesh({
    ...options,
    raycastable: false,
    lod: false, // keep gsplat.index == original index (the sim texel lookup relies on it)
    onProgress: (e) => {
      if (e.lengthComputable) setStatus(`loading ${label}  ${Math.round((100 * e.loaded) / e.total)}%`);
    },
  });

  try {
    await next.initialized;
  } catch (err) {
    console.error(err);
    setStatus(`failed to load ${label}\n${err?.message ?? err}`);
    next.dispose();
    return;
  }

  mesh = next;
  scene.add(mesh);

  // Placement: centre the splat and scale its widest axis to 1 unit.
  const box = mesh.getBoundingBox(true);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  mesh.scale.setScalar(scale);
  mesh.position.copy(centre).multiplyScalar(-scale);
  mesh.updateMatrixWorld(true);
  grid.position.y = (box.min.y - centre.y) * scale - 0.01;

  // sim -> object: object = centre + sim / scale
  simToObject.makeTranslation(centre.x, centre.y, centre.z).multiply(new THREE.Matrix4().makeScale(1 / scale, 1 / scale, 1 / scale));
  simToWorld.multiplyMatrices(mesh.matrixWorld, simToObject);
  simToObject3.setFromMatrix4(simToObject);
  flowMod.setToObject(simToObject3);

  // Rest buffer in sim space, one RGBA per splat; w = 1 unless nearly transparent.
  const count = mesh.packedSplats?.numSplats ?? 0;
  const rest = new Float32Array(count * 4);
  const objToSim = simToObject.clone().invert();
  const v = new THREE.Vector3();
  mesh.forEachSplat((index, center, _scales, _quat, opacity) => {
    v.copy(center).applyMatrix4(objToSim);
    const o = index * 4;
    rest[o] = v.x;
    rest[o + 1] = v.y;
    rest[o + 2] = v.z;
    rest[o + 3] = opacity > 0.03 ? 1 : 0;
  });
  flow.setRest(rest, count);

  // Look pass state: plexus samples the same rest buffer, HUD frames the sim-space box.
  restSim = rest;
  splatCount = count;
  splatLabel = label;
  simBox = box.clone().applyMatrix4(objToSim);
  plexus.setTransform(simToWorld);
  plexus.setMorphEnabled(false);
  applyPlexus();
  plexus.build(rest, count);
  applyRings();
  applyLook();

  sway.fitTo(box);
  applyFlow();
  buildMorph();
  frameSplat();

  setStatus(`${label}\n${count.toLocaleString()} splats · ${flow.rows} sim rows · move the pointer over it · drag to orbit · drop a file to replace`);
}

function frameSplat() {
  controls.target.set(0, 0, 0);
  camera.position.set(0.9, 0.55, 2.0);
  controls.update();
}

// ---------------------------------------------------------------- pointer -> strokes
const pointerNdc = new THREE.Vector2();
function toNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
  return pointerNdc;
}
let touchDown = false;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") touchDown = true;
});
window.addEventListener("pointermove", (e) => {
  const p = toNdc(e);
  const active = e.pointerType !== "touch" || touchDown;
  pointerOver = Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
  flow.point(p.x, p.y, active);
});
const endPointer = () => {
  touchDown = false;
  pointerOver = false;
  flow.point(pointerNdc.x, pointerNdc.y, false);
};
renderer.domElement.addEventListener("pointerup", endPointer);
renderer.domElement.addEventListener("pointercancel", endPointer);
document.documentElement.addEventListener("pointerleave", endPointer);
window.addEventListener("blur", () => flow.release());

// ---------------------------------------------------------------- drag & drop
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  loadSplat({ fileBytes, fileName: file.name });
});

// ---------------------------------------------------------------- resize + loop
function resize() {
  const w = app.clientWidth;
  const h = app.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(app);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const t = clock.elapsedTime;
  controls.update();
  if (mesh) {
    let dirty = false;
    if (settings.morph.animate && morphTargets) {
      const phase = (t * settings.morph.speed) % 2;
      settings.morph.amount = phase < 1 ? phase : 2 - phase; // ping-pong
      applyMorph();
    }
    if (morphDirty) {
      dirty = true;
      morphDirty = false;
    }
    // Chunk F: tracked blobs become extra strokes (same interface as the pointer).
    if (blobLayer) for (const s of blobLayer.consumeSegments()) flow.stroke(s.ax, s.ay, s.bx, s.by);
    if (settings.flow.enabled) {
      const r = renderer.domElement.getBoundingClientRect();
      dirty = flow.step(dt, camera, simToWorld, r.width, r.height) || dirty;
    }
    if (settings.sway.enabled) {
      sway.tick(t);
      dirty = true;
    }
    if (dirty) mesh.updateVersion(); // re-run the modifiers this frame
  }
  renderer.render(scene, camera);
  if (settings.look.hud) {
    const r = renderer.domElement.getBoundingClientRect();
    look.update({
      camera,
      box: simBox,
      simToWorld,
      pointer: pointerOver ? pointerNdc : null,
      size: { width: r.width, height: r.height },
      dpr: Math.min(devicePixelRatio, 2),
      info: {
        source: splatLabel.slice(0, 28),
        splats: splatCount.toLocaleString(),
        sim: flow.awake ? "live" : "idle",
        morph: settings.morph.amount.toFixed(2),
        blobs: blobLayer?.source === "none" ? "off" : `${blobLayer?.blobs.length ?? 0} ${blobLayer?.source ?? ""}`,
      },
    });
  }
});

blobLayer = createBlobLayer(document.body, settings.blobs);
blobLayer.configure(settings.blobs);

loadSource(settings.source);

Object.assign(window, { scene, camera, renderer, spark, sway, flow, flowMod, morphMod, blobLayer, rings, plexus, look, getMesh: () => mesh, settings });
