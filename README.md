# ALTM — hay splat viewer

Web Gaussian-splat piece about hay. Reference and plan: [romanpillai-splat-breakdown.md](romanpillai-splat-breakdown.md).

**Chunks done**: A (procedural haystack splat), B (viewer + sway modifier), D (GPU spring simulation driven by pointer strokes), E (haystack <-> single stem morph), F (blob tracking: webcam in-browser, or TouchDesigner over WebSocket, see [touchdesigner/README.md](touchdesigner/README.md)), G (look pass: void backdrop, ring contours patched into Spark's shader, plexus scan overlay that follows the sim, HUD measurement lines, grain and vignette).

Moodboard: [reference/moodboard.webp](reference/moodboard.webp).

**Live site**: https://jaspan-eng.github.io/ALTM/ — built and deployed by [.github/workflows/pages.yml](.github/workflows/pages.yml) on every push to `main`.

```bash
npm install
npm run dev
```

Open http://localhost:5173. It loads Spark's sample butterfly until you have a haystack splat.

## Using your own splat

- Drag a `.spz`, `.ply`, `.splat` or `.ksplat` onto the window, or
- copy it to `public/splats/` and open `http://localhost:5173/?splat=/splats/haystack.spz`, or
- change `DEFAULT_SPLAT` in `src/main.js`.

The viewer centres the splat and scales its widest axis to 1 unit, same as the reference's placement step.
Splat files are git-ignored.

## Files

| file | role |
|---|---|
| `src/main.js` | renderer, camera, SparkRenderer, splat sources, placement, rest buffer, pointer strokes, GUI, frame loop |
| `src/haystack.js` | procedural haystack: strands as chains of thin elongated Gaussians pushed via `constructSplats` |
| `src/flow.js` | GPU spring simulation (anchors texture, MRT ping-pong, closed-form `springStep`, stroke impulses) and the `objectModifier` that reads it back with velocity alignment + streaking |
| `src/sway.js` | `objectModifier` dyno (raw GLSL): height-masked sway + tilt of the long axis |
| `src/morph.js` | stem targets (centre + delay, rotation, scale, colour textures, one texel per splat) and the morph `objectModifier`; the sim reads the same morphed home and lags behind it |
| `src/blobs.js` | blob tracking layer: webcam tracker (background model, threshold, connected components, id matching), WebSocket input, `feed()` for scripts, debug overlay |
| `src/rings.js` | ring contour + grade patched into Spark's splat vertex/fragment shaders (guarded string replacement, like the reference) |
| `src/plexus.js` | scan overlay: sampled dots + links that read the sim offsets and morph home in the vertex shader, links fade when stretched |
| `src/look.js` | DOM grain (animated SVG turbulence) and vignette, HUD canvas: projected bounding box with corner brackets, dimension lines, pointer crosshair, readout |

Open `?splat=/splats/file.spz` to load a real capture; the GUI "source" switches between the procedural haystack and Spark's butterfly sample.

## Roadmap

- **C** wind as a real noise field, direction control
- Real haystack capture (photos -> 3DGS -> `.spz`) dropped into `public/splats/`
- Click-to-enter intro wave and progressive preview, as in the reference
- Installation build: fullscreen, no GUI, blob source from TouchDesigner
