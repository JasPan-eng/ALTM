/**
 * Chunk E: haystack <-> single stem morph.
 *
 * Every splat gets a second "rest" state: a position on one large straw stem,
 * plus the rotation, scale and colour it should have there. Those live in
 * four float textures (one texel per splat, same 512-wide layout as the sim).
 * A Spark objectModifier mixes the splat's own attributes toward the targets
 * by a per-splat eased weight; the spring simulation reads the same morphed
 * home (see GLSL_MORPH in flow.js) so pointer strokes keep working mid-morph
 * and the moving home injects lag velocity, making the hay spring into place.
 *
 * Mapping: the haystack is emitted strand by strand (`segments` splats each,
 * base to tip). Each strand becomes one longitudinal fibre on the stem's
 * surface, so the thin elongated splats line up along the stem and read as
 * straw striations.
 */
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";
import { GLSL_MORPH } from "./flow.js";

export const MORPH_DEFAULTS = {
  amount: 0,
  stagger: 0.6, // spread of per-splat start times across the slider range
  arc: 0.12, // flight arc height (sim units)
  lag: 0.85, // how much particles lag behind the moving home (spring carries them in)
  animate: false,
  speed: 0.2, // ping-pong cycles per second when animating
  stemLength: 1.5, // sim units (pile width = 1)
  stemRadius: 0.05,
  node: 0.42, // position of the knuckle along the stem (0..1)
  nodeBump: 0.35,
  twist: 0.4, // radians of fibre twist over the stem length
  fibreLength: 0.12, // sim units covered by one strand's splats
};

const WIDTH = 512;

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

function makeTexture(data, rows) {
  const tex = new THREE.DataTexture(data, WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build the stem targets for a loaded SplatMesh.
 * @param {import("@sparkjsdev/spark").SplatMesh} mesh
 * @param {{ count: number, segments: number, objToSim: THREE.Matrix4, simToObjectScale: number, opts?: typeof MORPH_DEFAULTS, seed?: number }} args
 */
export function buildStemTargets(mesh, { count, segments, objToSim, simToObjectScale, opts = MORPH_DEFAULTS, seed = 11 }) {
  const rows = Math.max(1, Math.ceil(count / WIDTH));
  const centers = new Float32Array(WIDTH * rows * 4);
  const rotations = new Float32Array(WIDTH * rows * 4);
  const scales = new Float32Array(WIDTH * rows * 4);
  const colors = new Float32Array(WIDTH * rows * 4);
  const random = rng(seed);

  // A gently bent stem, roughly horizontal, centred on the origin.
  const L = opts.stemLength;
  const curve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-0.5, -0.03, 0.0),
      new THREE.Vector3(-0.2, 0.05, 0.03),
      new THREE.Vector3(0.2, -0.01, -0.03),
      new THREE.Vector3(0.5, 0.07, 0.01),
    ].map((p) => p.multiplyScalar(L)),
    false,
    "catmullrom",
    0.5,
  );
  const FRAMES = 200;
  const frames = curve.computeFrenetFrames(FRAMES, false);
  const seg = segments > 0 ? segments : 1;
  const fibres = Math.ceil(count / seg);
  const fibreT = Math.min(0.9, opts.fibreLength / L); // fibre length as a fraction of the stem
  const ds = fibreT / seg;

  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const next = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);
  const q = new THREE.Quaternion();
  const light = new THREE.Vector3(0.35, 0.9, 0.3).normalize();
  const base = new THREE.Color(0.88, 0.72, 0.36);
  const pale = new THREE.Color(0.95, 0.88, 0.62);
  const dark = new THREE.Color(0.55, 0.4, 0.17);
  const col = new THREE.Color();

  function radius(t) {
    const taper = 0.8 + 0.2 * Math.sqrt(Math.sin(Math.PI * t));
    const bump = 1 + opts.nodeBump * Math.exp(-(((t - opts.node) / 0.025) ** 2));
    return opts.stemRadius * taper * bump;
  }
  function frameAt(t, outN, outB) {
    const f = Math.min(FRAMES - 1, Math.max(0, t * FRAMES));
    const i = Math.floor(f);
    const k = f - i;
    const j = Math.min(FRAMES, i + 1);
    outN.copy(frames.normals[i]).lerp(frames.normals[j], k).normalize();
    outB.copy(frames.binormals[i]).lerp(frames.binormals[j], k).normalize();
  }
  function surface(t, theta, out) {
    curve.getPointAt(t, P);
    frameAt(t, N, B);
    radial.copy(N).multiplyScalar(Math.cos(theta)).addScaledVector(B, Math.sin(theta));
    return out.copy(P).addScaledVector(radial, radius(t));
  }

  // Per fibre: angle around the stem, start along it, colour, delay.
  for (let j = 0; j < fibres; j++) {
    const theta0 = random() * Math.PI * 2;
    const t0 = random() * (1 - fibreT);
    const u = random();
    const fibreCol = u < 0.3 ? pale : base;
    const jitter = 0.88 + random() * 0.24;
    const w = opts.stemRadius * 0.14 * (0.8 + random() * 0.5) * simToObjectScale; // strand thickness in object units
    // Delay: mostly where the fibre sits on the stem (pour from one end), plus noise.
    const delay = Math.min(1, Math.max(0, 0.45 * t0 + 0.55 * random()));

    for (let s = 0; s < seg; s++) {
      const i = j * seg + s;
      if (i >= count) break;
      const t = t0 + (s + 0.5) * ds;
      const theta = theta0 + opts.twist * t;
      surface(t, theta, pos);
      surface(Math.min(1, t + ds), theta0 + opts.twist * (t + ds), next);
      dir.subVectors(next, pos);
      if (dir.lengthSq() < 1e-12) dir.copy(frames.tangents[Math.min(FRAMES, Math.floor(t * FRAMES))]);
      dir.normalize();
      q.setFromUnitVectors(X, dir);

      // shading: fake key light on the cylinder normal, darker band at the node
      const shade = 0.6 + 0.4 * Math.max(0, radial.dot(light));
      const nodeDark = 1 - 0.35 * Math.exp(-(((t - opts.node) / 0.02) ** 2));
      col.copy(fibreCol).lerp(dark, 0.15 * (1 - shade)).multiplyScalar(shade * nodeDark * jitter);

      const o = i * 4;
      centers[o] = pos.x;
      centers[o + 1] = pos.y;
      centers[o + 2] = pos.z;
      centers[o + 3] = delay;
      rotations[o] = q.x;
      rotations[o + 1] = q.y;
      rotations[o + 2] = q.z;
      rotations[o + 3] = q.w;
      scales[o] = ds * L * 0.58 * simToObjectScale;
      scales[o + 1] = w;
      scales[o + 2] = w;
      scales[o + 3] = 1;
      colors[o] = col.r;
      colors[o + 1] = col.g;
      colors[o + 2] = col.b;
      colors[o + 3] = 1;
    }
  }

  return {
    rows,
    centers: makeTexture(centers, rows),
    rotations: makeTexture(rotations, rows),
    scales: makeTexture(scales, rows),
    colors: makeTexture(colors, rows),
    dispose() {
      this.centers.dispose();
      this.rotations.dispose();
      this.scales.dispose();
      this.colors.dispose();
    },
  };
}

