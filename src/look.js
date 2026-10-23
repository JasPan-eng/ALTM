/**
 * Chunk G: void backdrop, film grain, vignette and the HUD measurement layer.
 *
 * Grain and vignette are DOM layers (an animated SVG feTurbulence tile and a
 * radial gradient), exactly how the reference does it: no extra WebGL pass,
 * zero cost on the splat renderer. The HUD is a 2D canvas drawn each frame:
 * the splat's bounding box projected to the screen with corner brackets,
 * dimension lines with tick marks and labels, a crosshair at the pointer,
 * and a small readout. Styles live in index.html (.look-*, #hud).
 */
import * as THREE from "three";

export const LOOK_DEFAULTS = {
  background: "#07080a",
  floor: true,
  floorOpacity: 0.35,
  grain: true,
  grainOpacity: 0.18,
  grainSize: 1.9, // tile scale, px per noise texel
  vignette: true,
  vignetteAmount: 0.55,
  vignetteStart: 55, // %
  hud: true,
  hudColor: "#7ac8ff",
  hudOpacity: 0.85,
  title: "ALTM / HAY SCAN 01",
};

const GRAIN_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`,
  );

export function createLook(container) {
  let p = { ...LOOK_DEFAULTS };

  const grain = document.createElement("div");
  grain.className = "look-grain";
  grain.style.backgroundImage = `url("${GRAIN_SVG}")`;
  const vignette = document.createElement("div");
  vignette.className = "look-vignette";
  const hud = document.createElement("canvas");
  hud.id = "hud";
  container.append(grain, vignette, hud);
  const ctx = hud.getContext("2d");

  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  const tmp = new THREE.Vector3();

  function apply() {
    grain.style.display = p.grain ? "block" : "none";
    grain.style.opacity = String(p.grainOpacity);
    grain.style.backgroundSize = `${128 * p.grainSize}px ${128 * p.grainSize}px`;
    vignette.style.display = p.vignette ? "block" : "none";
    vignette.style.setProperty("--vignette-amount", String(p.vignetteAmount));
    vignette.style.setProperty("--vignette-start", `${p.vignetteStart}%`);
    hud.style.display = p.hud ? "block" : "none";
    hud.style.opacity = String(p.hudOpacity);
  }
  apply();

  function resize(w, h, dpr) {
    hud.width = Math.round(w * dpr);
    hud.height = Math.round(h * dpr);
    hud.style.width = `${w}px`;
    hud.style.height = `${h}px`;
  }

  /**
   * @param {{ camera: THREE.Camera, box: THREE.Box3 | null, simToWorld: THREE.Matrix4, pointer: THREE.Vector2 | null,
   *           size: {width:number,height:number}, dpr: number, info: Record<string, string> }} f
   */
  function update(f) {
    if (!p.hud) return;
    const { width: W, height: H } = f.size;
    if (hud.width !== Math.round(W * f.dpr) || hud.height !== Math.round(H * f.dpr)) resize(W, H, f.dpr);
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = p.hudColor;
    ctx.fillStyle = p.hudColor;
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    ctx.textBaseline = "middle";

    // ---- readout (top-left)
    const lines = [p.title, ...Object.entries(f.info).map(([k, v]) => `${k.padEnd(8, " ")} ${v}`)];
    lines.forEach((t, i) => ctx.fillText(t, 18, 22 + i * 14));
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(18, 14); ctx.lineTo(18 + 120, 14); ctx.stroke();
    ctx.globalAlpha = 1;

    // ---- bounding box of the splat, projected
    if (f.box && !f.box.isEmpty()) {
      const b = f.box;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let behind = false;
      for (let i = 0; i < 8; i++) {
        tmp.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(f.simToWorld).project(f.camera);
        if (tmp.z > 1) behind = true;
        const sx = (tmp.x * 0.5 + 0.5) * W;
        const sy = (0.5 - tmp.y * 0.5) * H;
        corners[i].set(sx, sy, tmp.z);
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      if (!behind) {
        const pad = 14;
        minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        const L = Math.min(22, (maxX - minX) * 0.2);
        // corner brackets
        ctx.globalAlpha = 0.9;
        for (const [x, y, dx, dy] of [[minX, minY, 1, 1], [maxX, minY, -1, 1], [minX, maxY, 1, -1], [maxX, maxY, -1, -1]]) {
          ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke();
        }
        // faint full box
        ctx.globalAlpha = 0.18;
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
        // dimension line (top) with ticks + label
        ctx.globalAlpha = 0.8;
        const dy = minY - 18;
        ctx.beginPath(); ctx.moveTo(minX, dy); ctx.lineTo(maxX, dy); ctx.stroke();
        for (const x of [minX, maxX]) { ctx.beginPath(); ctx.moveTo(x, dy - 5); ctx.lineTo(x, dy + 5); ctx.stroke(); }
        const size = b.getSize(tmp);
        ctx.textAlign = "center";
        ctx.fillText(`W ${size.x.toFixed(3)} u`, (minX + maxX) / 2, dy - 9);
        // dimension line (right) for height
        const dx = maxX + 18;
        ctx.beginPath(); ctx.moveTo(dx, minY); ctx.lineTo(dx, maxY); ctx.stroke();
        for (const y of [minY, maxY]) { ctx.beginPath(); ctx.moveTo(dx - 5, y); ctx.lineTo(dx + 5, y); ctx.stroke(); }
        ctx.save();
        ctx.translate(dx + 10, (minY + maxY) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`H ${size.y.toFixed(3)} u`, 0, 0);
        ctx.restore();
        ctx.textAlign = "left";
        // projected 3D box edges (wireframe), very faint
        ctx.globalAlpha = 0.14;
        const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
        ctx.beginPath();
        for (const [i, j] of edges) { ctx.moveTo(corners[i].x, corners[i].y); ctx.lineTo(corners[j].x, corners[j].y); }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // ---- pointer crosshair
    if (f.pointer) {
      const px = (f.pointer.x * 0.5 + 0.5) * W;
      const py = (0.5 - f.pointer.y * 0.5) * H;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(px - 14, py); ctx.lineTo(px - 4, py); ctx.moveTo(px + 4, py); ctx.lineTo(px + 14, py);
      ctx.moveTo(px, py - 14); ctx.lineTo(px, py - 4); ctx.moveTo(px, py + 4); ctx.lineTo(px, py + 14);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.fillText(`${f.pointer.x.toFixed(3)}  ${f.pointer.y.toFixed(3)}`, px + 18, py + 12);
      ctx.globalAlpha = 1;
    }

    // ---- edge ticks (ruler feel)
    ctx.globalAlpha = 0.25;
    for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, H - (x % 200 === 0 ? 10 : 5)); ctx.stroke(); }
    for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(y % 200 === 0 ? 10 : 5, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }

  return {
    get params() {
      return p;
    },
    configure(next) {
      p = { ...p, ...next };
      apply();
    },
    update,
    dispose() {
      grain.remove();
      vignette.remove();
      hud.remove();
    },
  };
}
