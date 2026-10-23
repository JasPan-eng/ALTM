/**
 * Chunk F: blob tracking input.
 *
 * Two sources, one output. Both produce a list of blobs in NDC (-1..1) with
 * stable ids; the layer turns each blob's movement since the last frame into
 * a stroke segment, which the viewer feeds to `flow.stroke()`. The spring
 * simulation then treats a moving hand or body exactly like a moving cursor.
 *
 *   webcam     in-browser tracker: downscaled frame -> running-average
 *              background model -> threshold -> connected components ->
 *              centroids -> nearest-neighbour id matching.
 *   websocket  JSON from TouchDesigner (or anything else), see
 *              touchdesigner/README.md. Shape: { "blobs": [{ "id": 1, "x": 0.4,
 *              "y": 0.6, "size": 0.05 }, ...] } with x/y in 0..1, origin
 *              top-left (TouchDesigner's Blob Track convention).
 *
 * A small debug overlay (mask + boxes + trails) is drawn in the corner.
 */

export const BLOB_DEFAULTS = {
  source: "none", // none | webcam | websocket
  threshold: 28, // 0..255 difference from the background model
  learning: 0.02, // background adaptation per frame (0 = frozen)
  minArea: 6, // grid cells
  maxBlobs: 8,
  mirror: true, // webcam acts like a mirror
  smoothing: 0.5, // 0 = raw, 0.9 = very smooth
  debug: true,
  wsUrl: "ws://localhost:9980",
  gridW: 96,
  gridH: 54,
};

