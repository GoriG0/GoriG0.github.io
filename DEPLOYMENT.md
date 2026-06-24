# Deploying: GitHub Pages (viewer) + a real server (generator API)

This project has two halves that get deployed separately:

| Piece | What it is | Where it goes |
|---|---|---|
| `map_viewer.html` | Static page, runs in the browser | GitHub Pages |
| `mapServer.js` + `sphereMapGenerator.js` | Node HTTP API | A real server host (Render, Fly, Railway, etc.) |

GitHub Pages only serves static files — it can't run a Node process. So the
generator API has to live somewhere that *can* run Node and stay listening,
and the viewer just calls it over HTTPS like any other API.

## 1. Deploy the server

These steps use **Render** (free tier works fine), but Fly.io, Railway, or
any host that runs a long-lived Node process works the same way.

1. Push this repo to GitHub (if you haven't already).
2. Go to [render.com](https://render.com) → **New** → **Web Service** →
   connect your GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start` (runs `node mapServer.js`)
   - **Environment:** Node
   - Leave the port alone — Render sets `PORT` automatically and
     `mapServer.js` already reads `process.env.PORT`.
4. Deploy. Render gives you a URL like:
   `https://sphere-map-generator.onrender.com`
5. Confirm it's alive by visiting that URL directly — you should see
   `Sphere map generator is running.`
6. Test the API directly in your browser:
   `https://sphere-map-generator.onrender.com/api/generate?nodes=20`
   You should get back JSON with `"success": true`.

**Note on free tiers:** services on Render's free plan spin down when idle
and take ~30–60 seconds to wake up on the next request. That first
"Generate Map" click after a quiet period may just look like it's hanging —
it isn't broken, the server is waking up.

## 2. Deploy the viewer

1. In your GitHub repo, go to **Settings → Pages**.
2. Under **Source**, choose the branch and folder containing
   `map_viewer.html` (root, or `/docs`, whichever you used).
3. GitHub gives you a URL like:
   `https://yourusername.github.io/your-repo/map_viewer.html`

## 3. Point the viewer at your server

Open the deployed `map_viewer.html` page, scroll to **Generate New Map**,
and paste your server's URL into the **Server URL** field, e.g.:

```
https://sphere-map-generator.onrender.com
```

It's saved in your browser automatically (via `localStorage`), so you only
need to enter it once per browser. Click **Generate Map** — it now calls
your hosted server instead of `localhost:8765`.

## Why `localhost:8765` doesn't work on GitHub Pages

`localhost` always means "this device, right now" — never a server out on
the internet. When `map_viewer.html` is opened from GitHub Pages on someone
else's computer, `localhost:8765` points at *their* machine, where nothing
is running. That's why the server needs a real public URL, and why the
viewer needs a way to know what that URL is (the **Server URL** field).

## HTTPS matters

GitHub Pages serves over HTTPS. Browsers block a HTTPS page from calling an
HTTP-only API ("mixed content"). Render, Fly, and Railway all give you HTTPS
URLs by default, so as long as you paste the `https://...` URL into the
Server URL field, this isn't something you need to configure manually.

## Running everything locally instead

You don't need any of the above for local development:

```bash
npm install        # only needed once; no real dependencies, but keeps things tidy
node mapServer.js  # starts on http://localhost:8765
```

Then open `map_viewer.html` directly in your browser (double-click it, or
`file://` it) and leave the **Server URL** field blank — it defaults to
`http://localhost:8765`.
