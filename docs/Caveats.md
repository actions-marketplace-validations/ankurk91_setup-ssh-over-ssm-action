# Caveats

Be aware of these before adopting this action.

- **Session Manager's keystroke logging does not apply.** `AWS-StartSSHSession` is an opaque encrypted
  tunnel: SSH encrypts everything inside the TLS connection, and Session Manager only moves bytes. S3 and
  CloudWatch session logging capture nothing useful, and CloudTrail records only that a session started, not
  what ran inside it. AWS states this directly in the Session Manager documentation. If command-level audit
  matters to you, SSM Run Command is the better primitive — it logs each command and its output.
- **Throughput is lower than a direct connection.** Traffic is relayed through the Session Manager WebSocket
  rather than flowing point to point. Tens of megabytes are fine. Multi-gigabyte artifacts are painful. For
  large builds, push the artifact to S3 from the runner and pull it down on the instance instead.
- **`sshd` is back in your threat model.** This does not remove SSH, it changes how you reach it. You still
  have a second authentication path to patch, configure and monitor.
- **The sixty-second key window.** EC2 Instance Connect holds the pushed key in instance metadata for sixty
  seconds. That window only needs to cover the handshake of the *first* connection; an established session
  survives well past it. But a step that opens a *new* connection more than a minute after this action ran
  will fail with a permission denied error that does not obviously point at key expiry.

  To reduce the damage, the SSH block enables connection multiplexing by default:

  ```
  ControlMaster auto
  ControlPath ~/.ssh/ssm-<run token>.sock
  ControlPersist 1h
  ```

  The first `ssh` or `rsync` opens a master connection; every later invocation reuses that socket instead of
  re-authenticating, so the expired key stops mattering. This is on by default because the failure it
  prevents is common and the error message is unhelpful. It does not help if the *first* connection happens
  more than sixty seconds after the action runs, or if the master sits idle past `ControlPersist` — put the
  action immediately before the steps that use it, or use the `private-key` input with a key you manage if
  your pipeline has long gaps. The post step closes
  the master with `ssh -O exit`.
- **Session cleanup matches an exact marker.** The `ProxyCommand` stamps every session this run opens with
  `--reason setup-ssh-over-ssm-action/<run id>/<attempt>/<token>`, and the post step terminates only the
  sessions carrying that value, so concurrent jobs sharing a role, a runner and an instance never touch each
  other's tunnels. The marker also names the originating run in the Session Manager console and in
  CloudTrail. Set `terminate-sessions: false` to skip cleanup entirely.
- **Concurrent jobs on a shared runner need distinct aliases.** The key, the public key, the known_hosts
  file and the control socket are named per run, so jobs that overlap on one self-hosted runner never write
  over each other's key material. The `~/.ssh/config` block is not: it is keyed on `host-alias` alone, so
  two jobs using the same alias under the same `HOME` share one block, and the first post step to finish
  removes it from under the other. Give each concurrent job its own `host-alias`. The action logs a warning
  when it replaces a block that was already there.
- **Linux only.** No Windows runners, no macOS runners, no Windows instances.
