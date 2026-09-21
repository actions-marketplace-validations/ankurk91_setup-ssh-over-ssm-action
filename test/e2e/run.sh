#!/usr/bin/env bash
#
# End-to-end check of the built action against a real sshd.
#
# The AWS control plane is stubbed (stub.mjs), but the transport is real. ssh reaches a container
# through the ProxyCommand the action wrote, so ssh, rsync and scp exercise the config it produced.
# ProxyCommand only has to be a process piping stdin/stdout to the target port, so a fake `aws`
# that execs nc stands in for `aws ssm start-session` with no AWS account and no plugin.
#
# Usage:
#   pnpm run build && test/e2e/run.sh
#
# Docker must be usable. If it needs root:
#   DOCKER='sudo docker' test/e2e/run.sh
#
# Overrides: ALIAS, RUN_DIR, EXPECT_MULTIPLEX, KEY_TTL_MS, SSH_PORT, STUB_PORT
#
# No `set -e`: every check should run so the summary reports all failures, not just the first.

set -uo pipefail

# ---------------------------------------------------------------- settings

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$E2E_DIR/../.." && pwd)"

# Default under /tmp: the control socket path has a tight byte ceiling.
RUN_DIR="${RUN_DIR:-/tmp/ssm-e2e}"

SSH_PORT="${SSH_PORT:-22222}"
STUB_PORT="${STUB_PORT:-5599}"
KEY_TTL_MS="${KEY_TTL_MS:-60000}"

CONTAINER_NAME='ssm-e2e'
IMAGE_NAME='ssm-e2e-sshd'
INSTANCE_ID='i-0123456789abcdef0'
HOST_ALIAS="${ALIAS:-ssm-target}"
EXPECT_MULTIPLEX="${EXPECT_MULTIPLEX:-yes}"

# `sudo docker` has to survive word splitting, so keep it as an array.
read -r -a DOCKER_CMD <<< "${DOCKER:-docker}"

REQUIRED_TOOLS=(node ssh rsync scp nc ssh-keygen sha256sum)

passed=0
failed=0
stub_pid=''

# ---------------------------------------------------------------- helpers

ok() {
  local label="$1" actual="$2" expected="$3"

  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS  $label"
    passed=$((passed + 1))
  else
    echo "  FAIL  $label (got '$actual', want '$expected')"
    failed=$((failed + 1))
  fi
}

die() {
  echo "$1" >&2
  exit 1
}

wait_for_port() {
  local port="$1"

  for _ in {1..40}; do
    nc -z 127.0.0.1 "$port" 2>/dev/null && return 0
    sleep 0.25
  done

  return 1
}

# A glob rather than `ls | grep`, so odd filenames cannot confuse the count.
count_matching() {
  local pattern="$1"
  local -a matches=()

  shopt -s nullglob
  # shellcheck disable=SC2206  # deliberate glob expansion, not word splitting
  matches=( $pattern )
  shopt -u nullglob

  echo "${#matches[@]}"
}

teardown() {
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null
  "${DOCKER_CMD[@]}" rm -f "$CONTAINER_NAME" >/dev/null 2>&1
  return 0
}

# ---------------------------------------------------------------- fixture

check_prerequisites() {
  local tool

  for tool in "${REQUIRED_TOOLS[@]}"; do
    command -v "$tool" >/dev/null || die "$tool is required but not on PATH."
  done

  [[ -f "$REPO_DIR/dist/main/index.js" ]] || die 'dist/ is missing. Run: pnpm run build'
}

build_workspace() {
  rm -rf "$RUN_DIR"
  mkdir -p "$RUN_DIR/home/.ssh" "$RUN_DIR/bin" "$RUN_DIR/remote_ssh" "$RUN_DIR/payload"
  chmod 700 "$RUN_DIR/home/.ssh"

  # sshd reads authorized_keys as the target user, and the bind mount keeps the host's uid.
  # That uid only matches the container's ubuntu by luck (it does not on a GitHub runner,
  # where the host user is 1001), so this directory stays traversable by anyone. The image
  # sets StrictModes no, which is what lets sshd accept a file it does not own.
  chmod 755 "$RUN_DIR/remote_ssh"

  seed_ssh_config

  echo 'hello from the runner' > "$RUN_DIR/payload/app.txt"
  head -c 2000 /dev/urandom > "$RUN_DIR/payload/blob.bin"

  : > "$RUN_DIR/out"
  : > "$RUN_DIR/state"
}

