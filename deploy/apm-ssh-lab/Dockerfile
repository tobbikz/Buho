# SSH jump host for Buho zero-code APM lab (docker CLI → host socket).
FROM alpine:3.20

RUN apk add --no-cache openssh-server openssh-client bash docker-cli \
  && ssh-keygen -A \
  && adduser -D -s /bin/bash lab \
  && echo 'lab:lab' | chpasswd \
  && mkdir -p /home/lab/.ssh /root/.ssh \
  && chmod 700 /home/lab/.ssh /root/.ssh \
  && printf '%s\n' \
       'PermitRootLogin prohibit-password' \
       'PasswordAuthentication yes' \
       'PubkeyAuthentication yes' \
       'AllowTcpForwarding no' \
     >> /etc/ssh/sshd_config

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
