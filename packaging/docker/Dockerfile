# A.D.R.I.A.N. Discord voice, Docker image. Built by packaging/docker/build.sh
# from the same bundle as the native install. The "fetch" stage also serves
# as the one-shot model downloader in compose.yaml.

FROM ubuntu:24.04 AS fetch
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates xz-utils bzip2 \
 && rm -rf /var/lib/apt/lists/*
COPY downloads.sh /usr/local/lib/adrian/downloads.sh
COPY fetch-models.sh /usr/local/bin/fetch-models
RUN chmod 0755 /usr/local/bin/fetch-models \
 && bash -c '. /usr/local/lib/adrian/downloads.sh && mkdir -p /node && fetch "$NODE_URL" "$NODE_SHA256" /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /node --strip-components=1 --no-same-owner && rm /tmp/node.tar.xz'

FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --user-group --uid 10001 --home-dir /var/lib/adrian --no-create-home --shell /usr/sbin/nologin adrian \
 && mkdir -p /etc/adrian /var/lib/adrian/models \
 && chown adrian:adrian /etc/adrian /var/lib/adrian \
 && chmod 0750 /etc/adrian /var/lib/adrian
COPY --from=fetch /node /opt/adrian/node
ADD adrian-voice.tar.gz /opt/adrian/current/
COPY entrypoint.sh /usr/local/bin/adrian-entrypoint
RUN chmod 0755 /usr/local/bin/adrian-entrypoint
ENV PATH=/opt/adrian/node/bin:$PATH \
    NODE_ENV=production \
    ADRIAN_CONFIG=/etc/adrian/config.json \
    ADRIAN_STATE=/var/lib/adrian \
    LD_LIBRARY_PATH=/opt/adrian/current/node_modules/sherpa-onnx-linux-x64
USER adrian
WORKDIR /opt/adrian/current
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/adrian-entrypoint"]