# A config the action has to survive: a wildcard that would hijack the alias if the block were
# appended rather than written first, and a directive above the first Host line that is global and
# has to stay global. The copy in seed.config is what the post step gets diffed against.
seed_ssh_config() {
  cat > "$RUN_DIR/seed.config" <<'CONFIG'
ServerAliveCountMax 7

Host *
  User nobody
  ProxyCommand /nonexistent/corp-proxy %h %p
CONFIG

  cp "$RUN_DIR/seed.config" "$RUN_DIR/home/.ssh/config"
  chmod 600 "$RUN_DIR/home/.ssh/config"
}

install_shims() {
  printf '#!/bin/sh\nexec nc 127.0.0.1 %s\n' "$SSH_PORT" > "$RUN_DIR/bin/aws"
  printf '#!/bin/sh\nexit 0\n' > "$RUN_DIR/bin/session-manager-plugin"
  chmod +x "$RUN_DIR/bin/aws" "$RUN_DIR/bin/session-manager-plugin"

  # ssh, rsync and scp run in this shell, so the shim must win over any real aws CLI on PATH.
  export PATH="$RUN_DIR/bin:$PATH"
}

start_sshd() {
  "${DOCKER_CMD[@]}" build -q -t "$IMAGE_NAME" "$E2E_DIR" >/dev/null || die 'docker build failed.'
  "${DOCKER_CMD[@]}" rm -f "$CONTAINER_NAME" >/dev/null 2>&1

  "${DOCKER_CMD[@]}" run -d --rm \
    --name "$CONTAINER_NAME" \
    -p "127.0.0.1:$SSH_PORT:22" \
    -v "$RUN_DIR/remote_ssh:/home/ubuntu/.ssh" \
    "$IMAGE_NAME" >/dev/null || die 'docker run failed.'

  wait_for_port "$SSH_PORT" || die "sshd never came up on port $SSH_PORT."
}

start_stub() {
  AUTHORIZED_KEYS="$RUN_DIR/remote_ssh/authorized_keys" \
  STUB_PORT="$STUB_PORT" \
  KEY_TTL_MS="$KEY_TTL_MS" \
    node "$E2E_DIR/stub.mjs" > "$RUN_DIR/stub.log" 2>&1 &

  stub_pid=$!
  wait_for_port "$STUB_PORT" || die "stub never came up on port $STUB_PORT."
}

# The action reads these; env -i keeps the developer's real AWS config out of the run.
action_env() {
  echo "PATH=$PATH"
  echo "HOME=$RUN_DIR/home"
  echo "GITHUB_OUTPUT=$RUN_DIR/out"
  echo "GITHUB_STATE=$RUN_DIR/state"
  echo 'AWS_EC2_METADATA_DISABLED=true'
  echo 'AWS_ACCESS_KEY_ID=AKIAE2E'
  echo 'AWS_SECRET_ACCESS_KEY=secret'
  echo "AWS_ENDPOINT_URL_SSM=http://127.0.0.1:$STUB_PORT"
  echo "AWS_ENDPOINT_URL_EC2_INSTANCE_CONNECT=http://127.0.0.1:$STUB_PORT"
  echo "AWS_ENDPOINT_URL_STS=http://127.0.0.1:$STUB_PORT"
  echo "INPUT_INSTANCE-ID=$INSTANCE_ID"
  echo 'INPUT_OS-USER=ubuntu'
  echo "INPUT_HOST-ALIAS=$HOST_ALIAS"
  echo 'INPUT_REGION=eu-west-2'
  echo 'INPUT_PORT=22'
  echo 'INPUT_KEY-TYPE=ed25519'
  echo 'INPUT_PRIVATE-KEY='
  echo 'INPUT_CHECK-INSTANCE=true'
  echo 'INPUT_WAIT-TIMEOUT=30'
  echo 'INPUT_TERMINATE-SESSIONS=true'
  echo 'INPUT_CLEANUP=true'
}

