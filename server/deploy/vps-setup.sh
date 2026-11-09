#!/usr/bin/env bash
# vps-setup.sh '<deploy ssh public key>' — one-time setup of the API host (Ubuntu 24.04).
# Safe to run again. Run as root from the admin account, after the admin's own key
# works:  sudo bash vps-setup.sh 'ssh-ed25519 AAAA… github-actions-deploy@hostelpalika'
#
# After it: Docker + compose, a `deploy` user CI logs in as (.github/workflows/server.yml),
# ~deploy/hostelpalika/ for deploy.sh, SSH by key only, the firewall open on 22/80/443.
# RUNBOOK.md §1.
set -euo pipefail

DEPLOY_KEY=${1:?usage: sudo bash vps-setup.sh '<deploy ssh public key>'}
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
ADMIN=${SUDO_USER:?run through sudo from the admin account}
# Password SSH goes off below: refuse while the admin has no key to log in with.
[ -s "/home/$ADMIN/.ssh/authorized_keys" ] || {
  echo "no key in /home/$ADMIN/.ssh/authorized_keys; nothing changed" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q docker.io docker-compose-v2 curl ufw unattended-upgrades cloud-guest-utils
systemctl enable --now docker

# Root fills the disk: the provider's image leaves most of it unallocated (18 of 55 GB).
pv=$(pvs --noheadings -o pv_name | tr -d ' ' | head -n1)
if [ -n "$pv" ]; then
  growpart "/dev/$(lsblk -dno pkname "$pv")" "${pv##*[!0-9]}" || true # exit 1 = already full
  pvresize "$pv"
  lvextend -r -l +100%FREE "$(findmnt -no SOURCE /)" || true # fails when nothing is free
fi

# deploy runs compose for CI. The docker group is root-equivalent, so its key lives
# only in the GitHub secret VPS_SSH_KEY.
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh /home/deploy/hostelpalika
printf '%s\n' "$DEPLOY_KEY" >/home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# The admin logs in by key only from here on, so sudo stops asking for a password.
echo "$ADMIN ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-hostelpalika-admin
chmod 440 /etc/sudoers.d/90-hostelpalika-admin
visudo -cqf /etc/sudoers.d/90-hostelpalika-admin
# The provider's cloud-init file has a malformed line sudo warns about on every call;
# the file above grants the same, so a broken one goes.
f=/etc/sudoers.d/90-cloud-init-users
[ ! -f $f ] || visudo -cqf $f || rm -f $f

# SSH: keys only, no root. sshd keeps the first value it reads, and 10- sorts before
# cloud-init's 50- drop-in that turns passwords on.
cat >/etc/ssh/sshd_config.d/10-hostelpalika.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl try-reload-or-restart ssh

# Firewall. Docker's published ports (Caddy's 80/443) pass through its own iptables
# rules; the API, metrics and Redis publish nothing.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# Redis background saves need overcommit (its startup warning).
echo 'vm.overcommit_memory = 1' >/etc/sysctl.d/90-redis.conf
sysctl -q -p /etc/sysctl.d/90-redis.conf

# Security updates install themselves.
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  >/etc/apt/apt.conf.d/20auto-upgrades

echo "done: docker $(docker --version | cut -d' ' -f3) compose $(docker compose version --short)"
echo "next: ~deploy/hostelpalika/.env (mode 600, owner deploy), then the GitHub secrets (RUNBOOK.md §1)"
