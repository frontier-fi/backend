#!/usr/bin/env bash
# Create the production DigitalOcean app on first run, then deploy the `production`
# branch configured in the app spec. Dashboard env vars are left alone after create.
# create-deployment does not apply later edits to this spec. Update the app
# spec in the dashboard, or with `doctl apps update`, before relying on them.
set -euo pipefail

spec=".do/prod.yaml"
app_name="frontier-backend"

if [[ -z "${DIGITALOCEAN_ACCESS_TOKEN:-}" ]]; then
    echo "DIGITALOCEAN_ACCESS_TOKEN is unset. Skipping DigitalOcean deploy."
    exit 0
fi

if [[ ! -f "$spec" ]]; then
    echo "missing app spec: $spec" >&2
    exit 1
fi

app_id="$(
    doctl apps list -o json | python3 -c '
import json, sys
name = sys.argv[1]
payload = json.load(sys.stdin)
apps = [] if payload is None else (payload.get("apps") if isinstance(payload, dict) else payload)
for app in apps:
    if app.get("spec", {}).get("name") == name:
        print(app["id"])
        break
' "$app_name"
)"

if [[ -n "$app_id" ]]; then
    echo "Deploying ${app_name} (${app_id})"
    doctl apps create-deployment "$app_id" --force-rebuild --wait
    exit 0
fi

for key in ADMIN_API_KEY DRPC_API_KEY COINGECKO_API_KEY; do
    if [[ -z "${!key:-}" ]]; then
        echo "${key} is unset. Add that repository secret before the first create of ${app_name}." >&2
        exit 1
    fi
done

doctl databases list -o json | python3 -c '
import json, sys
payload = json.load(sys.stdin)
rows = [] if payload is None else (payload.get("databases") if isinstance(payload, dict) else payload)
names = {row.get("name") for row in rows}
if "frontier-db" not in names:
    raise SystemExit(
        "Managed Postgres cluster frontier-db was not found in this account.\n"
        "Create it once in fra, then rerun this job:\n"
        "  doctl databases create frontier-db --engine pg --version 18 --region fra1 --size db-s-1vcpu-1gb --storage-size-mib 10240 --num-nodes 1"
    )
'

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

python3 - "$spec" "$tmp" <<'PY'
import os, sys
src, dest = sys.argv[1], sys.argv[2]
text = open(src).read()
replacements = {
    "REPLACE_ADMIN_API_KEY": "ADMIN_API_KEY",
    "REPLACE_DRPC_API_KEY": "DRPC_API_KEY",
    "REPLACE_COINGECKO_API_KEY": "COINGECKO_API_KEY",
}
for placeholder, name in replacements.items():
    if placeholder not in text:
        raise SystemExit(f"{src} is missing {placeholder}")
    value = os.environ[name]
    if any(char in value for char in '"\\\n\r'):
        raise SystemExit(f"{name} contains a quote, backslash, or newline. Set it in the App Platform dashboard after creating the app with a temporary value.")
    text = text.replace(placeholder, value)
open(dest, "w").write(text)
PY

echo "Creating ${app_name} from ${spec}"
doctl apps create --spec "$tmp" --wait
