#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=${CODEX_MESH_SOURCE_ROOT:-"$(dirname -- "$script_dir")"}
data_base=${XDG_DATA_HOME:-"$HOME/.local/share"}
destination=${CODEX_MESH_INSTALL_DIR:-"$data_base/codex-mesh"}

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 20 or newer is required.' >&2
  exit 1
fi
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 20 ]; then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi
if [ ! -d "$source_root/src/agent" ] || [ ! -d "$source_root/src/cli" ]; then
  echo "Could not find src/agent and src/cli below $source_root." >&2
  exit 1
fi

mkdir -p "$destination/src" "$destination/bin" "$destination/examples"
chmod 700 "$destination"
cp -R "$source_root/src/agent" "$destination/src/"
cp -R "$source_root/src/cli" "$destination/src/"
cp "$source_root"/examples/*.json "$destination/examples/"

agent_launcher="$destination/bin/mesh-agent"
cli_launcher="$destination/bin/meshctl"
sed "s|@@ENTRY@@|$destination/src/agent/index.mjs|g" "$source_root/scripts/linux/node-launcher.template" >"$agent_launcher"
sed "s|@@ENTRY@@|$destination/src/cli/index.mjs|g" "$source_root/scripts/linux/node-launcher.template" >"$cli_launcher"
chmod 700 "$agent_launcher" "$cli_launcher"

echo "Codex Mesh files copied to $destination"
echo 'No systemd unit, firewall rule, package, or root-level change was made.'
echo
echo 'Next steps:'
echo '  1. On the controller, run: meshctl pair --name ubantant'
echo "  2. Back on this machine, enroll it: $agent_launcher enroll --hub http://CONTROLLER-PRIVATE-IP:7337 --pairing-code CODE --name ubantant --workspace project/example=/srv/projects/example"
echo "  3. Test in the foreground: $agent_launcher run"
echo "  4. Customize $source_root/scripts/linux/codex-mesh-agent.service.template and install it manually if desired."
