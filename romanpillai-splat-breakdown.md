# How romanpillai.art's Gaussian splat scene works

Reverse-engineered from the live site on 2026-10-23. Source files I pulled are in
`C:\Users\hi\AppData\Local\Temp\claude\E--ALTM\2ad3278a-21fc-4fcc-b6d2-7802ee83d092\scratchpad\site\`
(`scene-pretty.js` is the prettified scene chunk; line numbers below refer to it).

---

## 0. The stack (one paragraph)

- **Framework**: a Next.js App Router style app (React Server Components, `(portfolio)` route group,
  `/work/[slug]`, `/play`, `/resources`, `/exhibitions`) built with **vinext** (Cloudflare's
  Vite + Rolldown implementation of Next.js). Served on **Cloudflare** (Workers/Pages), video on
  `media.romanpillai.art`.
- **Styling**: Tailwind v4 utilities + hand-written CSS; **Geist** and **Geist Mono** variable fonts.
- **Animation**: **GSAP** for DOM/UI, CSS custom properties for the rise/stagger reveals.
- **3D**: **Three.js r186** + **Spark** (World Labs' Gaussian splat renderer for Three.js,
  `sparkjs.dev`), lazy-loaded as a separate 880 KB chunk (`scene-*.js`) plus a 5 MB `spark.module`
  chunk only after the page is interactive.
- **Workers**: `depth-cloud-prepare.worker` (decodes 16-bit depth PNGs into point clouds for
  project-page "depth cloud" hero images) and `paint-clearance.worker`.
- **Progressive loading**: an 85 KB custom `.bin` preview arrives first and drives the intro,
  the 3.4 MB `.spz` splat arrives behind it.
- **Post**: film grain, vignette and a sharpen pass on top of the WebGL canvas.

Everything below is about the hero splat ("the logo" in the code; the uniform prefix is `roman*`).

---

## 1. Assets and loading (lines 25863, 34134, 34392, 34623)

| File | Size | Role |
|---|---|---|
| `/splats/roman-pillai.spz` | 3.4 MB | The real splat (Niantic SPZ format, Spark loads it natively) |
| `/splats/roman-pillai-preview.bin` | 85 KB | Custom preview: sampled splat centres + colours |
| `/textures/fine-paper-grain.webp` | small | Paper texture for the paint layer |
| `/models/john-the-baptist.glb` | - | Secondary mesh used elsewhere in the scene |

**Preview `.bin` format** (`cv()` at 34134): magic uint32, version uint16, `splatCount` uint32,
`pointCount` uint32, then 16 floats (bounds min/max, placement center, scale), then per point:
uint32 splat index, 3 x uint16 quantised position inside the bounds, 3 x uint8 colour. It is
generated offline by `npm run splat:preview`. It exists so that:

1. The plexus intro (point network) can start before the big file lands.
2. The GPU particle buffers can be allocated at the right size (`splatCount`) immediately.
3. The placement (rotation + centre + 1/width scale) is known without parsing the splat.

Loading order (`le()` at 34615): fetch preview with streamed progress -> build particle system +
plexus from it -> `import('./spark.module')` in parallel with the `.spz` fetch -> build
`SplatMesh` -> verify preview still matches the splat (otherwise warn and recompute) -> swap the
splat into the same particle buffers (`flow.setRest`) so nothing resets.

---

## 2. Spark setup (line 34423, 34638)

```js
const mesh = new SplatMesh({ fileBytes, fileName, raycastable: false, lod: false });
await mesh.initialized;
mesh.forEachSplat((i, center, scales, quat, opacity, color) => { ... }) // builds rest buffer + samples