# ---------------------------------------------------------------- checks

check_main_step() {
  local -a env_pairs=()
  local exit_code

  mapfile -t env_pairs < <(action_env)

  echo '== main =='
  env -i "${env_pairs[@]}" node "$REPO_DIR/dist/main/index.js" > "$RUN_DIR/main.log" 2>&1
  exit_code=$?

  ok 'main exits 0' "$exit_code" '0'
  sed -n 's/^::error:://p' "$RUN_DIR/main.log"
}

check_config_precedence() {
  local config="$RUN_DIR/home/.ssh/config"
  local value

  echo '== config precedence =='

  value="$(ssh -G -F "$config" "$HOST_ALIAS" 2>/dev/null | sed -n 's/^user //p')"
  ok 'alias resolves to the action user' "$value" 'ubuntu'

  value="$(ssh -G -F "$config" "$HOST_ALIAS" 2>/dev/null | grep -c '^proxycommand .*aws ssm start-session')"
  ok 'alias resolves to the SSM ProxyCommand' "$value" '1'

  # `Match all` closes the block's Host stanza. Without it the seeded global would be read as part of
  # that stanza and quietly stop applying to every other host.
  value="$(ssh -G -F "$config" other.example 2>/dev/null | sed -n 's/^serveralivecountmax //p')"
  ok 'seeded global still applies to other hosts' "$value" '7'

  value="$(ssh -G -F "$config" other.example 2>/dev/null | sed -n 's/^user //p')"
  ok 'seeded wildcard still applies to other hosts' "$value" 'nobody'
}

# Two jobs on one self-hosted runner share $HOME. Running the main step twice stands in for that: the
# paths once carried only the alias and the instance id, so the second run's ssh-keygen deleted the first
# run's key. Runs last, because it leaves a block and key material behind.
check_run_scope() {
  local first second before after

  echo '== concurrent runs =='

  first="$(main_step_key_path "$RUN_DIR/state.a" "$RUN_DIR/main.a.log")"
  # Shared paths leave a file behind either way, so compare the bytes rather than existence.
  before="$(sha256sum < "$first" 2>/dev/null | cut -d' ' -f1)"

  second="$(main_step_key_path "$RUN_DIR/state.b" "$RUN_DIR/main.b.log")"
  after="$(sha256sum < "$first" 2>/dev/null | cut -d' ' -f1)"

  ok 'each run gets its own key path' "$([[ -n "$first" && "$first" != "$second" ]] && echo differ)" 'differ'
  ok 'the second run leaves the first run key alone' "${after:-missing}" "${before:-unset}"
  ok 'the second run key exists' "$([[ -f "$second" ]] && echo yes)" 'yes'

  sed -n 's/^::error:://p' "$RUN_DIR/main.a.log" "$RUN_DIR/main.b.log"
}

# Runs the main step against its own state file and echoes the key path it recorded.
main_step_key_path() {
  local state_file="$1" log_file="$2"
  local -a env_pairs=()

  mapfile -t env_pairs < <(action_env)

  # The runner creates this file; @actions/core refuses to save state without it.
  : > "$state_file"

  # The trailing GITHUB_STATE wins over the one action_env sets, so each run records its own paths.
  env -i "${env_pairs[@]}" "GITHUB_STATE=$state_file" \
    node "$REPO_DIR/dist/main/index.js" > "$log_file" 2>&1

  sed -n '/^private-key-path<</{n;p;}' "$state_file"
}

