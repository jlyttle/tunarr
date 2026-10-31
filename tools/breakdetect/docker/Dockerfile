FROM python:3.12-slim

RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg intel-media-va-driver-non-free vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/breakdetect
COPY pyproject.toml README.md ./
COPY breakdetect ./breakdetect
RUN pip install --no-cache-dir .

ENV BREAKDETECT_ROOTS=/media/plex \
    BREAKDETECT_CACHE=/cache/features \
    BREAKDETECT_DATA=/data