const spark = new SparkRenderer({
  renderer, autoUpdate: false, sortRadial: false,
  depthTest: true, depthWrite: false, encodeLinear: false,
});
spark.update({ scene, camera }) // called manually, only when the view changes
```

Two Spark features carry the whole effect:

- **`mesh.objectModifier`** - a `dyno.Dyno` (Spark's GLSL node graph) that runs **per splat on the
  GPU** every time Spark re-sorts/updates. It receives the `Gsplat` struct (`center`, `scales`,
  `quaternion`, `rgba`, `index`) and emits a modified one. This is where position offsets,
  rotation alignment, streaking and entry fades happen (34558).
- **Patching Spark's own vertex/fragment shader** (`Af()` 26030, `Mf()` 26143). They take
  `spark.material.vertexShader`, do `string.replace()` on known lines (with a guard that throws if
  the Spark version changed), inject extra uniforms and code, then
  `Object.assign(spark.material, { vertexShader, fragmentShader })` and merge their uniforms into
  `spark.material.uniforms`. This gives screen-space effects that a per-splat modifier cannot do.

---

## 3. The reactive core: a GPGPU spring simulation (`Wf()` at 26393)

This is the reason it feels alive. Every splat is a particle on a damped spring tethered to its
rest position. The simulation runs entirely on the GPU in two textures.

**Data layout**

- `anchors` texture: 512 x N `RGBA32F`. RGB = rest position (object space, pre-rotated and
  normalised to logo width 1). A = 0 if the splat is nearly transparent (skip), otherwise
  0.5 + 0.5 * hash(index) -> a per-particle "trait" seed.
- Two ping-pong `WebGLRenderTarget`s with **2 colour attachments each** (MRT):
  `offsets` (xyz = displacement from rest, w = alignment.x) and
  `velocities` (xyz = velocity, w = alignment.y).
- One fullscreen triangle, one fragment shader, each fragment = one splat (`index % 512`,
  `index / 512`).

**Per-step fragment shader (summarised)**

```glsl
home   = texelFetch(anchors)         // rest + trait
p, v   = texelFetch(offsets/velocities)
traits = particleResponse(home.a)    // mass, stiffness, damping vary per particle (variation 0.8)

// 1. Pointer forces. Up to 8 stroke segments per frame, in NDC, with a 3D impulse each.
clip  = projectLogo * (home + p)     // where this splat is on screen
for each stroke: w = sweepWeight(pixel, a, b, radius)   // capsule falloff around the segment
                 v += (impulse + curl * perpendicular * sin(noise)) * gain * w / mass

// 2. Coherent curl drag, speed clamp (1.5 / sqrt(mass))
// 3. Closed-form damped spring per axis: springStep(x, v, dt, k, c)  -> stable at any dt
// 4. Clamp displacement radius to `limit` (0.18 of logo width), halve velocity on hit
// 5. alignmentStep(): remembers the 2D direction of travel with follow/return rates
outOffset   = vec4(p, alignment.x);
outVelocity = vec4(v, alignment.y);
```

**Pointer -> impulse** (`step()` at 26566): pointer segments from the last frame are consumed
(max 8, merged if more). Each segment's two NDC endpoints are ray-cast onto the plane of the logo
(normal = logo forward), converted to logo-local space, and `impulse = end - start` (i.e. the
cursor's displacement in scene units, so faster = stronger). `strokes[i]` keeps the NDC segment
for the screen-space falloff test, `impulses[i]` the 3D push.

**Timing**: dt clamped to 50 ms, up to 2 substeps at 40 Hz, `applySweep` only on the first
substep so an impulse is applied once. The sim has a **settle timer** (`m`): after the last stroke
it runs for roughly `max(4, 14 / decayRate)` seconds then clears both targets to zero and stops
rendering. Nothing runs when the splat is at rest.

**Defaults** (from the tuning object in `site-*.js`):

```
flowForce 3   flowReturn 14 (stiffness)   flowDamping 5.5   flowCurl 0.8
flowLimit 0.18   flowVariation 0.8   brushRadius 150 px
flowAlignSpeed 0.25   flowAlignFollow 12   flowAlignReturn 4
flowStreakAmount 1   flowStreakThickness 0.08   flowStreakSize 0.5   flowAlignment 0.7
```

---

## 4. Reading the simulation back into the splats (dyno modifier, line 34540)

Inside `objectModifier`, for each splat:

```glsl
ivec2 c = ivec2(IN.index % 512, IN.index / 512);
vec4 off = texelFetch(Offsets, c, 0), vel = texelFetch(Velocity, c, 0);
OUT.center += ToObject * off.xyz;                 // displaced position
vec2 align = vec2(off.w, vel.w);
OUT.quaternion = AlignRotation(IN.quaternion, IN.scales, ToObject * vec3(align, 0),
                               length(align) * Alignment);  // slerp longest axis toward travel dir
