# TouchDesigner -> browser blob feed

The viewer's "blobs" source `websocket` expects JSON frames like:

```json
{ "blobs": [ { "id": 3, "x": 0.41, "y": 0.62, "size": 0.06 } ] }
```

- `x`, `y` in 0..1, origin top-left (Blob Track TOP convention). The viewer converts to NDC and mirrors if "mirror" is on.
- `size` is the blob's larger side as a fraction of the frame width (optional, used for the overlay only).
- `id` must stay stable while a blob persists; the viewer uses it to build movement segments.
- Send one frame per TouchDesigner frame (30 to 60 Hz). Only the newest 8 segments are consumed per render frame.

## Network

1. `Video Device In TOP` (or NDI / Kinect depth) -> `Level TOP` / `Threshold TOP` to isolate the subject -> `Blob Track TOP`.
2. `Blob Track TOP` has a CHOP output: `Blob Track CHOP`-style channels `blob0:tx`, `blob0:ty`, `blob0:sizex`, `blob0:sizey`, `blob0:id`... (channel names depend on the version; check the Info CHOP).
3. `Web Server DAT`, port **9980**, WebSocket enabled. TouchDesigner is the server; the browser connects to `ws://<td-machine-ip>:9980`.
4. A `CHOP Execute DAT` on the blob CHOP sends every cooked frame to all connected WebSocket clients.

## Scripts

`CHOP Execute DAT` (Value Change off, **Cook** on) on the blob CHOP:

```python
import json

web = op('webserver1')          # the Web Server DAT
clients = []                    # filled by the Web Server DAT callbacks below

def onCook(chop):
    blobs = []
    n = int(chop.numSamples)
    # One sample per blob with channels tx, ty, sizex, sizey, id
    for i in range(n):
        try:
            blobs.append({
                'id': int(chop['id'][i]),
                'x': float(chop['tx'][i]),
                'y': float(chop['ty'][i]),
                'size': float(max(chop['sizex'][i], chop['sizey'][i])),
            })
        except Exception:
            pass
    msg = json.dumps({'blobs': blobs})
    for c in list(parent().fetch('wsClients', [])):
        try:
            web.webSocketSendText(c, msg)
        except Exception:
            pass
    return
```

`Web Server DAT` callbacks (the DAT it points to):

```python
def onWebSocketOpen(webServerDAT, client, uri):
    clients = webServerDAT.parent().fetch('wsClients', [])
    if client not in clients:
        clients.append(client)
    webServerDAT.parent().store('wsClients', clients)
    return

def onWebSocketClose(webServerDAT, client):
    clients = webServerDAT.parent().fetch('wsClients', [])
    if client in clients:
        clients.remove(client)
    webServerDAT.parent().store('wsClients', clients)
    return

def onHTTPRequest(webServerDAT, request, response):
    response['statusCode'] = 200
    response['statusReason'] = 'OK'
    response['data'] = 'ALTM blob feed'
    return response
```

Adjust the channel names to what your Blob Track CHOP actually outputs (open its Info CHOP), and normalise `tx`/`ty` to 0..1 if your version reports pixels.

## Opening the viewer against TouchDesigner

```
http://localhost:5173/?blobs=ws://192.168.1.20:9980
```

Or pick `websocket` under "blobs (tracking)" and paste the URL into `wsUrl`.

## Quick test without TouchDesigner

Run this in the browser console: it fakes one blob circling the pile using the same message shape TouchDesigner would send.

```js
let t = 0;
const fake = setInterval(() => {
  t += 0.04;
  blobLayer.feed({ blobs: [{ id: 1, x: 0.5 + 0.25 * Math.cos(t), y: 0.5 + 0.2 * Math.sin(t), size: 0.06 }] });
}, 33);
// clearInterval(fake) to stop
```
