#!/usr/bin/env bash
# Prepares the throwaway project the demo recording runs in, and puts it back to its starting state
# on every run: a one-file repository whose idle timeout is a minute instead of an hour.
#
# It touches only BRAINGATE_DEMO_DIR (default ~/bg-demo). Registering that directory adds one project
# to BrainGate's own records; your model catalogue, acceptances and quota history are left alone.
set -euo pipefail

demo="${BRAINGATE_DEMO_DIR:-$HOME/bg-demo}"

if [ ! -d "$demo/.git" ]; then
  mkdir -p "$demo"
  cd "$demo"
  git init -q
  cat > session.js <<'JS'
// Log the user out after an hour of inactivity.
const IDLE_TIMEOUT_SECONDS = 60;

export function isExpired(lastActive, now) {
  return (now - lastActive) / 1000 > IDLE_TIMEOUT_SECONDS;
}
JS
  printf '.brain/\n' > .gitignore
  git add session.js .gitignore
  git -c user.name=demo -c user.email=demo@example.invalid commit -qm "demo: idle logout"
fi

cd "$demo"
# Undo whatever the previous recording's write changed.
git checkout -q -- .
git clean -qfd -e .brain

if [ ! -f .brain/project.json ]; then
  braingate init --project-id bg-demo --name "BrainGate demo" >/dev/null
fi

echo "Demo project ready at $demo"
