#!/bin/sh
set -eu

mkdir -p /home/lab/.ssh /root/.ssh /var/run/sshd
chmod 700 /home/lab/.ssh /root/.ssh

if [ -f /keys/authorized_keys ]; then
  cp /keys/authorized_keys /home/lab/.ssh/authorized_keys
  cp /keys/authorized_keys /root/.ssh/authorized_keys
  chmod 600 /home/lab/.ssh/authorized_keys /root/.ssh/authorized_keys
  chown -R lab:lab /home/lab/.ssh
fi

# lab user can talk to host docker.sock
if [ -S /var/run/docker.sock ]; then
  sock_gid=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock)
  if [ -n "$sock_gid" ] && [ "$sock_gid" != "0" ]; then
    addgroup -g "$sock_gid" docker 2>/dev/null || true
    addgroup lab docker 2>/dev/null || true
  fi
  chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

exec /usr/sbin/sshd -D -e