/** Spark objectModifier that blends each splat toward its stem target. Runs before the flow modifier. */
export function createMorphModifier() {
  const empty = makeTexture(new Float32Array(4), 1);
  const uniforms = {
    morphCenters: { value: empty },
    morphRotations: { value: empty },
    morphScales: { value: empty },
    morphColors: { value: empty },
    morphSimToObject: { value: new THREE.Matrix4() },
    morphAmount: { value: 0 },
    morphStagger: { value: MORPH_DEFAULTS.stagger },
    morphArc: { value: MORPH_DEFAULTS.arc },
    morphWidth: { value: WIDTH },
  };

  const modifier = new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat },
    outTypes: { gsplat: dyno.Gsplat },
    generate: ({ inputs, outputs }) => ({
      uniforms,
      globals: [
        /* glsl */ `
        uniform sampler2D morphCenters, morphRotations, morphScales, morphColors;
        uniform mat4 morphSimToObject;
        uniform float morphAmount, morphStagger, morphArc;
        uniform int morphWidth;
        vec4 morphSlerp(vec4 a, vec4 b, float t) {
          float d = dot(a, b);
          if (d < 0.0) { b = -b; d = -d; }
          if (d > 0.9995) return normalize(mix(a, b, t));
          float th = acos(clamp(d, -1.0, 1.0));
          return (a * sin((1.0 - t) * th) + b * sin(t * th)) / sin(th);
        }`,
        GLSL_MORPH,
      ],
      statements: [
        `${outputs.gsplat} = ${inputs.gsplat};`,
        /* glsl */ `if (morphAmount > 0.0) {
          ivec2 mc = ivec2(${inputs.gsplat}.index % morphWidth, ${inputs.gsplat}.index / morphWidth);
          vec4 target = texelFetch(morphCenters, mc, 0);
          float k = morphWeight(target.w, morphAmount, morphStagger);
          if (k > 0.0) {
            vec3 targetObj = (morphSimToObject * vec4(target.xyz, 1.0)).xyz;
            vec3 arc = mat3(morphSimToObject) * morphArcDir(${inputs.gsplat}.index) * (sin(k * 3.14159265) * morphArc);
            ${outputs.gsplat}.center = mix(${inputs.gsplat}.center, targetObj, k) + arc;
            ${outputs.gsplat}.quaternion = morphSlerp(${inputs.gsplat}.quaternion, texelFetch(morphRotations, mc, 0), k);
            ${outputs.gsplat}.scales = mix(${inputs.gsplat}.scales, texelFetch(morphScales, mc, 0).xyz, k);
            ${outputs.gsplat}.rgba.rgb = mix(${inputs.gsplat}.rgba.rgb, texelFetch(morphColors, mc, 0).rgb, k);
          }
        }`,
      ],
    }),
  });

  return {
    modifier,
    uniforms,
    setTargets(t) {
      uniforms.morphCenters.value = t?.centers ?? empty;
      uniforms.morphRotations.value = t?.rotations ?? empty;
      uniforms.morphScales.value = t?.scales ?? empty;
      uniforms.morphColors.value = t?.colors ?? empty;
    },
    /** sim space -> splat object space (mat4). */
    setSimToObject(m4) {
      uniforms.morphSimToObject.value.copy(m4);
    },
    configure({ amount, stagger, arc }) {
      if (amount !== undefined) uniforms.morphAmount.value = amount;
      if (stagger !== undefined) uniforms.morphStagger.value = stagger;
      if (arc !== undefined) uniforms.morphArc.value = arc;
    },
  };
}
