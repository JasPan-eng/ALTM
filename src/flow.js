/**
 * Chunk D: GPGPU spring simulation + read-back modifier.
 *
 * Port of the reference site's "flow" system. Every splat is a particle on a
 * damped spring tethered to its rest position. The state lives in float
 * textures (one texel per splat, 512 wide) and is advanced by a fullscreen
 * fragment pass into a ping-pong pair of MRT render targets:
 *
 *   attachment 0  offsets      xyz = displacement from rest
 *   attachment 1  velocities   xyz = velocity
 *   attachment 2  alignments   xyz = smoothed direction of travel (used to tilt splats)
 *
 * Pointer movement is turned into up to 8 stroke segments per frame. Each
 * segment is ray-cast onto a camera-facing plane through the pile centre,
 * and the cursor's 3D displacement becomes an impulse applied to splats whose
 * projected position lies within `brushRadius` pixels of the segment.
 *
 * Simulation space = "sim space": the splat normalised to width 1 and centred
 * (same as the viewer's placement). `flowToObject` converts sim-space offsets
 * back into the splat's own object space inside the Spark modifier.
 */
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";

export const FLOW_DEFAULTS = {
  enabled: true,
  force: 3, // impulse gain
  stiffness: 14, // spring return
  damping: 5.5,
  curl: 0.8, // rotational drag / swirl
  limit: 0.18, // max displacement, in pile widths
  variation: 0.8, // per-particle mass/stiffness/damping spread
  brushRadius: 150, // px
  alignDirect: true,
  alignSpeed: 0.25,
  alignFollow: 12,
  alignReturn: 4,
  alignment: 0.7, // how far splats rotate toward their travel direction
  streakAmount: 1,
  streakThickness: 0.08,
  streakSize: 0.5,
};

const WIDTH = 512;

// ------------------------------------------------------------------ GLSL pieces
const GLSL_SPRING = /* glsl */ `
vec2 springStep(float x, float v, float dt, float stiffness, float damping) {
  // Closed-form damped harmonic oscillator step: stable for any dt.
  float a = damping * 0.5;
  float q = stiffness - a * a;
  float decay = exp(-a * dt);
  float c, s;
  if (q > 0.00001) { float w = sqrt(q); c = cos(w * dt); s = sin(w * dt) / w; }
  else if (q < -0.00001) { float w = sqrt(-q); c = cosh(w * dt); s = sinh(w * dt) / w; }
  else { c = 1.0; s = dt; }
  return decay * vec2((c + a * s) * x + s * v, -stiffness * s * x + (c - a * s) * v);
}`;

const GLSL_RESPONSE = /* glsl */ `
vec3 particleResponse(float sampleValue, float variation) {
  // x = mass, y = stiffness multiplier, z = damping multiplier
  float r = pow(clamp(sampleValue, 0.0, 1.0), 0.35);
  return mix(vec3(1.0), vec3(0.25 + 1.15 * r, 0.2 + 1.05 * r, 0.45 + 0.7 * r), variation);
}`;

const GLSL_SWEEP = /* glsl */ `
float sweepWeight(vec2 p, vec2 a, vec2 b, float radius) {
  vec2 travel = b - a;
  float length2 = dot(travel, travel);
  float t = length2 > 0.0 ? clamp(dot(p - a, travel) / length2, 0.0, 1.0) : 0.0;
  float distance = length(p - (a + t * travel));
  // Long fast sweeps spend less time over each splat: scale down.
  float exposure = min(1.0, 2.0 * radius / max(2.0 * radius, sqrt(length2)));
  return (1.0 - smoothstep(0.0, radius, distance)) * exposure;
}`;

