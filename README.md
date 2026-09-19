# Setup SSH over AWS SSM Action

A GitHub Action that configures the runner so ordinary `ssh`, `rsync`, `scp`, `git` and Ansible can reach a
private Linux EC2 instance through AWS Systems Manager Session Manager.

## What this is and why

Deploying to an EC2 instance from CI normally means one of two things: opening port 22 to a range of GitHub's
egress addresses, or keeping a long-lived SSH private key in repository secrets. The first widens the attack
surface of every instance you deploy to; the second creates a credential that never rotates and grants shell
access to anyone who can read the secret. This action avoids both. It tunnels SSH through Session Manager, so
the instance needs no inbound security group rule and no public IP, and it mints a fresh SSH key for each job
that EC2 Instance Connect installs on the instance for sixty seconds. After the job ends, the post step
removes the SSH config it wrote, deletes the key, and terminates the sessions it opened.

## Prerequisites

**On the runner**

- **AWS CLI v2** and the **Session Manager plugin** on `PATH`. Both come preinstalled on GitHub-hosted Ubuntu
  runners, at versions well past the plugin's 1.1.23.0 minimum, so there is nothing to install. On self-hosted
  runners add them with [`ankurk91/install-aws-cli-action`](https://github.com/ankurk91/install-aws-cli-action)
  and [`ankurk91/install-session-manager-plugin-action`](https://github.com/ankurk91/install-session-manager-plugin-action).
- A Linux runner. This action writes `~/.ssh/config` and shells out to `ssh-keygen`.

**On the instance**

- **Linux only.** Windows and macOS instances are not supported.
- **`sshd` must be running.** You can close the inbound port entirely; Session Manager reaches `sshd` from
  inside the instance.
- **SSM Agent version 2.3.672.0 or later.** This is the minimum AWS documents for SSH connections through
  Session Manager. Older agents register fine in SSM but cannot serve `AWS-StartSSHSession`.
- **The `ec2-instance-connect` package and its `sshd` hook**, unless you supply your own key through the
  `private-key` input. The package installs an `AuthorizedKeysCommand` that reads the pushed key out of
  instance metadata:

  ```
  AuthorizedKeysCommand /opt/aws/bin/eic_run_authorized_keys %u %f
  AuthorizedKeysCommandUser ec2-instance-connect
  ```

  It ships preinstalled on the AL2023 standard AMI, Amazon Linux 2 version 2.0.20190618 or later, and **Ubuntu 20.04 or
  later**. Install it manually on the AL2023 minimal and ECS-optimized AMIs, on CentOS
  Stream 8/9 and RHEL 8/9, and on Ubuntu 16.04 and 18.04 (`sudo apt-get install ec2-instance-connect`).

  If you already set `AuthorizedKeysCommand` for something else, the package will not overwrite it and EC2
  Instance Connect will not work. Use the `private-key` input instead.

## Usage

```yaml
name: Deploy

on:
  push:
    branches: [ main ]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.AWS_IAM_ROLE_ARN }}
          aws-region: us-east-1

      - uses: ankurk91/setup-ssh-over-ssm-action@v1
        with:
          instance-id: i-0123456789abcdef0

      - run: ssh ssm-target 'uptime'
```

`configure-aws-credentials` exports `AWS_REGION`, so the `region` input is optional when it runs first.

## Use cases

**Deploying a release with `rsync`**

```yaml
- uses: ankurk91/setup-ssh-over-ssm-action@v1
  with:
    instance-id: i-0123456789abcdef0

- run: rsync -az --delete ./build/ ssm-target:/var/www/app/current/

- run: ssh ssm-target 'sudo systemctl reload nginx'
```

**Running remote commands over `ssh`**

```yaml
- uses: ankurk91/setup-ssh-over-ssm-action@v1
  with:
    instance-id: i-0123456789abcdef0
    host-alias: app-server

- run: |
    ssh app-server 'cd /srv/app && ./bin/migrate --no-interaction'
    ssh app-server 'sudo systemctl restart app.service'
```

Because the action writes a host alias into `~/.ssh/config` rather than wrapping any particular tool,
anything that speaks SSH picks it up without modification:

```yaml
- run: scp ./config/production.env ssm-target:/srv/app/.env
- run: git -C /srv archive --remote=ssm-target:/srv/repo.git HEAD
- run: ansible-playbook -i inventory.yml site.yml   # ansible_host: ssm-target
```

## Inputs

| Input                | Required | Default                                 | Description                                                                                  |
|----------------------|----------|-----------------------------------------|----------------------------------------------------------------------------------------------|
| `instance-id`        | yes      | —                                       | Target instance, e.g. `i-0123456789abcdef0`. Hybrid `mi-` nodes need `private-key`           |
| `os-user`            | no       | `ubuntu`                                | Remote user to log in as. Use `ec2-user` on Amazon Linux                                     |
| `host-alias`         | no       | `ssm-target`                            | Name downstream steps use, as in `ssh ssm-target`. Must not already exist in `~/.ssh/config` |
| `region`             | no       | `AWS_REGION`, then `AWS_DEFAULT_REGION` | Region the instance runs in                                                                  |
| `port`               | no       | `22`                                    | SSH port on the instance                                                                     |
| `key-type`           | no       | `ed25519`                               | Type of key to generate. `ed25519`, or `rsa` at 4096 bits                                    |
| `private-key`        | no       | —                                       | Use your own OpenSSH key instead of an ephemeral one. Skips EC2 Instance Connect             |
| `check-instance`     | no       | `true`                                  | Verify the instance is Online in SSM before configuring SSH                                  |
| `wait-timeout`       | no       | `30`                                    | Seconds to wait for the instance to come Online. `0` fails immediately instead of waiting    |
| `terminate-sessions` | no       | `true`                                  | When the job ends, close the SSM sessions it opened                                          |
| `cleanup`            | no       | `true`                                  | When the job ends, remove the `~/.ssh/config` block and delete the key                       |

Booleans accept `true`, `True` or `TRUE`, and their false counterparts.

All inputs are validated before any AWS call. Values that end up in a file or a command are rejected if they
contain whitespace, quotes or shell metacharacters.

## Outputs

| Output            | Description                                   |
|-------------------|-----------------------------------------------|
| `host`            | The SSH host alias to use in downstream steps |
| `os-user`         | The resolved remote user                      |
| `key-path`        | Absolute path to the private key              |
| `ssh-config-path` | Absolute path to the modified SSH config      |

## IAM permissions

Two roles are involved: the role the workflow assumes, and the instance profile on the EC2 instance. The
policies, and the three mistakes that cause most failures, are in **[docs/IAM.md](docs/IAM.md)**.

## Advantages

- No inbound security group rule at all. Port 22 can stay closed to everything.
- No public IP and no bastion host. Works identically for instances in private subnets.
- No long-lived SSH key in repository secrets. Nothing to rotate, nothing to leak.
- The key that is installed is ephemeral and valid for sixty seconds.
- Every session start is recorded in CloudTrail against the identity that opened it.
- Downstream tooling needs zero modification. `ssh`, `rsync`, `scp`, `git` and Ansible all work unchanged
  because the alias lives in `~/.ssh/config`.

## Caveats

Be aware of these before adopting it.

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
  ControlPath ~/.ssh/ssm-<alias>-<instance-id>.sock
  ControlPersist 8h
  ```

  The first `ssh` or `rsync` opens a master connection; every later invocation reuses that socket instead of
  re-authenticating, so the expired key stops mattering. This is on by default because the failure it
  prevents is common and the error message is unhelpful. It does not help if the *first* connection happens
  more than sixty seconds after the action runs — put the action immediately before the steps that use it,
  or use the `private-key` input with a key you manage if your pipeline has long gaps. The post step closes
  the master with `ssh -O exit`.
- **Session cleanup is a heuristic.** The post step terminates only sessions whose owner matches this job's
  caller identity *and* whose start time is at or after the moment the main step began. On a shared
  self-hosted runner, two concurrent jobs assuming the same role with the same role session name are
  indistinguishable by owner alone, which is why the timestamp filter exists. It errs toward leaving sessions
  alone rather than killing a concurrent job's tunnel. Set `terminate-sessions: false` to skip it entirely.
- **Linux only.** No Windows runners, no macOS runners, no Windows instances.

## Links

- [AWS: allow SSH connections through Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html)
- [AWS: install the Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- [AWS API reference:
  `SendSSHPublicKey`](https://docs.aws.amazon.com/ec2-instance-connect/latest/APIReference/API_SendSSHPublicKey.html)
- [`ankurk91/install-session-manager-plugin-action`](https://github.com/ankurk91/install-session-manager-plugin-action)
- [`ankurk91/install-aws-cli-action`](https://github.com/ankurk91/install-aws-cli-action)


## License

[MIT](LICENSE.txt)
