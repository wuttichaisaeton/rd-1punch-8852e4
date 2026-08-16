# Headless render harness

`test/render.mjs` loads the real `index.html` in a headless browser, waits for the
GLB to finish loading on a software GPU, clicks the viewer's own controls, and
asserts the result **from the DOM** — never from a screenshot. It is plain ESM
with no build step and no `node_modules` in this repo; Playwright and Chromium
come from the machine, everything else it fetches for itself.

## Running it

```sh
node test/render.mjs      # or: npm test
```

It serves the repo root with `python3 -m http.server` on a free port, drives
Chromium with ANGLE/SwiftShader (`--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader --no-sandbox`), prints one `PASS`/`FAIL` line per
assertion and a summary line, and exits non-zero if anything failed. A full run
takes roughly a minute; loading the 6.7 MB Draco-compressed GLB and rasterising
its 1429 meshes in software is the slow part.

The assertions are:

1. `document.querySelector('model-viewer').loaded === true`. On failure it prints
   `#pct` and `mv.src`, because that exact combination is diagnostic (see below).
2. `#openBtn` becomes visible. The button is `display:none` until the animation
   sidecar (`1 Punch.anim.json`) has resolved every mover against the GLB, so its
   visibility is DOM-level proof that the sidecar bound — not an eyeball call.
3. Clicking `#openBtn` flips `#openLbl` from `Open doors` to `Close doors`.
4. The dimension inputs `#dW`, `#dD`, `#dH` are all non-empty.
5. No uncaught page errors, and no unexpected console errors. The two Firebase
   scripts from `www.gstatic.com/firebasejs/...` are *expected* to fail — the page
   wraps its Firebase init in `try/catch` and works fine without it — so console
   errors carrying that host are tolerated and every other one fails the run.

Environment overrides: `CHROME_PATH`, `PLAYWRIGHT_MODULE`, `RENDER_VENDOR_DIR`,
`RENDER_SHOT_DIR`, `RENDER_PORT`, `RENDER_LOAD_TIMEOUT_MS`, `RENDER_HEADED=1`.

Two screenshots (`render-01-closed.png`, `render-02-open.png`) are written next
to this file, or into `RENDER_SHOT_DIR`. They are **artifacts for humans only**;
a screenshot that fails to save is reported as a note and does not affect the
exit code. Do not commit them — add `test/*.png` to `.gitignore`.

## Why the Draco decoder is vendored

The build environment blocks every CDN, and `index.html` pulls three files off
host: `@google/model-viewer@3.5.0`, `three@0.166.1`, and — indirectly, from
inside model-viewer — the Draco decoder pair `draco_wasm_wrapper.js` +
`draco_decoder.wasm`. The npm registry *is* reachable, so the harness runs
`npm pack` for `@google/model-viewer@3.5.0` and `three@0.166.1`, lifts
`dist/model-viewer.min.js`, `build/three.module.js` and
`examples/jsm/libs/draco/gltf/draco_{wasm_wrapper.js,decoder.wasm}` out of the
tarballs, and replays them to the page with Playwright's `context.route()`.
The `.wasm` must be fulfilled with content type `application/wasm` and a Buffer
body or the browser refuses to instantiate it. The files are cached outside the
repo (`~/.cache/1punch-render-harness/vendor` by default, override with
`RENDER_VENDOR_DIR`) and are fetched only when missing, so nothing binary ever
lands in version control.

The Draco decoder is the part that is easy to get wrong, because leaving it out
does not throw. `1 Punch.glb` declares `KHR_draco_mesh_compression` in
`extensionsRequired`. Without a decoder the failure signature is: the GLB
downloads to **100%**, `mv.src` is set correctly, **`mv.loaded` stays `false`
forever**, the canvas stays blank, and **no exception is raised** — no page
error, no rejected promise, nothing on the console beyond the expected Firebase
noise. A harness that only checked "did the page load without errors" would call
that a pass. That is precisely why assertion 1 waits on `loaded === true` and
reports `#pct` and `src` when it times out.

## Why this exists at all

3D render verification was previously believed to be impossible in this
environment: no GPU, no CDN access, and a viewer whose interesting behaviour only
appears after a large compressed model has decoded. It turns out all three are
solvable — SwiftShader gives a real WebGL2 context, npm substitutes for the
blocked CDNs, and the viewer's own DOM exposes enough state (`loaded`, the
sidecar-gated `#openBtn`, the dimension inputs) to prove the render happened
without ever comparing pixels. This harness is the standing, committed proof of
that, so changes to the viewer, the GLB or the animation sidecar can be checked
in seconds instead of by hand.
