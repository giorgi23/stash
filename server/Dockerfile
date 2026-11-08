FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
# yt-dlp is installed fresh on every deploy so YouTube changes get picked up
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir -U "yt-dlp[default]"
COPY app.py .
# One process (jobs live in memory), several threads for parallel downloads
CMD gunicorn app:app --bind 0.0.0.0:${PORT:-8000} --workers 1 --threads 8 --timeout 0
