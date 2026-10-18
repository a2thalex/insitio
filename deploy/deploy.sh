#!/usr/bin/env bash
# Ships the committed code (HEAD) to the VM and runs setup.sh there. SSH goes through IAP.
# Usage: deploy/deploy.sh   (override with PROJECT, ZONE, VM, DOMAIN, ACCOUNT)
set -euo pipefail

PROJECT=${PROJECT:-iam-bot-git}
ZONE=${ZONE:-us-central1-a}
VM=${VM:-gitfkd-1}
DOMAIN=${DOMAIN:-git.iam.bot}
ACCOUNT=${ACCOUNT:-gregory@iam.bot}
G=(gcloud --project="$PROJECT" --account="$ACCOUNT" --quiet)

cd "$(git rev-parse --show-toplevel)"
WORK=$(mktemp -d)
git archive --format=tar.gz -o "$WORK/gitfkd.tar.gz" HEAD
echo "Packed $(git rev-parse --short HEAD)"

"${G[@]}" compute scp --zone="$ZONE" --tunnel-through-iap "$WORK/gitfkd.tar.gz" deploy/setup.sh "$VM:/tmp/"
"${G[@]}" compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="sudo DOMAIN=$DOMAIN bash /tmp/setup.sh /tmp/gitfkd.tar.gz && rm -f /tmp/gitfkd.tar.gz"
