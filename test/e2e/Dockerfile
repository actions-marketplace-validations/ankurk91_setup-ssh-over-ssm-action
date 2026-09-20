FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server rsync ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && usermod -p '*' ubuntu
RUN printf '%s\n' \
    'PermitRootLogin no' \
    'PasswordAuthentication no' \
    'PubkeyAuthentication yes' \
    'AuthorizedKeysFile /home/ubuntu/.ssh/authorized_keys' \
    'StrictModes no' \
    > /etc/ssh/sshd_config.d/e2e.conf
CMD ["/usr/sbin/sshd","-D","-e"]
