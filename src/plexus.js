/**
 * Chunk G: plexus / scan overlay.
 *
 * A sparse network of dots and links over sampled splat centres, drawn in the
 * HUD cyan. Every vertex carries its splat index, so the vertex shader reads
 * the same simulation offsets (and the same morph home) the splats use: the
 * scan moves with the hay instead of floating over it. Links fade as they
 * stretch, so a hand sweeping through tears the network open.
 */
import * as THREE from "three";
import { GLSL_MORPH } from "./flow.js";

export const PLEXUS_DEFAULTS = {
  enabled: true,
  points: 900, // sampled splats
  dotSize: 1.8, // CSS px
  linkRadius: 0.07, // sim units (pile width = 1)
  maxLinks: 2, // per point
  opacity: 0.6,
  color: "#7ac8ff",
  lineOpacity: 0.2,
  stretchFade: 1.8, // links fade when stretched beyond this ratio
};

const WIDTH = 512;

/**
 * @param {ReturnType<typeof import("./flow.js").createFlowSim>} sim
 * @param {ReturnType<typeof import("./morph.js").createMorphModifier>} morphMod
 */
export function createPlexus(sim, morphMod) {
  let p = { ...PLEXUS_DEFAULTS };
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.renderOrder = 10;

  const shared = {
    offsets: sim.output.offsets,
    velocities: sim.output.velocities,
    morphCenters: morphMod.uniforms.morphCenters,
    morphAmount: morphMod.uniforms.morphAmount,
    morphStagger: morphMod.uniforms.morphStagger,
    morphArc: morphMod.uniforms.morphArc,
    morphEnabled: { value: false },
    color: { value: new THREE.Color(p.color) },
    opacity: { value: p.opacity },
    lineOpacity: { value: p.lineOpacity },
    dotSize: { value: p.dotSize },
    pixelRatio: { value: 1 },
    stretchFade: { value: p.stretchFade },
  };

  const common = /* glsl */ `
    uniform sampler2D offsets, velocities, morphCenters;
    uniform bool morphEnabled;
    uniform float morphAmount, morphStagger, morphArc;
    ${GLSL_MORPH}
    vec3 displaced(vec3 rest, float index) {
      int i = int(index);
      ivec2 c = ivec2(i % ${WIDTH}, i / ${WIDTH});
      vec3 home = rest;
      if (morphEnabled) home = morphHome(rest, texelFetch(morphCenters, c, 0), i, morphAmount, morphStagger, morphArc);
      return home + texelFetch(offsets, c, 0).xyz;
    }
    float speedAt(float index) {
      int i = int(index);
      return length(texelFetch(velocities, ivec2(i % ${WIDTH}, i / ${WIDTH}), 0).xyz);
    }`;

  const dotMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    uniforms: shared,
    vertexShader: /* glsl */ `
      in float pointIndex;
      out float vSpeed;
      uniform float dotSize, pixelRatio;
      ${common}
      void main() {
        vec3 pos = displaced(position, pointIndex);
        vSpeed = speedAt(pointIndex);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = (dotSize + vSpeed * 6.0) * pixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      in float vSpeed;
      uniform vec3 color;
      uniform float opacity;
      out vec4 fragColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float a = (1.0 - smoothstep(0.55, 1.0, d)) * opacity;
        // hot core when moving
        vec3 c = mix(color, vec3(1.0, 0.85, 0.55), clamp(vSpeed * 2.0, 0.0, 1.0));
        fragColor = vec4(c, a);
      }`,
  });

  const lineMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    uniforms: shared,
    vertexShader: /* glsl */ `
      in float pointIndex;
      in vec3 otherPosition;
      in float otherIndex;
      in float restLength;
      out float vFade;
      uniform float stretchFade;
      ${common}
      void main() {
        vec3 pos = displaced(position, pointIndex);
        vec3 other = displaced(otherPosition, otherIndex);
        float ratio = length(pos - other) / max(0.0001, restLength);
        vFade = 1.0 - smoothstep(1.0, stretchFade, ratio);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      in float vFade;
      uniform vec3 color;
      uniform float lineOpacity;
      out vec4 fragColor;
      void main() {
        if (vFade <= 0.001) discard;
        fragColor = vec4(color, lineOpacity * vFade);
      }`,
  });

  let points = null;
  let lines = null;

  function dispose() {
    if (points) { group.remove(points); points.geometry.dispose(); points = null; }
    if (lines) { group.remove(lines); lines.geometry.dispose(); lines = null; }
  }

  /**
   * rest: Float32Array(count*4) sim-space positions with w = active flag.
   */
  function build(rest, count) {
    dispose();
    if (!p.enabled || count === 0) return;
    // Sample active splats evenly.
    const stride = Math.max(1, Math.floor(count / p.points));
    const idx = [];
    for (let i = 0; i < count && idx.length < p.points; i += stride) if (rest[i * 4 + 3] > 0.5) idx.push(i);
    const n = idx.length;
    const pos = new Float32Array(n * 3);
    const pidx = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const i = idx[k];
      pos[k * 3] = rest[i * 4];
      pos[k * 3 + 1] = rest[i * 4 + 1];
      pos[k * 3 + 2] = rest[i * 4 + 2];
      pidx[k] = i;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    pg.setAttribute("pointIndex", new THREE.BufferAttribute(pidx, 1));
    points = new THREE.Points(pg, dotMaterial);
    points.frustumCulled = false;
    group.add(points);

    // Links: spatial hash, up to maxLinks nearest within linkRadius, each pair once.
    const cell = p.linkRadius;
    const hash = new Map();
    const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let k = 0; k < n; k++) {
      const h = key(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
      (hash.get(h) ?? hash.set(h, []).get(h)).push(k);
    }
    const a = [];
    const b = [];
    const ai = [];
    const bi = [];
    const len = [];
    const r2 = cell * cell;
    for (let k = 0; k < n; k++) {
      const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      const cand = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const list = hash.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!list) continue;
        for (const j of list) {
          if (j <= k) continue;
          const d2 = (pos[j * 3] - x) ** 2 + (pos[j * 3 + 1] - y) ** 2 + (pos[j * 3 + 2] - z) ** 2;
          if (d2 < r2) cand.push([d2, j]);
        }
      }
      cand.sort((u, v) => u[0] - v[0]);
      for (const [d2, j] of cand.slice(0, p.maxLinks)) {
        a.push(x, y, z); ai.push(pidx[k]);
        b.push(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]); bi.push(pidx[j]);
        len.push(Math.sqrt(d2));
      }
    }
    const m = len.length;
    const lpos = new Float32Array(m * 6);
    const lother = new Float32Array(m * 6);
    const lidx = new Float32Array(m * 2);
    const loidx = new Float32Array(m * 2);
    const llen = new Float32Array(m * 2);
    for (let s = 0; s < m; s++) {
      // vertex 0 = a (other = b), vertex 1 = b (other = a)
      lpos.set([a[s * 3], a[s * 3 + 1], a[s * 3 + 2], b[s * 3], b[s * 3 + 1], b[s * 3 + 2]], s * 6);
      lother.set([b[s * 3], b[s * 3 + 1], b[s * 3 + 2], a[s * 3], a[s * 3 + 1], a[s * 3 + 2]], s * 6);
      lidx[s * 2] = ai[s]; lidx[s * 2 + 1] = bi[s];
      loidx[s * 2] = bi[s]; loidx[s * 2 + 1] = ai[s];
      llen[s * 2] = llen[s * 2 + 1] = len[s];
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(lpos, 3));
    lg.setAttribute("otherPosition", new THREE.BufferAttribute(lother, 3));
    lg.setAttribute("pointIndex", new THREE.BufferAttribute(lidx, 1));
    lg.setAttribute("otherIndex", new THREE.BufferAttribute(loidx, 1));
    lg.setAttribute("restLength", new THREE.BufferAttribute(llen, 1));
    lines = new THREE.LineSegments(lg, lineMaterial);
    lines.frustumCulled = false;
    group.add(lines);
  }

  return {
    object: group,
    get counts() {
      return { points: points?.geometry.attributes.position.count ?? 0, links: (lines?.geometry.attributes.position.count ?? 0) / 2 };
    },
    build,
    setTransform(simToWorld) {
      group.matrix.copy(simToWorld);
      group.matrixWorldNeedsUpdate = true;
    },
    setMorphEnabled(v) {
      shared.morphEnabled.value = !!v;
    },
    configure(next, pixelRatio = 1) {
      const rebuild = next.points !== p.points || next.linkRadius !== p.linkRadius || next.maxLinks !== p.maxLinks || next.enabled !== p.enabled;
      p = { ...p, ...next };
      shared.color.value.set(p.color);
      shared.opacity.value = p.opacity;
      shared.lineOpacity.value = p.lineOpacity;
      shared.dotSize.value = p.dotSize;
      shared.pixelRatio.value = pixelRatio;
      shared.stretchFade.value = p.stretchFade;
      group.visible = p.enabled;
      return rebuild;
    },
    dispose() {
      dispose();
      dotMaterial.dispose();
      lineMaterial.dispose();
    },
  };
}
