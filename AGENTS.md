# AGENTS.md

## Layout

```
action.yml        Action metadata. Points at dist/main/index.js and dist/post/index.js.
src/              Source. ESM, plain JavaScript, Node 24.
  main.js         Main step entry point.
  post.js         Post step entry point.
  lib/            Shared modules. Each file opens with a line saying what it holds.
    inputs.js     Reads and validates every input.
    keys.js       ssh-keygen wrapper and private key masking.
    ssh-config.js The managed ~/.ssh/config block: render, upsert, remove.
    aws.js        AWS SDK v3 control-plane calls.
    state.js      State keys shared between the main and post steps.
dist/             Committed ncc bundles. Generated — never edit by hand.
test/e2e/         End-to-end rig: Dockerfile (sshd), stub.mjs (AWS stand-in), run.sh.
```

## Build

```sh
pnpm install
pnpm run build
```

That runs `ncc build src/main.js -o dist/main` and `ncc build src/post.js -o dist/post`.

* Don't commit anything unless asked
* **Any change under `src/` must be rebuilt and `dist/` committed in the same
  commit.** GitHub runs the
  committed bundle, not the source, so a `src/` change without a matching `dist/` change ships nothing.

## Tests and linting

Run `pnpm run lint` after every change under `src/`. `.github/workflows/lint.yaml` runs it on pushes to
`main` and on pull requests. It does not build, and it does not check that `dist/` matches `src/`.

There is no unit test suite. `test/e2e/run.sh` drives the built bundles against a real sshd in Docker, with
the AWS control plane stubbed, so ssh, rsync and scp exercise the `~/.ssh/config` the action actually wrote:

```sh
pnpm run build && test/e2e/run.sh
```

Pass `DOCKER='sudo docker'` if Docker needs root. `.github/workflows/tests.yaml` runs it on pushes to `main`
and on pull requests across three scenarios: the default alias, a 64-character alias, and a `HOME` deep
enough to force connection multiplexing off. Run it locally after changing the SSH config block, the key
handling or the post step.

## Code style

- No comments that restate what the code does. Comment only non-obvious behaviour: the 60-second EC2
  Instance Connect key window, the session marker the post step matches on, why `ProxyCommand` must stay
  the AWS CLI rather than an SDK call.
- No historical or explanatory prose in code.
- Small functions, early returns, no deep nesting.
- Fail fast with messages that name what was received, what was expected, and the fix.
- Never log key material, session tokens, or full AWS responses at info level.