const GLSL_ALIGN_STEP = /* glsl */ `
vec3 alignmentStep(vec3 alignment, vec3 velocity, float dt, float response, float follow, float restore, bool direct) {
  float speed = length(velocity);
  if (direct) {
    if (speed > response * 0.02) return velocity / speed;
    return alignment * exp(-restore * dt);
  }
  vec3 target = speed > 1e-8 ? velocity / speed * smoothstep(0.0, response, speed) : vec3(0.0);
  return mix(alignment, target, 1.0 - exp(-(speed > response * 0.05 ? follow : restore) * dt));
}`;

/**
 * Morph helpers shared by the simulation and the morph modifier so both see
 * the same "home" position for a given splat and morph amount.
 *   delay   per-splat 0..1 (stored in morphCenters.w)
 *   amount  global slider 0..1
 *   stagger 0..0.95: how much of the slider range is spread across splats
 */
export const GLSL_MORPH = /* glsl */ `
float morphWeight(float delay, float amount, float stagger) {
  float k = clamp((amount - delay * stagger) / max(0.0001, 1.0 - stagger), 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}
// Per-splat random direction for the flight arc (biased upward).
vec3 morphArcDir(int index) {
  uint h = uint(index) * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  vec3 d = vec3(float(h & 1023u), float((h >> 10u) & 1023u), float((h >> 20u) & 1023u)) / 1023.0 * 2.0 - 1.0;
  d.y = abs(d.y) * 1.5 + 0.2;
  return normalize(d);
}
vec3 morphHome(vec3 a, vec4 b, int index, float amount, float stagger, float arc) {
  float k = morphWeight(b.w, amount, stagger);
  return mix(a, b.xyz, k) + morphArcDir(index) * (sin(k * 3.14159265) * arc);
}`;

/** Rotate a splat's longest axis toward `direction`, blended by weight (0..1). */
function glslAlignRotation(prefix) {
  return /* glsl */ `
vec4 ${prefix}AlignRotation(vec4 original, vec3 scales, vec3 direction, float weight) {
  if (weight < 0.00001 || dot(direction, direction) < 1e-12) return original;
  float longest = max(scales.x, max(scales.y, scales.z));
  vec3 axis = scales.x == longest ? vec3(1.0, 0.0, 0.0) : scales.y == longest ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 from = normalize(axis + 2.0 * cross(original.xyz, cross(original.xyz, axis) + original.w * axis));
  vec3 to = normalize(direction);
  if (dot(from, to) < 0.0) to = -to;
  vec4 delta = normalize(vec4(cross(from, to), 1.0 + clamp(dot(from, to), 0.0, 1.0)));
  float angle = acos(clamp(delta.w, 0.0, 1.0));
  float fraction = clamp(weight, 0.0, 1.0);
  vec4 turn = angle < 0.0001 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(delta.xyz * (sin(angle * fraction) / sin(angle)), cos(angle * fraction));
  return normalize(vec4(turn.w * original.xyz + original.w * turn.xyz + cross(turn.xyz, original.xyz), turn.w * original.w - dot(turn.xyz, original.xyz)));
}`;
}

/** Stretch the longest axis and thin the others as the splat speeds up. */
function glslStreakScales(prefix) {
  return /* glsl */ `
vec3 ${prefix}StreakScales(vec3 scales, float weight, float size, float thickness) {
  float longest = max(scales.x, max(scales.y, scales.z));
  vec3 axis = scales.x == longest ? vec3(1.0, 0.0, 0.0) : scales.y == longest ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 target = mix(min(scales, vec3(longest * thickness)), vec3(longest), axis) * size;
  return mix(scales, target, clamp(weight, 0.0, 1.0));
}`;
}

