# Minimal "fresh distro with systemd" for installer tests only.
# Build: docker build --build-arg BASE=ubuntu:24.04 -t adrian-test-ubuntu24 .
ARG BASE=ubuntu:24.04
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus curl ca-certificates xz-utils bzip2 iproute2 procps python3 sudo \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-logind.service getty.target console-getty.service systemd-udevd.service
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
COPY entry.sh /usr/local/sbin/entry.sh
RUN chmod 755 /usr/local/sbin/entry.sh
CMD ["/usr/local/sbin/entry.sh"]
