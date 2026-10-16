#!/bin/sh
# Test containers only: make this container's own (private-namespace) cgroup
# view writable so systemd can run as PID 1, then hand over to systemd.
mount -o remount,rw /sys/fs/cgroup 2>/dev/null || echo "cgroup remount failed" >&2
exec /lib/systemd/systemd
