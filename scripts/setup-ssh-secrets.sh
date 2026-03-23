#!/usr/bin/env bash
set -euo pipefail

STAGE="${1:-ops}"
SSH_KEY_PATH="${2:-$HOME/.ssh/id_ed25519.pub}"

if [ ! -f "$SSH_KEY_PATH" ]; then
  echo "Error: SSH public key not found at $SSH_KEY_PATH"
  echo "Usage: $0 [stage] [ssh-key-path]"
  exit 1
fi

SSH_PUBLIC_KEY=$(cat "$SSH_KEY_PATH")
PUBLIC_IP=$(curl -sf https://ifconfig.me)

if [ -z "$PUBLIC_IP" ]; then
  echo "Error: could not determine public IP"
  exit 1
fi

ALLOWED_CIDR="${PUBLIC_IP}/32"

echo "Stage:      $STAGE"
echo "SSH key:    $SSH_KEY_PATH"
echo "Public IP:  $PUBLIC_IP"
echo "CIDR:       $ALLOWED_CIDR"
echo ""

bunx sst secret set OctoRouterSshPublicKey "$SSH_PUBLIC_KEY" --stage "$STAGE"
bunx sst secret set OctoRouterSshAllowedCidr "$ALLOWED_CIDR" --stage "$STAGE"

echo ""
echo "Done. SSH secrets set for stage '$STAGE'."