float s = smoothstep(0, AlignSpeed, length(vel.xyz));
OUT.scales = StreakScales(IN.scales, s * Streak.x, Streak.y, Streak.z);  // stretch into streaks
```

`AlignRotation` (26272) finds the splat's longest axis, builds the shortest-arc quaternion from that
axis to the velocity direction and slerps toward it. `StreakScales` (26290) lengthens the long axis
and thins the others. So moving splats become oriented brush strokes, resting ones snap back to
their photographed shape. This is the "painterly" feel.

The same modifier also applies **entry effects** (section 6).

---

## 5. Screen-space brush, rings and grade (Spark shader patches)

**Vertex patch** (`Af()`, 26030) runs after Spark has computed each splat's 2D ellipse:

- `brushWeight = (1 - smoothstep(0, radius, dist(splatNDC, pointerNDC))) * active * motion`
- `scale1, scale2 *= mix(1, brushScale(3), brushWeight)` -> splats near the cursor swell.
- `ndcOffset += dir * brushSpread(20 px) * brushWeight` -> they get pushed outward **in screen XY
  only**, so depth and sort order remain valid (comment in the source says exactly this).
- `romanBrushMotion` is pointer speed mapped through `s / (s + 1.5)` and smoothed; a still cursor
  does nothing, a sweep does a lot. `romanBrushPointer` is lerped (`1 - exp(-12 dt)`) so it lags.

**Fragment patch** (`Mf()`, 26143): draws a thin **ring** at radius 0.76 sigma of each Gaussian
(`ringAmount 0.44`, colour `#68340e` mixed 0.65), masked where the ellipse is too stretched, then a
saturation/brightness/contrast grade. This gives the sketched contour look of the logo.

**Smear trail** (`Df`, 25962): last 128 pointer samples resampled into **16 nodes** along the path
(length 160 px, lifetime 0.35 s, width 48 px tapering with `(1 - age)^1.5`), uploaded as
`romanSmearNodes[16]`. A GLSL `romanSmearDistance(ndc)` computes a capsule-chain SDF for the
centroid dot layer.

**Parallax**: pointer position nudges camera yaw 14 deg / pitch 9 deg with ease 5. Wheel nudges too.

---

## 6. Intro ("entry") state machine

`main[data-entry]` goes `waiting -> (click) -> wave -> ready`. Modes in the modifier:

| mode | effect |
|---|---|
| 0 | radial reveal around a seed point |
| 1 | dissolve by noise and progress |
| 2 | depth sweep: a plane moves through the splat, splats lift along their normal and stretch as it passes |
| 3 | **wave** (the one you see): click seeds a ripple; splats lift `introLift` along their thin-axis normal, tangent axes stretch `introStretch`, alpha follows the wave front |

**Click handling** (`prepareClick`, 34664): projects ~N sampled splat centres to screen, finds the
nearest to the click within 32 px (48 on mobile), returns `{ seed, radius }`. The wave then
expands from that exact splat.

**Plexus** (`ev()`, 33831): a `Points` network from the preview samples, each with a staggered
`born()` time, drawn as dots with expanding radar rings; connected by lines where the wave has
passed. It reads the **same** offsets/velocity textures as the splat, so the dots and the splat
move together during the handover from preview to full splat.

---

## 7. Paint layer and post (`U_()`, 33123)

A 2048 x 2048 render target acts as a canvas. "Pigment" emitters launch droplets from splat samples
(throw min/max, scatter, bridge/micro counts, smear length), composited with the paper grain. Mostly
cosmetic and heavily tunable (`paint*` keys). Post: `postSharpen 0.35`, `postGrain 0.035`,
`postVignette 0.12`, `maxPixelRatio 1.6`.

---

## 8. Why it feels so reactive (the checklist to copy)

1. **Simulation on the GPU, one fragment per splat**, no CPU loop, no attribute uploads.
2. **Closed-form spring** (`springStep`) is unconditionally stable, so there is no jitter at low
   frame rates and no need for tiny substeps.
3. **Impulses are cursor displacement in scene units**, so the force scales with your speed and the
   effect is proportional, not binary.
4. **Per-particle variation** (mass/stiffness/damping from a hash) makes the cloud breathe instead
   of moving as a block.
5. **Orientation follows velocity** and **scale streaks with speed**: a Gaussian splat is an
   oriented ellipsoid, so you get free motion blur / brush strokes just by rotating and stretching.
