"""
Stash download server.

A tiny API that downloads a YouTube video (max 720p, iPhone-friendly MP4)
with yt-dlp and hands the file to the Stash app on your phone.

Endpoints (all need the header  X-Token: <API_TOKEN>):
  GET  /health                 -> {"ok": true}   (no token needed)
  GET  /info?url=...           -> title, channel, duration, thumbnail
  POST /jobs   {"url": "..."}  -> {"id": "..."}  starts a download
  GET  /jobs/<id>              -> status + progress
  GET  /jobs/<id>/file         -> the MP4 (deleted from the server afterwards)
"""

import os
import shutil
import tempfile
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_file, after_this_request
from flask_cors import CORS
import yt_dlp

API_TOKEN = os.environ.get("API_TOKEN", "")
MAX_HEIGHT = int(os.environ.get("MAX_HEIGHT", "720"))
JOB_TTL_SECONDS = 60 * 60  # forget finished jobs after an hour

# H.264 + AAC in an MP4 container plays natively on every iPhone.
FORMAT = (
    f"bv*[height<={MAX_HEIGHT}][vcodec^=avc1]+ba[ext=m4a]/"
    f"b[height<={MAX_HEIGHT}][ext=mp4]/"
    f"bv*[height<={MAX_HEIGHT}]+ba/b[height<={MAX_HEIGHT}]/b"
)

app = Flask(__name__)
CORS(app, expose_headers=["Content-Length", "Content-Disposition"])

jobs = {}
jobs_lock = threading.Lock()


def base_opts():
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
    # Optional: if YouTube starts blocking the server, paste exported cookies
    # into the YT_COOKIES environment variable on Render.
    cookies = os.environ.get("YT_COOKIES")
    if cookies:
        path = os.path.join(tempfile.gettempdir(), "yt_cookies.txt")
        with open(path, "w") as f:
            f.write(cookies)
        opts["cookiefile"] = path
    return opts


def authorized():
    if not API_TOKEN:
        return True
    return request.headers.get("X-Token") == API_TOKEN or request.args.get("token") == API_TOKEN


@app.before_request
def check_token():
    if request.method == "OPTIONS" or request.path == "/health":
        return None
    if not authorized():
        return jsonify(error="Wrong or missing access token"), 401
    return None


def friendly_error(exc):
    msg = str(exc)
    if "Sign in to confirm" in msg or "not a bot" in msg:
        return "YouTube is blocking the server right now (bot check). Try again later, or add cookies — see README."
    if "Private video" in msg:
        return "This video is private."
    if "confirm your age" in msg or "age-restricted" in msg or "inappropriate for some users" in msg:
        return "This video is age-restricted (needs cookies — see README)."
    if "Video unavailable" in msg:
        return "This video is unavailable (removed, private or region-locked)."
    if "Unable to download" in msg or "timed out" in msg:
        return "The server couldn't reach YouTube. Try again in a minute."
    return msg.split("ERROR: ")[-1][:300]


def cleanup_old_jobs():
    now = time.time()
    with jobs_lock:
        for jid in list(jobs):
            job = jobs[jid]
            if job["status"] in ("done", "error", "sent") and now - job["updated"] > JOB_TTL_SECONDS:
                shutil.rmtree(job["dir"], ignore_errors=True)
                del jobs[jid]


@app.get("/health")
def health():
    return jsonify(ok=True, yt_dlp=yt_dlp.version.__version__)


@app.get("/info")
def info():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify(error="Missing url"), 400
    try:
        with yt_dlp.YoutubeDL({**base_opts(), "skip_download": True}) as ydl:
            data = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=friendly_error(exc)), 422
    return jsonify(
        id=data.get("id"),
        title=data.get("title"),
        channel=data.get("channel") or data.get("uploader"),
        duration=data.get("duration"),
        thumbnail=data.get("thumbnail"),
    )


def run_job(jid, url):
    job = jobs[jid]

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            # Video and audio download separately; report each stream's progress.
            job["progress"] = round(done / total * 100, 1) if total else None
            job["stage"] = "downloading"
            job["updated"] = time.time()
        elif d["status"] == "finished":
            job["stage"] = "processing"

    opts = {
        **base_opts(),
        "format": FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": os.path.join(job["dir"], "%(id)s.%(ext)s"),
        "progress_hooks": [hook],
        "postprocessor_args": {"merger": ["-movflags", "+faststart"]},
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            data = ydl.extract_info(url, download=True)
        files = [f for f in os.listdir(job["dir"]) if f.endswith(".mp4")] or os.listdir(job["dir"])
        if not files:
            raise RuntimeError("Download finished but no file was produced")
        path = os.path.join(job["dir"], files[0])
        job.update(
            status="done",
            stage="ready",
            progress=100,
            path=path,
            size=os.path.getsize(path),
            title=data.get("title"),
            height=data.get("height"),
        )
    except Exception as exc:  # noqa: BLE001
        job.update(status="error", error=friendly_error(exc))
        shutil.rmtree(job["dir"], ignore_errors=True)
    job["updated"] = time.time()


@app.post("/jobs")
def create_job():
    cleanup_old_jobs()
    url = (request.get_json(silent=True) or {}).get("url", "").strip()
    if not url:
        return jsonify(error="Missing url"), 400
    jid = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[jid] = {
            "status": "working",
            "stage": "starting",
            "progress": 0,
            "dir": tempfile.mkdtemp(prefix="stash-"),
            "updated": time.time(),
        }
    threading.Thread(target=run_job, args=(jid, url), daemon=True).start()
    return jsonify(id=jid), 202


@app.get("/jobs/<jid>")
def job_status(jid):
    job = jobs.get(jid)
    if not job:
        return jsonify(error="Unknown job (the server may have restarted — try again)"), 404
    return jsonify({k: v for k, v in job.items() if k not in ("dir", "path")})


@app.get("/jobs/<jid>/file")
def job_file(jid):
    job = jobs.get(jid)
    if not job or job["status"] != "done":
        return jsonify(error="File not ready"), 404

    @after_this_request
    def remove(response):
        # Free the server's disk once the phone has the file.
        def later():
            time.sleep(120)
            shutil.rmtree(job["dir"], ignore_errors=True)
            job["status"] = "sent"
        threading.Thread(target=later, daemon=True).start()
        return response

    return send_file(job["path"], mimetype="video/mp4", as_attachment=True,
                     download_name=f"{jid}.mp4", conditional=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
