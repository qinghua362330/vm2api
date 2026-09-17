#!/bin/sh
set -eu

ROOT="${KIN_PROJECT_ROOT:-/opt/vm2api}"
mkdir -p "$ROOT/vms" "$ROOT/data" "$ROOT/bin"

if [ ! -f "$ROOT/vms/active.json" ]; then
  printf '%s\n' '{ "active_vm": "vm-01" }' > "$ROOT/vms/active.json"
fi
if [ ! -f "$ROOT/vms/vm-01.json" ]; then
  cat > "$ROOT/vms/vm-01.json" <<'EOF'
{
  "id": "vm-01",
  "name": "vm-01",
  "status": "stopped",
  "schedulable": false,
  "policy": { "maxConcurrency": 2 }
}
EOF
fi

KERNEL="${KIN_KERNEL_BIN:-$ROOT/bin/kin-kernel}"
if [ ! -x "$KERNEL" ]; then
  echo "vm2api: $KERNEL missing or not executable. Put linux amd64 Release files in $ROOT/bin (kin-kernel, kin-egress, kin-worker)." >&2
fi

if [ ! -S /var/run/docker.sock ]; then
  echo "vm2api: /var/run/docker.sock not mounted; slot create/start will fail." >&2
fi

cd /opt/vm2api
exec node src/server.mjs
