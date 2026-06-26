# infini

Full-screen generative art library for a local ComfyUI workflow.

The app continuously generates from the fixed prompt:

```text
Quantum art
```

## Local use

Start ComfyUI on `127.0.0.1:8188`, then run:

```bash
npm start
```

Open:

```text
http://127.0.0.1:8088/
```

For phone use on the same network, bind the server to your Mac's LAN IP:

```bash
HOST=192.168.1.100 npm start
```

Then open:

```text
http://192.168.1.100:8088/
```

## Hosted use

The static app can be hosted anywhere, but a hosted HTTPS page cannot directly reach a private Mac-local `127.0.0.1:8188` ComfyUI server. Use an HTTPS tunnel or bridge to the local `server.js` proxy, then open the hosted app with:

```text
https://your-site.example/?api=https://your-comfy-bridge.example
```

The app stores that API URL in browser local storage.

## Reset

`reset` clears only the app's browser-side library cache. It does not delete ComfyUI output files.