// ------------------------------------------------------------------ strokes
/** Collects pointer segments (NDC) between frames; max 8, oldest merged. */
class StrokeAccumulator {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.last = 0;
    this.active = false;
    this.segments = [];
  }
  point(x, y, active, now) {
    if (![x, y, now].every(Number.isFinite)) return this.clear();
    if (active && this.active && now >= this.last && now - this.last < 120) {
      if ((x !== this.x || y !== this.y) && (this.segments.push({ ax: this.x, ay: this.y, bx: x, by: y }), this.segments.length > 8)) {
        const dropped = this.segments.shift();
        this.segments[0].ax = dropped.ax;
        this.segments[0].ay = dropped.ay;
      }
    } else if (now - this.last >= 120) {
      this.segments = [];
    }
    this.x = x;
    this.y = y;
    this.active = active;
    this.last = now;
  }
  /** Add a ready-made segment (blob trackers, OSC, WebSocket). Keeps the newest 8. */
  push(ax, ay, bx, by) {
    if (![ax, ay, bx, by].every(Number.isFinite) || (ax === bx && ay === by)) return;
    this.segments.push({ ax, ay, bx, by });
    if (this.segments.length > 8) this.segments.shift();
  }
  consume() {
    const s = this.segments;
    this.segments = [];
    return s;
  }
  clear() {
    this.active = false;
    this.segments = [];
  }
}

function response(sample, variation) {
  const r = Math.min(1, Math.max(0, sample)) ** 0.35;
  const v = Math.min(1, Math.max(0, variation));
  return {
    mass: 1 + (0.25 + 1.15 * r - 1) * v,
    tether: 1 + (0.2 + 1.05 * r - 1) * v,
    damping: 1 + (0.45 + 0.7 * r - 1) * v,
  };
}

// ------------------------------------------------------------------ simulation
/**
 * @param {THREE.WebGLRenderer} renderer
 */
