---
title: Pass a host key to a script
permalink: /how-to/script-env
diataxis: how-to
---

# Pass a host key to a script

A script does not inherit your shell environment. It sees process basics (`PATH`, `HOME`, locale), a few `JAIPH_*` contract keys, and nothing else — not `GITHUB_TOKEN`, not agent API keys. To put one host key into that subprocess you do two things: the script **requests** it with `use`, and you **grant** it with `--env`. Host presence alone is not a grant.

This page is the recipe. The key list and error codes live in [Environment variables](env-vars.md#script-env). Why the two steps exist — and that they are spawn-env guardrails, not a sandbox — is in [Why Jaiph](why-jaiph.md).

## Prerequisites

- An entry file with `export def main` that `run`s a named script, an `import script`, or a named prompt that needs a host key.
- The key already exists on the host, or you will pass an explicit `--env KEY=VALUE`.

## 1. Request the key on the declaration

Put `use` on the script (or named prompt) that must see the key. Not on the `run` line, not on a `def`, not on an anonymous `prompt "…"`.

```jaiph
script release use GITHUB_TOKEN = `gh release create "$1"`

export def main(tag) {
  run release(tag)
}
```

The same clause works on `import script "./gh.sh" as gh use GITHUB_TOKEN` and on `prompt analyze(log) use GITHUB_TOKEN = "…"`. Identifiers only — no quotes, no `${…}`.

A free-form shell line in a def body has no declaration, so it cannot carry `use`. Move that line into a named `script` if it needs a secret.

## 2. Grant it on the command line

```bash
export GITHUB_TOKEN="…"
jaiph run --env GITHUB_TOKEN release.jh
```

`--env GITHUB_TOKEN` forwards the host value. `--env GITHUB_TOKEN=VALUE` sets an exact value (first `=` splits). Repeat `--env` for each key.

`jaiph serve` and `jaiph mcp` take the same flag at **startup**. That grant applies to every call for the server's life. Extra `--env` keys nothing `use`s are allowed.

## 3. Keep the key off everything else

Only the declaration that `use`s the key receives it.

- The runner process itself does not carry `--env` values. A `--env KEY[=VALUE]` value is injected only into a subprocess whose declaration `use`s that key; it is never placed on the workflow-leader (runner) process environment, so a step, prompt, or def that does not `use` the key cannot read it there either. The workflow leader is built from an allowlist (process basics, `JAIPH_*` control keys, backend credentials), not a copy of your shell — an ungranted host key is absent from it.
- Another script in the same def, with no `use GITHUB_TOKEN`, does not see it.
- An anonymous `prompt "…"` never receives `--env` secrets. A named prompt does, and only for keys it `use`s.
- Backend credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, `OPENAI_API_KEY`) stay the prompt default. Do not write them as `use`.
- Runner keys (`JAIPH_CHAIN_KEY`, `JAIPH_RUN_SUMMARY_FILE`, `JAIPH_WORKSPACE`, …) are reserved. `use` or `--env` of those names is `E_ENV_RESERVED`.

`jaiph test` does not pre-flight missing `--env`. Pass `--env` on `jaiph test` when a real (unmocked) script must see the key.

These rules apply to the environment Jaiph builds for each child. They are not a sandbox. A `cursor` or `claude` `prompt` that can run tools runs as the same user as `jaiph`. It can open the workspace, `$HOME`, and other processes that user owns. A key that is absent from the agent's own environment can still sit on disk or in another live process. To keep a token away from an agent, do not start a `prompt` in the same run as the script that needs it. A dedicated user or container keeps Jaiph off the rest of your session; it does not split agent from script inside one run. See [Deploy jaiph — Dedicated user or container](deploy.md#dedicated-user-or-container). Why the two steps exist, and this limit, is in [Why Jaiph](why-jaiph.md).

## Verification

1. Run without the flag: `jaiph run release.jh`. Expect `E_ENV_MISSING` naming `GITHUB_TOKEN` before the runner starts.
2. Run with the flag: `jaiph run --env GITHUB_TOKEN release.jh`. The script that `use`s the key can read `$GITHUB_TOKEN`. A second script in the same file with no `use` must not print that value.
3. Confirm a reserved name fails closed: `script leak use JAIPH_CHAIN_KEY = \`…\`` is `E_ENV_RESERVED` at parse.

## Related

- [Environment variables — Script subprocess environment](env-vars.md#script-env) — sterile base set, reserved names, `E_ENV_*`.
- [Language — Subprocess environment](language.md#subprocess-environment) — what a `run` of a script vs a def vs a shell line sees.
- [Configuration — Script env keys](configuration.md#trusted-envs) — `trusted_envs` is gone; `use` + `--env` replaced it.
- [Authenticate agent backends](agent-auth.md) — backend credentials, not `--env`.
- [Deploy jaiph](deploy.md) — container, pod, or a dedicated user you create; the installer does not.
- [Why Jaiph](why-jaiph.md) — why request and grant are separate, and that this is not a sandbox.
