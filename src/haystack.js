/**
 * Procedural haystack built directly as Gaussian splats (Chunk A, synthetic route).
 *
 * A strand is a short curve lying on a dome; each curve segment becomes one
 * elongated, thin Gaussian. Spark's `constructSplats` hook lets us push them
 * straight into a SplatMesh, so there is no file at all and we control the
 * splat index order (strand by strand, base to tip), which Chunk E will use.
 *
 * All coordinates are in "pile units": radius 1, so the viewer's normalise
 * step is almost a no-op.
 */
import * as THREE from "three";

export const HAYSTACK_DEFAULTS = {
  seed: 7,
  strands: 5200, // strands lying on the dome
  looseStrands: 700, // strands poking out of the top
  skirtStrands: 900, // fallen strands around the base
  segments: 8, // splats per strand
  strandLength: 0.42, // in pile radii
  thickness: 0.0065, // strand radius in pile radii
  radius: 1,
  height: 0.85,
  droop: 1.6, // how strongly strands bend downhill
  waviness: 0.35,
};

export function haystackSplatCount(o = HAYSTACK_DEFAULTS) {
  return (o.strands + o.looseStrands + o.skirtStrands) * o.segments;
}

/** Deterministic PRNG (mulberry32) so the same seed gives the same pile. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dome height at planar radius r (rounded cone). */
function domeY(r, o) {
  const u = Math.min(1, r / o.radius);
  return o.height * Math.pow(Math.max(0, 1 - u * u), 0.65);
}

/** Outward surface normal of the dome at a point. */
function domeNormal(x, z, o, out) {
  const r = Math.hypot(x, z) || 1e-6;
  const e = 1e-3;
  const dy = (domeY(r + e, o) - domeY(r - e, o)) / (2 * e); // dY/dr (negative)
  // Gradient of (y - dome(r)) = (-dy * x/r, 1, -dy * z/r)
  return out.set((-dy * x) / r, 1, (-dy * z) / r).normalize();
}

/**
 * @param {import("@sparkjsdev/spark").PackedSplats} splats
 * @param {typeof HAYSTACK_DEFAULTS} o
 */
export function buildHaystack(splats, o = HAYSTACK_DEFAULTS) {
  const random = rng(o.seed);
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const color = new THREE.Color();
  const X = new THREE.Vector3(1, 0, 0);

  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const strawBase = new THREE.Color(0.86, 0.68, 0.3);
  const strawPale = new THREE.Color(0.93, 0.85, 0.58);
  const strawGreen = new THREE.Color(0.62, 0.6, 0.26);
  const strawDark = new THREE.Color(0.5, 0.36, 0.14);

  function strandColor(depth, kind) {
    // kind: 0 regular, 1 loose/top (paler), 2 skirt (dirtier)
    const u = random();
    const base = u < 0.1 ? strawGreen : u < 0.35 ? strawPale : strawBase;
    color.copy(base).lerp(strawDark, Math.min(1, depth * 3.5 + (kind === 2 ? 0.25 : 0)));
    if (kind === 1) color.lerp(strawPale, 0.3);
    // per-strand hue/brightness jitter
    const j = 0.9 + random() * 0.2;
    color.multiplyScalar(j);
    return color;
  }

  function emitStrand(start, tangent, length, depth, kind, drooping) {
    const segLen = length / o.segments;
    const col = strandColor(depth, kind);
    const w = o.thickness * (0.8 + random() * 0.5);
    p.copy(start);
    t.copy(tangent).normalize();
    for (let i = 0; i < o.segments; i++) {
      prev.copy(p);
      // bend: gravity/downhill + waviness, then keep near the dome surface
      if (drooping) {
        domeNormal(p.x, p.z, o, n);
        tmp.set(p.x, 0, p.z).normalize(); // outward-planar = downhill-ish
        dir.copy(tmp).addScaledVector(n, -0.6); // down the slope
        t.addScaledVector(dir, o.droop * segLen * (0.5 + random()));
        t.addScaledVector(n, -t.dot(n) * 0.8); // hug the surface
      }
      t.x += (random() - 0.5) * o.waviness * segLen * 6;
      t.y += (random() - 0.5) * o.waviness * segLen * 6;
      t.z += (random() - 0.5) * o.waviness * segLen * 6;
      t.normalize();
      p.addScaledVector(t, segLen);
      if (drooping) {
        // snap back toward the surface, sunk by `depth`
        const r = Math.hypot(p.x, p.z);
        const target = domeY(r, o) - depth;
        p.y += (target - p.y) * 0.5;
      }
      if (p.y < 0.002) p.y = 0.002;

      center.lerpVectors(prev, p, 0.5);
      dir.subVectors(p, prev).normalize();
      quat.setFromUnitVectors(X, dir);
      // taper toward the tip
      const taper = 1 - 0.45 * (i / (o.segments - 1));
      scales.set(segLen * 0.58, w * taper, w * taper);
      splats.pushSplat(center, scales, quat, 0.92, col);
    }
  }

  // 1. Strands lying on the dome. Uniform over surface area (r ∝ sqrt(u)),
  //    sunk 0..0.12 into the pile for layering and shading.
  for (let i = 0; i < o.strands; i++) {
    const r = Math.sqrt(random()) * o.radius * 0.98;
    const a = random() * Math.PI * 2;
    const depth = Math.pow(random(), 1.6) * 0.12;
    p.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    p.y = domeY(r, o) - depth;
    domeNormal(p.x, p.z, o, n);
    // random tangent in the surface plane
    tmp.set(random() - 0.5, random() - 0.5, random() - 0.5);
    t.crossVectors(n, tmp).normalize();
    const len = o.strandLength * (0.6 + random() * 0.8);
    // start half a strand "back" so the strand is centred on the sample
    p.addScaledVector(t, -len * 0.5);
    emitStrand(p, t, len, depth, 0, true);
  }

  // 2. Loose strands poking out of the upper dome.
  for (let i = 0; i < o.looseStrands; i++) {
    const r = Math.sqrt(random()) * o.radius * 0.55;
    const a = random() * Math.PI * 2;
    p.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    p.y = domeY(r, o) - 0.03;
    domeNormal(p.x, p.z, o, n);
    tmp.set(random() - 0.5, random() * 0.6, random() - 0.5).normalize();
    t.copy(n).lerp(tmp, 0.55).normalize();
    emitStrand(p, t, o.strandLength * (0.5 + random() * 0.6), 0, 1, false);
  }

  // 3. Skirt: fallen strands lying flat on the ground around the base.
  for (let i = 0; i < o.skirtStrands; i++) {
    const r = o.radius * (0.9 + Math.pow(random(), 0.7) * 0.45);
    const a = random() * Math.PI * 2;
    p.set(Math.cos(a) * r, 0.004 + random() * 0.01, Math.sin(a) * r);
    tmp.set(random() - 0.5, 0, random() - 0.5).normalize();
    // mostly tangential to the pile, a bit radial
    t.set(-Math.sin(a), 0, Math.cos(a)).lerp(tmp, 0.6).normalize();
    emitStrand(p, t, o.strandLength * (0.5 + random() * 0.7), 0.05, 2, false);
  }
}
