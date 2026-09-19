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

There is no test suite, deliberately. Verify changes by running the bundles directly with the `INPUT_*`
environment variables the runner would set.

Run `pnpm run lint` after every change under `src/`. `.github/workflows/lint.yaml` runs it on pushes to
`main` and on pull requests. It does not build, and it does not check that `dist/` matches `src/`.

## Code style

- No comments that restate what the code does. Comment only non-obvious behaviour: the 60-second EC2
  Instance Connect key window, the session-ownership filter in the post step, why `ProxyCommand` must stay
  the AWS CLI rather than an SDK call.
- No historical or explanatory prose in code.
- Small functions, early returns, no deep nesting.
- Fail fast with messages that name what was received, what was expected, and the fix.
- Never log key material, session tokens, or full AWS responses at info level.