6. **Two layers of response**: a slow physical one (3D springs) and an instant screen-space one
   (swell + push + smear) so there is feedback on the very first frame of movement.
7. **Everything smooths with `1 - exp(-k dt)`**, never linear lerps, so it is frame-rate independent.
8. **The sim sleeps** when settled and the renderer is invalidation-driven, so idle cost is zero.
9. **Progressive assets** so the first interaction can happen within a second.

---

## 9. Plan for the hay project

### Chunk A - Produce the splats

- **Haystack**: capture a real one (150-300 photos, overcast light) and train with
  Postshot / Nerfstudio `gsplat` / Luma; export `.ply`, convert to `.spz` (Niantic `spz` tool, or
  let Spark load `.ply` directly while prototyping). Target 300k-1M splats for web.
- **Individual hay strand**: two options.
  - *Synthetic splat from a mesh*: Spark lets you build splats from arrays
    (`new SplatMesh({ constructSplats: (splats) => splats.pushSplat(center, scales, quat, opacity, color) })`).
    Hay is almost the ideal case: a strand is a chain of thin anisotropic Gaussians. You can scatter
    those along curves exported from Houdini/C4D (point + tangent + width per point) and emit a splat
    per point. Fully procedural, tiny files, and you control index order (useful for Chunk E).
  - *Trained from renders*: render a strand turntable from C4D/Redshift and train it like a photo
    capture. Heavier and less controllable; only if the look needs the photographic grain.

### Chunk B - Minimal viewer (1 day)

Three.js + Spark + OrbitControls, load the haystack, confirm `objectModifier` works with a
trivial time-based sway. This is the "hello world" that proves the pipeline.

### Chunk C - Wind in the modifier (no sim yet)

In `objectModifier`: `OUT.center += noise(home * f + time) * amplitude * heightMask`, and rotate the
splat's long axis toward the displacement derivative. Already reads as wind. Gives you the dyno
mental model before adding GPGPU.

### Chunk D - Port the spring sim (the core of section 3)

Reimplement `Wf()`: anchors texture, MRT ping-pong, fullscreen pass, `springStep`, strokes +
impulses from pointer segments ray-cast onto a plane through the stack. Hook `offsets`/`velocities`
into the modifier with `AlignRotation` + `StreakScales`. Hay will scatter under the cursor and fall
back. Expose the same tuning keys (`flowForce`, `flowReturn`, `flowDamping`, `flowCurl`,
`flowLimit`, `flowVariation`) in a lil-gui panel.

### Chunk E - Haystack <-> single strand transform

Two rest buffers (A = haystack positions, B = strand positions, same splat count by sampling the
larger set) plus a `morph` uniform. In the modifier: `home = mix(restA[i], restB[i], ease(morph +
perSplatDelay))`, with scales/colour mixed too. The spring sim keeps running on top of the moving
rest position, so the transformation is interruptible and still reactive. Index order from Chunk A
decides what the mid-morph looks like (sort both sets along a shared axis for a "pour" effect).

### Chunk F - Blob tracking input

Both the brush and the sim already consume a small, generic interface: **up to 8 segments
`(a.xy, b.xy)` in NDC plus a radius**. A tracked blob is exactly that: its centroid now vs last
frame, its bounding size as radius.

- *Installation route*: TouchDesigner `Blob Track TOP` -> `Blob Track CHOP` (x, y, size, id) ->
  `WebSocket DAT` or OSC -> small Node bridge -> browser WebSocket -> push into `strokes[]`.
  Normalise to NDC in TD so the web side never knows about camera resolution.
- *Shipping-on-the-web route*: MediaPipe Hands/Pose or a webcam difference-blob detector in a Web
  Worker, same output shape. Prototype in TD first because it is faster to see what the data looks
  like, then port the thresholds.

### Chunk G - Polish copied from the reference

Progressive preview file, click-to-enter wave, screen-space swell/push, ring contours, sleep when
settled, `maxPixelRatio` cap, post grain/vignette.

### Tools

Three.js r186+, Spark (`@sparkjsdev/spark`), Vite (or the same vinext/Next setup), lil-gui for
tuning, Postshot or Nerfstudio for training, Niantic `spz`, TouchDesigner for blob tracking,
Houdini/C4D for strand curves.