export function createFlowSim(renderer) {
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    throw new Error("Floating-point render targets unavailable (EXT_color_buffer_float)");
  }

  let params = { ...FLOW_DEFAULTS };
  let rows = 1;
  let count = 0;
  let anchors = new THREE.DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1, THREE.RGBAFormat, THREE.FloatType);
  anchors.needsUpdate = true;
  const emptyMorph = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  emptyMorph.needsUpdate = true;
  /** @type {THREE.WebGLRenderTarget[]} */
  let targets = [];
  let current = 0;
  let time = 0;
  let settle = 0; // seconds of simulation left before sleeping
  const strokes = new StrokeAccumulator();

  // Shared uniform holders; the modifier reads these so swapping textures is free.
  const output = {
    offsets: { value: null },
    velocities: { value: null },
    alignments: { value: null },
  };

  const u = {
    anchors: { value: anchors },
    offsets: { value: null },
    velocities: { value: null },
    alignments: { value: null },
    dt: { value: 1 / 120 },
    time: { value: 0 },
    stiffness: { value: params.stiffness },
    damping: { value: params.damping },
    gain: { value: params.force },
    curl: { value: params.curl },
    limit: { value: params.limit },
    variation: { value: params.variation },
    maxSpeed: { value: 1.5 },
    strokeCount: { value: 0 },
    applySweep: { value: false },
    strokes: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    impulses: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
    viewport: { value: new THREE.Vector2(1, 1) },
    radius: { value: params.brushRadius },
    projectSim: { value: new THREE.Matrix4() },
    viewDir: { value: new THREE.Vector3(0, 0, 1) },
    alignDirect: { value: params.alignDirect },
    alignSpeed: { value: params.alignSpeed },
    alignFollow: { value: params.alignFollow },
    alignReturn: { value: params.alignReturn },
    // Morph (Chunk E): second rest buffer in sim space, xyz + per-splat delay in w.
    morphCenters: { value: emptyMorph },
    morphEnabled: { value: false },
    morphAmount: { value: 0 },
    morphAmountPrev: { value: 0 },
    morphStagger: { value: 0.6 },
    morphArc: { value: 0.12 },
    morphLag: { value: 0.85 },
    morphMoved: { value: false },
  };
  let lastMorphAmount = 0;

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    uniforms: u,
    vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D anchors, offsets, velocities, alignments;
      uniform float dt, time, stiffness, damping, gain, curl, limit, radius, variation, maxSpeed;
      uniform float alignSpeed, alignFollow, alignReturn;
      uniform vec2 viewport;
      uniform int strokeCount;
      uniform bool applySweep, alignDirect;
      uniform vec4 strokes[8];
      uniform vec3 impulses[8];
      uniform mat4 projectSim;
      uniform vec3 viewDir;
      uniform sampler2D morphCenters;
      uniform bool morphEnabled, morphMoved;
      uniform float morphAmount, morphAmountPrev, morphStagger, morphArc, morphLag;
      layout(location = 0) out vec4 outOffset;
      layout(location = 1) out vec4 outVelocity;
      layout(location = 2) out vec4 outAlignment;
      ${GLSL_SPRING}
      ${GLSL_RESPONSE}
      ${GLSL_SWEEP}
      ${GLSL_ALIGN_STEP}
      ${GLSL_MORPH}

      vec3 rotateAround(vec3 v, vec3 axis, float angle) {
        float c = cos(angle), s = sin(angle);
        return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
      }

      void main() {
        ivec2 coord = ivec2(gl_FragCoord.xy);
        vec4 home = texelFetch(anchors, coord, 0);
        vec3 p = texelFetch(offsets, coord, 0).xyz;
        vec3 v = texelFetch(velocities, coord, 0).xyz;
        vec3 alignment = texelFetch(alignments, coord, 0).xyz;
        if (home.a < 0.5) { outOffset = vec4(0.0); outVelocity = vec4(0.0); outAlignment = vec4(0.0); return; }

        vec3 traits = particleResponse((home.a - 0.5) * 2.0, variation);
        float mass = traits.x, localSpring = stiffness * traits.y, localDamping = damping * traits.z;

        // Morph: the rest position itself moves. Particles lag behind the moving
        // home (converted into an offset) and the spring carries them in.
        vec3 homeNow = home.xyz;
        if (morphEnabled) {
          vec4 target = texelFetch(morphCenters, coord, 0);
          int index = coord.y * ${WIDTH} + coord.x;
          homeNow = morphHome(home.xyz, target, index, morphAmount, morphStagger, morphArc);
          if (morphMoved) {
            vec3 homePrev = morphHome(home.xyz, target, index, morphAmountPrev, morphStagger, morphArc);
            p += (homePrev - homeNow) * morphLag;
          }
        }

        vec4 clip = projectSim * vec4(homeNow + p, 1.0);
        if (applySweep && clip.w > 0.0) {
          vec2 pixel = clip.xy / max(0.001, clip.w) * viewport * 0.5;
          for (int i = 0; i < 8; i++) {
            if (i >= strokeCount) break;
            vec2 a = strokes[i].xy * viewport * 0.5;
            vec2 b = strokes[i].zw * viewport * 0.5;
            float weight = sweepWeight(pixel, a, b, radius);
            vec3 force = impulses[i];
            // Swirl perpendicular to the stroke, in the view plane, varying per particle.
            vec3 flow = cross(force, viewDir) * sin(home.x * 17.0 + home.y * 23.0 + home.z * 11.0 + time * 0.5);
            // Impulse is the integrated cursor displacement, applied once per stroke.
            v += (force + flow * curl) * gain * weight / mass;
          }
        }

        // Coherent rotational drag bends moving particles without adding energy.
        float angle = curl * dt * (0.6 + 0.4 * sin(home.x * 14.0 + home.y * 9.0 + home.z * 6.0));
        v = rotateAround(v, viewDir, angle);
        float vlen = length(v);
        float vmax = maxSpeed / sqrt(mass);
        if (vlen > vmax) v *= vmax / vlen;

        vec2 sx = springStep(p.x, v.x, dt, localSpring, localDamping);
        vec2 sy = springStep(p.y, v.y, dt, localSpring, localDamping);
        vec2 sz = springStep(p.z, v.z, dt, localSpring, localDamping);
        p = vec3(sx.x, sy.x, sz.x);
        v = vec3(sx.y, sy.y, sz.y);

        float dist = length(p);
        if (dist > limit) { p *= limit / dist; v *= 0.5; }
        if (strokeCount == 0 && length(p) < 0.000002 && length(v) < 0.00001) { p = vec3(0.0); v = vec3(0.0); }

        alignment = alignmentStep(alignment, v, dt, alignSpeed, alignFollow, alignReturn, alignDirect);
        if (length(alignment) < 0.000001) alignment = vec3(0.0);

        outOffset = vec4(p, 0.0);
        outVelocity = vec4(v, 0.0);
        outAlignment = vec4(alignment, 0.0);
      }`,
  });

  // Fullscreen triangle.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function allocate(newRows) {
    for (const t of targets) t.dispose();
    targets = [0, 1].map(
      () =>
        new THREE.WebGLRenderTarget(WIDTH, newRows, {
          count: 3,
          type: THREE.FloatType,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          depthBuffer: false,
          stencilBuffer: false,
        }),
    );
    rows = newRows;
  }

  function publish() {
    const t = targets[current];
    output.offsets.value = t.textures[0];
    output.velocities.value = t.textures[1];
    output.alignments.value = t.textures[2];
  }

  function clear() {
    const prevTarget = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0, 0);
    for (const t of targets) {
      renderer.setRenderTarget(t);
      renderer.clear();
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    current = 0;
    settle = 0;
    strokes.clear();
    publish();
  }

  // Scratch
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const hitA = new THREE.Vector3();
  const hitB = new THREE.Vector3();
  const simOrigin = new THREE.Vector3();
  const simInverse = new THREE.Matrix4();
  const planeNormal = new THREE.Vector3();
  const ndc = new THREE.Vector2();

  allocate(1);
  clear();

  return {
    output,
    width: WIDTH,
    get rows() {
      return rows;
    },
    get params() {
      return params;
    },
    get awake() {
      return settle > 0;
    },

    /**
     * rest: Float32Array(count*4) in sim space: xyz position, w = 1 active / 0 skip.
     */
    setRest(rest, newCount) {
      count = newCount;
      const newRows = Math.max(1, Math.ceil(count / WIDTH));
      const data = new Float32Array(WIDTH * newRows * 4);
      data.set(rest.subarray(0, Math.min(rest.length, count * 4)));
      for (let i = 0; i < count; i++) {
        // Per-particle trait seed in alpha (0.5..1), 0 when the splat is inactive.
        let h = Math.imul(i + 1, 73244475);
        h = Math.imul(h ^ (h >>> 16), 73244475);
        const r = ((h ^ (h >>> 16)) >>> 0) / 4294967295;
        data[i * 4 + 3] = rest[i * 4 + 3] > 0.5 ? 0.5 + r * 0.5 : 0;
      }
      anchors.dispose();
      anchors = new THREE.DataTexture(data, WIDTH, newRows, THREE.RGBAFormat, THREE.FloatType);
      anchors.needsUpdate = true;
      u.anchors.value = anchors;
      if (newRows !== rows) allocate(newRows);
      clear();
    },

    configure(next) {
      const wasEnabled = params.enabled;
      params = { ...params, ...next };
      if (wasEnabled && !params.enabled) clear();
      u.stiffness.value = params.stiffness;
      u.damping.value = params.damping;
      u.gain.value = params.force;
      u.curl.value = params.curl;
      u.limit.value = params.limit;
      u.variation.value = params.variation;
      u.radius.value = params.brushRadius;
      u.alignDirect.value = params.alignDirect;
      u.alignSpeed.value = params.alignSpeed;
      u.alignFollow.value = params.alignFollow;
      u.alignReturn.value = params.alignReturn;
    },

    /**
     * Chunk E: second rest buffer. `texture` is a WIDTH x rows RGBA32F DataTexture
     * in sim space (xyz) with the per-splat delay in w; null disables the morph.
     */
    setMorph(texture) {
      u.morphCenters.value = texture ?? emptyMorph;
      u.morphEnabled.value = !!texture;
      lastMorphAmount = u.morphAmount.value;
    },
    configureMorph({ amount, stagger, arc, lag }) {
      if (amount !== undefined) u.morphAmount.value = amount;
      if (stagger !== undefined) u.morphStagger.value = stagger;
      if (arc !== undefined) u.morphArc.value = arc;
      if (lag !== undefined) u.morphLag.value = lag;
    },

    /** Pointer in NDC (-1..1). `active` false when the pointer left / lifted. */
    point(x, y, active) {
      strokes.point(x, y, active, performance.now());
    },
    /** A stroke segment in NDC from any other source (blob tracker, OSC, WebSocket). */
    stroke(ax, ay, bx, by) {
      strokes.push(ax, ay, bx, by);
    },
    release() {
      strokes.clear();
    },
    reset: clear,

    /**
     * Advance the simulation. Returns true when the output textures changed.
     * @param {number} dtSeconds
     * @param {THREE.Camera} camera
     * @param {THREE.Matrix4} simToWorld  sim space -> world
     * @param {number} viewportW  CSS px
     * @param {number} viewportH
     */
    step(dtSeconds, camera, simToWorld, viewportW, viewportH) {
      if (!params.enabled || count === 0) return false;
      const dt = Math.min(0.05, Math.max(0, dtSeconds));
      if (dt === 0) return false;

      const segments = strokes.consume();
      const morphMoved = u.morphEnabled.value && u.morphAmount.value !== lastMorphAmount;
      if (morphMoved) {
        u.morphAmountPrev.value = lastMorphAmount;
        lastMorphAmount = u.morphAmount.value;
        settle = Math.max(settle, 3);
      }
      if (segments.length) {
        // Wake up for long enough that the slowest spring has settled.
        const e = response(0, params.variation);
        const t = response(1, params.variation);
        const k = params.stiffness * e.tether;
        const c = params.damping * t.damping;
        const decay = Math.min((params.damping * e.damping) / 2, (c - Math.sqrt(Math.max(0, c * c - 4 * k))) / 2);
        settle = Math.max(4, 14 / Math.max(1e-3, decay), 14 / Math.max(1e-3, params.alignReturn));
      }
      if (settle <= 0) return false;
      settle -= dt;
      if (settle <= 0) {
        clear();
        return true;
      }

      camera.updateMatrixWorld();
      u.projectSim.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(simToWorld);
      u.viewport.value.set(Math.max(1, viewportW), Math.max(1, viewportH));
      simInverse.copy(simToWorld).invert();
      camera.getWorldDirection(planeNormal);
      u.viewDir.value.copy(planeNormal).transformDirection(simInverse).negate();
      u.strokeCount.value = 0;

      if (segments.length) {
        simOrigin.setFromMatrixPosition(simToWorld);
        plane.setFromNormalAndCoplanarPoint(planeNormal, simOrigin);
        for (const s of segments) {
          raycaster.setFromCamera(ndc.set(s.ax, s.ay), camera);
          if (!raycaster.ray.intersectPlane(plane, hitA)) continue;
          raycaster.setFromCamera(ndc.set(s.bx, s.by), camera);
          if (!raycaster.ray.intersectPlane(plane, hitB)) continue;
          hitA.applyMatrix4(simInverse);
          hitB.applyMatrix4(simInverse);
          const i = u.strokeCount.value++;
          u.strokes.value[i].set(s.ax, s.ay, s.bx, s.by);
          u.impulses.value[i].subVectors(hitB, hitA);
        }
      }

      const substeps = Math.min(2, Math.ceil(dt / (1 / 40)));
      u.dt.value = dt / substeps;
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      try {
        for (let i = 0; i < substeps; i++) {
          u.applySweep.value = i === 0;
          u.morphMoved.value = i === 0 && morphMoved;
          time += dt / substeps;
          u.time.value = time;
          const src = targets[current];
          u.offsets.value = src.textures[0];
          u.velocities.value = src.textures[1];
          u.alignments.value = src.textures[2];
          current = 1 - current;
          renderer.setRenderTarget(targets[current]);
          renderer.render(quad, ortho);
        }
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.autoClear = prevAutoClear;
      }
      publish();
      return true;
    },

    /** Debug: read one particle's offset back (slow, async). */
    async readOffset(index) {
      const out = new Float32Array(4);
      await renderer.readRenderTargetPixelsAsync(targets[current], index % WIDTH, Math.floor(index / WIDTH), 1, 1, out, undefined, 0);
      return out;
    },

    dispose() {
      material.dispose();
      geometry.dispose();
      anchors.dispose();
      for (const t of targets) t.dispose();
    },
  };
}

// ------------------------------------------------------------------ modifier
/**
 * Spark objectModifier that reads the simulation back into each splat.
 * @param {ReturnType<typeof createFlowSim>} sim
 */
export function createFlowModifier(sim) {
  const P = "flow";
  const uniforms = {
    flowOffsets: sim.output.offsets,
    flowVelocities: sim.output.velocities,
    flowAlignments: sim.output.alignments,
    flowToObject: { value: new THREE.Matrix3() },
    flowAlignment: { value: FLOW_DEFAULTS.alignment },
    flowAlignSpeed: { value: FLOW_DEFAULTS.alignSpeed },
    flowStreak: { value: new THREE.Vector3(FLOW_DEFAULTS.streakAmount, FLOW_DEFAULTS.streakSize, FLOW_DEFAULTS.streakThickness) },
    flowWidth: { value: sim.width },
  };

  const modifier = new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat },
    outTypes: { gsplat: dyno.Gsplat },
    generate: ({ inputs, outputs }) => ({
      uniforms,
      globals: [
        /* glsl */ `
        uniform sampler2D flowOffsets, flowVelocities, flowAlignments;
        uniform mat3 flowToObject;
        uniform float flowAlignment, flowAlignSpeed;
        uniform vec3 flowStreak;
        uniform int flowWidth;`,
        glslAlignRotation(P),
        glslStreakScales(P),
      ],
      statements: [
        `${outputs.gsplat} = ${inputs.gsplat};`,
        /* glsl */ `{
          ivec2 flowCoord = ivec2(${inputs.gsplat}.index % flowWidth, ${inputs.gsplat}.index / flowWidth);
          vec3 flowOffset = texelFetch(flowOffsets, flowCoord, 0).xyz;
          vec3 flowVelocity = texelFetch(flowVelocities, flowCoord, 0).xyz;
          vec3 flowAlign = texelFetch(flowAlignments, flowCoord, 0).xyz;
          ${outputs.gsplat}.center = ${inputs.gsplat}.center + flowToObject * flowOffset;
          ${outputs.gsplat}.quaternion = ${P}AlignRotation(${inputs.gsplat}.quaternion, ${inputs.gsplat}.scales,
                                                            flowToObject * flowAlign, length(flowAlign) * flowAlignment);
          float streakSpeed = smoothstep(0.0, flowAlignSpeed, length(flowVelocity));
          ${outputs.gsplat}.scales = ${P}StreakScales(${inputs.gsplat}.scales, streakSpeed * flowStreak.x, flowStreak.y, flowStreak.z);
        }`,
      ],
    }),
  });

  return {
    modifier,
    uniforms,
    /** sim space -> splat object space (mat3: rotation + scale part). */
    setToObject(matrix3) {
      uniforms.flowToObject.value.copy(matrix3);
    },
    configure(p) {
      uniforms.flowAlignment.value = p.alignment;
      uniforms.flowAlignSpeed.value = p.alignSpeed;
      uniforms.flowStreak.value.set(p.streakAmount, p.streakSize, p.streakThickness);
    },
  };
}
