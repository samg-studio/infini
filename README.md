# infini

Full-screen generative art library for a local ComfyUI workflow.

Enter one prompt, press `play`, and the app continuously generates that prompt with a new random seed each time. The default prompt is:

```text
Quantum Art 35mm Film
```

On load, the app shows a short centered infinity mark while it smoke-tests the configured ComfyUI bridge.

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

For private personal access, the cleanest bridge is Tailscale Serve:

```bash
HOST=127.0.0.1 PORT=8089 BASE_PATH=/infini npm start
tailscale serve --bg --https 8443 --set-path /infini http://127.0.0.1:8089
```

Open the hosted site with the HTTPS URL Tailscale gives you:

```text
https://your-site.example/?api=https://your-mac.your-tailnet.ts.net:8443/infini
```

The current handle URL is `https://samg.here.now/infini/`.

For public access without requiring viewers to be on your tailnet, use Tailscale Funnel instead of Serve. Keep Funnel pointed at this app's `server.js` proxy, not directly at ComfyUI.

To stop this bridge:

```bash
tailscale serve --https=8443 off
launchctl remove com.samg.infini.bridge
```

## Reset

`reset` clears only the app's browser-side library cache. It does not delete ComfyUI output files.

## Screensaver

The top-right arrow enters fullscreen screensaver mode. It shows the latest generated image and only fades to a new image when ComfyUI finishes the next one.

## Notes

Future `architecture` mode: add a menu word that accepts a house plan upload, routes it through a separate ComfyUI workflow with Canny/line guidance, then generates infinite variations that follow the plan while randomizing materials and textures.
