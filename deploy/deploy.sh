#!/usr/bin/env bash
# Ships the committed code (HEAD) to a Google Cloud VM and runs setup.sh there. SSH goes through IAP.
#
# Five environment variables are required, and none has a default, so nothing about anyone's
# project or account is baked into the repository:
#   PROJECT  Google Cloud project id
#   ZONE     zone the VM runs in
#   VM       name of the VM
#   DOMAIN   public host name Caddy serves (its DNS record must already point at the VM)
#   ACCOUNT  Google account gcloud runs as
#
# Usage: PROJECT=my-project ZONE=us-central1-a VM=my-vm DOMAIN=git.example.com ACCOUNT=you@example.com deploy/deploy.sh
set -euo pipefail

missing=()
for var in PROJECT ZONE VM DOMAIN ACCOUNT; do
  if [ -z "${!var:-}" ]; then missing+=("$var"); fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "deploy.sh: required environment variable(s) not set: ${missing[*]}" >&2
  echo "usage: PROJECT=my-project ZONE=us-central1-a VM=my-vm DOMAIN=git.example.com ACCOUNT=you@example.com deploy/deploy.sh" >&2
  exit 2
fi

G=(gcloud --project="$PROJECT" --account="$ACCOUNT" --quiet)

cd "$(git rev-parse --show-toplevel)"
WORK=$(mktemp -d)
git archive --format=tar.gz -o "$WORK/gitfkd.tar.gz" HEAD
echo "Packed $(git rev-parse --short HEAD)"

"${G[@]}" compute scp --zone="$ZONE" --tunnel-through-iap "$WORK/gitfkd.tar.gz" deploy/setup.sh "$VM:/tmp/"
"${G[@]}" compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="sudo DOMAIN=$DOMAIN bash /tmp/setup.sh /tmp/gitfkd.tar.gz && rm -f /tmp/gitfkd.tar.gz"
