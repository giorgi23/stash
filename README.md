# Stash — your YouTube playlist, offline

A home-screen app for iPhone. Paste YouTube links, Stash downloads them (720p) onto
your phone, and they play with no connection — on a plane, in the metro, anywhere.

```
docs/     the iPhone app (hosted free on GitHub Pages)
server/   the downloader (hosted free on Render, runs yt-dlp)
render.yaml   one-click setup for Render
```

Total cost: **$0**. Setup: about 10 minutes, once.

---

## 1. Put the code on GitHub (2 min)

1. Go to github.com → **New repository** → name it `stash` → **Public** → Create.
2. On the empty repo page, click **uploading an existing file**.
3. Unzip `stash.zip` on your computer and drag **everything inside the `stash` folder**
   (`docs`, `server`, `render.yaml`, `README.md`) into the browser → **Commit changes**.

## 2. Turn on the app (1 min)

1. In the repo: **Settings → Pages**.
2. Source: **Deploy from a branch** → Branch **main**, folder **/docs** → Save.
3. After ~1 minute your app lives at `https://<your-github-name>.github.io/stash/`.

## 3. Start the downloader (5 min)

1. Go to **render.com** → sign up with your GitHub account (free plan).
2. **New + → Blueprint** → pick your `stash` repo → **Apply**.
   Render reads `render.yaml` and builds the server (first build takes ~5 min).
3. When it's live, open the service and copy two things:
   - the **URL** at the top (e.g. `https://stash-server-ab12.onrender.com`)
   - **Environment → API_TOKEN** → reveal and copy the value

## 4. Install on your iPhone (1 min)

1. Open your `github.io/stash/` link **in Safari**.
2. Share button → **Add to Home Screen** → Add.
3. Open Stash **from the home screen** (important — Safari tabs and the home-screen app
   keep separate storage) → paste the server URL + token in Settings → **Test connection** → Save.

Done. Paste a link, tap Add, keep the app open until the bar fills — then it's yours offline.

---

## Optional: "Stash" in the YouTube share sheet

iOS doesn't let web apps appear in the share sheet directly, but a Shortcut does it:

1. Open the **Shortcuts** app → **+** → name it **Stash**.
2. Tap the **ⓘ** → turn on **Show in Share Sheet** → accept **URLs** (and Text).
3. Add action **Open URLs**, with the URL:
   `https://<your-github-name>.github.io/stash/?add=` followed by the **Shortcut Input** variable.

Now in the YouTube app: Share → **Stash** → it opens and starts downloading.

---

## Good to know

- **Keep Stash open while downloading.** iOS pauses web apps in the background. If you
  leave, it picks the download back up when you return.
- **First download of the day is slow to start.** Render's free server sleeps after
  15 min idle and takes up to a minute to wake. The app shows "Waking up the server…".
- **Storage:** 720p ≈ 100–300 MB per hour of video. Delete watched videos via the ⋯ menu.
  If you don't open Stash for several weeks, iOS may clear its storage.
- **If downloads start failing with a "bot check" message:** YouTube sometimes blocks
  cloud servers. Usually it passes; if it persists, you can export YouTube cookies
  (browser extension "Get cookies.txt LOCALLY"), paste the text into a new Render
  environment variable `YT_COOKIES`, and redeploy. Best done with a secondary Google
  account rather than your main one.
- **Updating yt-dlp:** in Render, **Manual Deploy → Clear build cache & deploy**.
  This pulls the newest yt-dlp, which fixes most "it stopped working" moments.
- Your server is protected by the token, so nobody else can use it.
- Downloading is against YouTube's Terms of Service; this is meant for personal
  offline viewing only.