export function createBlobLayer(container, initial = BLOB_DEFAULTS) {
  let s = { ...BLOB_DEFAULTS, ...initial };
  let source = "none";
  let status = "off";

  /** @type {{id:number,x:number,y:number,size:number,px?:number,py?:number,emitted?:boolean}[]} */
  let blobs = [];
  let nextId = 1;
  const pending = []; // segments waiting for the next frame

  // ------------------------------------------------------------ debug overlay
  const overlay = document.createElement("canvas");
  overlay.width = 288;
  overlay.height = 162;
  Object.assign(overlay.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    width: "288px",
    height: "162px",
    border: "1px solid rgba(120, 200, 255, 0.35)",
    background: "rgba(10, 12, 16, 0.85)",
    imageRendering: "pixelated",
    pointerEvents: "none",
    display: "none",
  });
  container.appendChild(overlay);
  const octx = overlay.getContext("2d");
  const trails = new Map(); // id -> [{x,y}]

  function drawOverlay(mask) {
    if (!s.debug || source === "none") {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "block";
    const W = overlay.width;
    const H = overlay.height;
    octx.clearRect(0, 0, W, H);
    if (mask) {
      const img = octx.createImageData(s.gridW, s.gridH);
      for (let i = 0; i < mask.length; i++) {
        const v = mask[i] ? 70 : 0;
        img.data[i * 4] = v * 0.6;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v * 1.3;
        img.data[i * 4 + 3] = 255;
      }
      const tmp = document.createElement("canvas");
      tmp.width = s.gridW;
      tmp.height = s.gridH;
      tmp.getContext("2d").putImageData(img, 0, 0);
      octx.drawImage(tmp, 0, 0, W, H);
    }
    // grid
    octx.strokeStyle = "rgba(120,200,255,0.12)";
    octx.lineWidth = 1;
    for (let x = 0; x <= W; x += W / 8) { octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, H); octx.stroke(); }
    for (let y = 0; y <= H; y += H / 4) { octx.beginPath(); octx.moveTo(0, y); octx.lineTo(W, y); octx.stroke(); }
    // blobs: NDC -> overlay px
    const toPx = (x, y) => [((x + 1) * 0.5) * W, ((1 - y) * 0.5) * H];
    octx.font = "9px ui-monospace, monospace";
    for (const b of blobs) {
      const [cx, cy] = toPx(b.x, b.y);
      const r = Math.max(4, b.size * W * 0.5);
      octx.strokeStyle = "rgba(120,200,255,0.9)";
      octx.strokeRect(cx - r, cy - r, r * 2, r * 2);
      octx.beginPath(); octx.moveTo(cx - r - 4, cy); octx.lineTo(cx + r + 4, cy); octx.stroke();
      octx.beginPath(); octx.moveTo(cx, cy - r - 4); octx.lineTo(cx, cy + r + 4); octx.stroke();
      octx.fillStyle = "rgba(120,200,255,0.9)";
      octx.fillText(`#${b.id}`, cx + r + 3, cy - r - 2);
      const tr = trails.get(b.id);
      if (tr && tr.length > 1) {
        octx.strokeStyle = "rgba(255,196,90,0.8)";
        octx.beginPath();
        tr.forEach((p, i) => { const [px, py] = toPx(p.x, p.y); i ? octx.lineTo(px, py) : octx.moveTo(px, py); });
        octx.stroke();
      }
    }
    octx.fillStyle = "rgba(232,228,220,0.8)";
    octx.fillText(`${source} · ${status} · ${blobs.length} blob${blobs.length === 1 ? "" : "s"}`, 4, H - 4);
  }

  // ------------------------------------------------------------ tracking core
  /** Match new centroids to existing blobs by nearest neighbour, keep ids, smooth, queue segments. */
  function ingest(detections) {
    const prev = blobs;
    const used = new Set();
    const next = [];
    for (const d of detections) {
      let best = null;
      let bestDist = 0.3; // NDC
      for (const p of prev) {
        if (used.has(p.id)) continue;
        const dist = Math.hypot(p.x - d.x, p.y - d.y);
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      if (best) {
        used.add(best.id);
        const k = 1 - s.smoothing;
        const x = best.x + (d.x - best.x) * k;
        const y = best.y + (d.y - best.y) * k;
        if (x !== best.x || y !== best.y) pending.push({ ax: best.x, ay: best.y, bx: x, by: y });
        next.push({ id: best.id, x, y, size: d.size });
        const tr = trails.get(best.id) ?? [];
        tr.push({ x, y });
        if (tr.length > 24) tr.shift();
        trails.set(best.id, tr);
      } else {
        const id = nextId++;
        next.push({ id, x: d.x, y: d.y, size: d.size });
        trails.set(id, [{ x: d.x, y: d.y }]);
      }
    }
    for (const p of prev) if (!used.has(p.id)) trails.delete(p.id);
    blobs = next;
    while (pending.length > 8) pending.shift();
  }

  // ------------------------------------------------------------ webcam source
  let video = null;
  let stream = null;
  let grid = null;
  let gctx = null;
  let background = null;
  let mask = null;
  let rafId = 0;
  let lastFrame = -1;

  async function startWebcam() {
    status = "requesting camera";
    drawOverlay(null);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" }, audio: false });
    } catch (err) {
      status = `camera failed: ${err?.name ?? err}`;
      console.warn("Blob tracking: camera unavailable", err);
      drawOverlay(null);
      return;
    }
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    grid = document.createElement("canvas");
    grid.width = s.gridW;
    grid.height = s.gridH;
    gctx = grid.getContext("2d", { willReadFrequently: true });
    background = null;
    status = "tracking";
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      if (video.readyState < 2 || video.currentTime === lastFrame) return;
      lastFrame = video.currentTime;
      processFrame();
    };
    loop();
  }

  function stopWebcam() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video = null;
    background = null;
    mask = null;
  }

  function processFrame() {
    const W = s.gridW;
    const H = s.gridH;
    if (grid.width !== W || grid.height !== H) { grid.width = W; grid.height = H; background = null; }
    gctx.save();
    if (s.mirror) { gctx.translate(W, 0); gctx.scale(-1, 1); }
    gctx.drawImage(video, 0, 0, W, H);
    gctx.restore();
    const px = gctx.getImageData(0, 0, W, H).data;
    const n = W * H;
    if (!background || background.length !== n) {
      background = new Float32Array(n);
      for (let i = 0; i < n; i++) background[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
      mask = new Uint8Array(n);
      return;
    }
    if (!mask || mask.length !== n) mask = new Uint8Array(n);
    const thr = s.threshold;
    const lr = s.learning;
    for (let i = 0; i < n; i++) {
      const g = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
      const fg = Math.abs(g - background[i]) > thr;
      mask[i] = fg ? 1 : 0;
      // adapt slowly everywhere, faster where nothing moves
      background[i] += (g - background[i]) * (fg ? lr * 0.25 : lr);
    }
    // connected components (4-neighbour), iterative flood fill
    const label = new Int32Array(n);
    const stack = new Int32Array(n);
    const found = [];
    let current = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i] || label[i]) continue;
      current++;
      let sp = 0;
      stack[sp++] = i;
      label[i] = current;
      let area = 0, sx = 0, sy = 0, minx = W, miny = H, maxx = 0, maxy = 0;
      while (sp) {
        const j = stack[--sp];
        const x = j % W;
        const y = (j - x) / W;
        area++; sx += x; sy += y;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && mask[j - 1] && !label[j - 1]) { label[j - 1] = current; stack[sp++] = j - 1; }
        if (x < W - 1 && mask[j + 1] && !label[j + 1]) { label[j + 1] = current; stack[sp++] = j + 1; }
        if (y > 0 && mask[j - W] && !label[j - W]) { label[j - W] = current; stack[sp++] = j - W; }
        if (y < H - 1 && mask[j + W] && !label[j + W]) { label[j + W] = current; stack[sp++] = j + W; }
      }
      if (area >= s.minArea) {
        found.push({
          x: ((sx / area + 0.5) / W) * 2 - 1,
          y: 1 - ((sy / area + 0.5) / H) * 2,
          size: Math.max(maxx - minx, maxy - miny) / W,
          area,
        });
      }
    }
    found.sort((a, b) => b.area - a.area);
    ingest(found.slice(0, s.maxBlobs));
    drawOverlay(mask);
  }

  // ------------------------------------------------------------ websocket source
  let ws = null;
  let wsTimer = 0;
  let wsWanted = false;

  function startSocket() {
    wsWanted = true;
    connect();
  }
  function connect() {
    if (!wsWanted) return;
    status = `connecting ${s.wsUrl}`;
    drawOverlay(null);
    try {
      ws = new WebSocket(s.wsUrl);
    } catch (err) {
      status = `bad url: ${err?.message ?? err}`;
      drawOverlay(null);
      return;
    }
    ws.onopen = () => { status = "connected"; drawOverlay(null); };
    ws.onclose = () => {
      ws = null;
      if (!wsWanted) return;
      status = "reconnecting";
      drawOverlay(null);
      wsTimer = setTimeout(connect, 1500);
    };
    ws.onerror = () => { status = "socket error"; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
  }
  /** Accepts { blobs: [{id,x,y,size}] } or a bare array; x/y in 0..1, origin top-left. */
  function handleMessage(msg) {
    const list = Array.isArray(msg) ? msg : msg?.blobs;
    if (!Array.isArray(list)) return;
    const detections = list
      .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y))
      .map((b) => ({
        x: (s.mirror ? 1 - b.x : b.x) * 2 - 1,
        y: 1 - b.y * 2,
        size: Number.isFinite(b.size) ? b.size : 0.05,
        area: Number.isFinite(b.size) ? b.size : 0.05,
        remoteId: b.id,
      }))
      .slice(0, s.maxBlobs);
    ingest(detections);
    drawOverlay(null);
  }
  function stopSocket() {
    wsWanted = false;
    clearTimeout(wsTimer);
    ws?.close();
    ws = null;
  }

  // ------------------------------------------------------------ public API
  function setSource(kind) {
    if (kind === source) return;
    if (source === "webcam") stopWebcam();
    if (source === "websocket") stopSocket();
    source = kind;
    blobs = [];
    trails.clear();
    pending.length = 0;
    status = "off";
    if (kind === "webcam") startWebcam();
    else if (kind === "websocket") startSocket();
    drawOverlay(null);
  }

  return {
    get blobs() { return blobs; },
    get status() { return status; },
    get source() { return source; },
    configure(next) {
      const prevUrl = s.wsUrl;
      s = { ...s, ...next };
      if (source === "websocket" && s.wsUrl !== prevUrl) { stopSocket(); startSocket(); }
      if (s.source !== source) setSource(s.source);
      drawOverlay(mask);
    },
    setSource,
    /**
     * Push a blob frame from any JS source (tests, OSC bridge, MediaPipe).
     * Same shape as the WebSocket messages. Switches the layer to source "feed".
     */
    feed(msg) {
      if (source !== "feed") {
        setSource("none");
        source = "feed";
        status = "fed from script";
      }
      handleMessage(msg);
    },
    /** Segments (NDC) accumulated since the last call. */
    consumeSegments() {
      const out = pending.splice(0, pending.length);
      return out;
    },
    dispose() {
      setSource("none");
      overlay.remove();
    },
  };
}
