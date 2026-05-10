# @chest-gate/install

[![npm](https://img.shields.io/npm/v/@chest-gate/install.svg)](https://www.npmjs.com/package/@chest-gate/install)
[![license](https://img.shields.io/npm/l/@chest-gate/install.svg)](./LICENSE)

> One-command installer for [Chest Gate](https://chest.sh) skills. Resolves a slug against the public registry, fetches the source from GitHub, drops it in the right runtime folder, runs `npm install`, and prompts for a Chest API key.

## Install + run

No prior install required — invoke directly with `npx`:

```bash
npx -y @chest-gate/install <slug>
```

Example:

```bash
npx -y @chest-gate/install trading-decision
```

## What it does

1. **Resolve.** GETs `https://gate.chest.sh/api/apps/<slug>` and reads the manifest (kind, sourceUrl, install hints).
2. **Fetch.** Shallow-clones the source repo (parsed from the manifest's GitHub `tree` URL) into a temp directory.
3. **Install.** Copies the skill subpath into `~/.claude/skills/<name>` (folder name read from `SKILL.md` frontmatter, falling back to the source folder).
4. **Bootstrap.** Runs `npm install` if the skill ships a `package.json`.
5. **Auth.** Prompts you to paste a Chest agent token (a `ca_live_…` value or full JSON), saves it to `~/.chest/agent-token.json` with `0600` perms. Skipped if `CHEST_API_KEY` is set or the file already exists. (Legacy `~/.chest/auth.json` is still recognised.)
6. **Done.** Prints the App's `next steps` block.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `CHEST_API` | `https://gate.chest.sh` | Override the registry endpoint. |
| `CHEST_HOME` | `~/.claude/skills` | Override the install root. Useful for testing or for non–Claude Code agents. |
| `CHEST_API_KEY` | — | If set to a `ca_live_…` token, the post-install auth prompt is skipped. |

## Requirements

- Node.js ≥ 20
- `git` on PATH (the installer shells out to `git clone`)
- `npm` (only used if the skill ships a `package.json`)

Zero runtime dependencies — uses only Node built-ins, `git`, and `npm`.

## Manifest contract

For a slug to be installable through this CLI, its chest.sh App manifest must include:

- `kind: "skill"` (other kinds aren't supported yet — `plugin`, `mcp` coming soon)
- `sourceUrl`: a GitHub `tree` URL pointing at the package folder, e.g. `https://github.com/chesthq/apps/tree/main/skills/trading-decision`

App authors set both at publish time via the chest.sh dashboard or the publishing API.

## Related

- [`@chest-gate/sdk`](https://www.npmjs.com/package/@chest-gate/sdk) — the underlying `paidFetch()` primitive that installed skills use
- [`@chest-gate/mcp`](https://www.npmjs.com/package/@chest-gate/mcp) — MCP server exposing chest.sh APIs as tools
- [`chesthq/apps`](https://github.com/chesthq/apps) — copy-paste skills, plugins, and upstream APIs

## License

MIT © Chest Gate