check_transport() {
  local -a ssh_opts=( -F "$RUN_DIR/home/.ssh/config" -o BatchMode=yes )
  local output exit_code local_sum remote_sum socket_count

  echo '== the real transport =='

  output="$(ssh "${ssh_opts[@]}" "$HOST_ALIAS" whoami 2>"$RUN_DIR/ssh.err")"
  ok 'ssh runs a remote command as ubuntu' "$output" 'ubuntu'
  [[ -s "$RUN_DIR/ssh.err" ]] && head -3 "$RUN_DIR/ssh.err"

  output="$(ssh "${ssh_opts[@]}" "$HOST_ALIAS" 'echo $((6*7))' 2>/dev/null)"
  ok 'ssh returns remote stdout' "$output" '42'

  rsync -a -e "ssh ${ssh_opts[*]}" \
    "$RUN_DIR/payload/" "$HOST_ALIAS:/home/ubuntu/dest/" 2>"$RUN_DIR/rsync.err"
  exit_code=$?
  ok 'rsync push exits 0' "$exit_code" '0'
  [[ -s "$RUN_DIR/rsync.err" ]] && head -3 "$RUN_DIR/rsync.err"

  local_sum="$(sha256sum < "$RUN_DIR/payload/blob.bin" | cut -d' ' -f1)"
  remote_sum="$(ssh "${ssh_opts[@]}" "$HOST_ALIAS" \
    'sha256sum /home/ubuntu/dest/blob.bin' 2>/dev/null | cut -d' ' -f1)"
  ok 'rsync transferred bytes intact' "$remote_sum" "$local_sum"

  scp "${ssh_opts[@]}" "$HOST_ALIAS:/home/ubuntu/dest/app.txt" "$RUN_DIR/back.txt" >/dev/null 2>&1
  ok 'scp pull works' "$(cat "$RUN_DIR/back.txt" 2>/dev/null)" 'hello from the runner'

  socket_count="$(count_matching "$RUN_DIR/home/.ssh/*.sock")"
  if [[ "$EXPECT_MULTIPLEX" == 'yes' ]]; then
    ok 'ControlMaster socket created' "$((socket_count > 0 ? 1 : 0))" '1'
  else
    ok 'ControlMaster socket absent (path too long)' "$socket_count" '0'
  fi
}

# The runner exposes saved state as STATE_* variables; replay them for the post step.
replay_state() {
  # shellcheck disable=SC2016  # ${...} here is a JS template literal; the shell must not expand it
  node -e '
    const fs = require("node:fs")
    const text = fs.readFileSync(process.argv[1], "utf8")
    const pattern = /^(.+?)<<(ghadelimiter_[0-9a-f-]+)\n([\s\S]*?)\n\2$/gm
    const out = []
    let match
    while ((match = pattern.exec(text))) out.push(`STATE_${match[1]}=${match[3]}`)
    fs.writeFileSync(process.argv[2], out.join("\n"))
  ' "$RUN_DIR/state" "$RUN_DIR/state.env"
}

check_post_step() {
  local -a env_pairs=() state_pairs=()
  local exit_code block_count key_count

  echo '== post =='
  replay_state
  mapfile -t env_pairs < <(action_env)
  mapfile -t state_pairs < "$RUN_DIR/state.env"

  env -i "${env_pairs[@]}" "${state_pairs[@]}" \
    node "$REPO_DIR/dist/post/index.js" > "$RUN_DIR/post.log" 2>&1
  exit_code=$?
  ok 'post exits 0' "$exit_code" '0'

  block_count="$(grep -c 'setup-ssh-over-ssm-action' "$RUN_DIR/home/.ssh/config" 2>/dev/null)"
  ok 'config block removed' "${block_count:-0}" '0'

  key_count="$(count_matching "$RUN_DIR/home/.ssh/ssm-*")"
  ok 'key material deleted' "$key_count" '0'

  diff -q "$RUN_DIR/seed.config" "$RUN_DIR/home/.ssh/config" >/dev/null 2>&1
  ok 'pre-existing config restored byte for byte' "$?" '0'
}

report_stub_calls() {
  echo '== stub saw =='
  node -e '
    fetch(process.argv[1])
      .then((response) => response.text())
      .then((body) => console.log(body))
      .catch(() => {})
  ' "http://127.0.0.1:$STUB_PORT/__calls"
}

# ---------------------------------------------------------------- run

main() {
  check_prerequisites
  trap teardown EXIT

  build_workspace
  install_shims
  start_sshd
  start_stub

  check_main_step
  check_config_precedence
  check_transport
  check_post_step
  check_run_scope
  report_stub_calls

  echo
  echo "passed=$passed failed=$failed"
  [[ "$failed" -eq 0 ]]
}

main "$@"
