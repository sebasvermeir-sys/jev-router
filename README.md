# jev-router

Before Claude works on your prompt, this mod asks **TypeSafe Jev** which Claude
model the prompt really needs (Haiku, Sonnet or Opus).

## Modes (pick in `/config` → jev-router: Mode)

- **auto** (default): the turn runs on Jev's pick, no click. It changes the
  model of each request in that turn; the model picker keeps showing your own
  choice, the band shows what really ran.
- **advise**: only shows the advice, with a **Use X next** button (runs `/model`).
- **off**: does nothing.

## What you see

`Jev → Haiku (95%) · chat is small, switching is cheap · 210 ms  [Hide]`

## When it switches (auto) or offers to (advise)

- **Up** (to a bigger model): whenever Jev is 45%+ sure. Quality first.
- **Down** (to a smaller model): only when Jev is 70%+ sure **and** switching is
  cheap: the chat is still small (under ~20k tokens), or its cache went cold
  (idle about an hour) and the chat is under 100k tokens.
- Otherwise it stays on the model that answered last, so the cache stays warm.
- Subagents are left alone.

## Install

You need Claude Code (the desktop app or the terminal) and your own TypeSafe
Jev API key. No key is included here.

**In a terminal session**, at the prompt:

```
/plugin install jev-router --marketplace sebasvermeir-sys/jev-router
```

Answer `y` to add the marketplace, pick the **user** scope (Enter), choose a
mode (keep **auto**). From a shell instead:

```
claude plugin install jev-router --marketplace sebasvermeir-sys/jev-router
```

**In the desktop app**, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`sebasvermeir-sys/jev-router`, then **Add plugin**.

Then add your key (next section) and open a new chat.

## Setup: the API key

The key never goes in a chat. The mod looks in two places, in this order:

1. **macOS Keychain (recommended).** In Terminal, run the line below. It asks for
   the key without showing it, so it never lands in your shell history:

   ```
   security add-generic-password -a "$USER" -s typesafe-jev -w
   ```

2. **A file:** `~/.jev/api_key` containing only the key.

Get a key at https://console.typesafe.ai/.

## Files

| File | What it is |
|---|---|
| `hooks/register.tsx` | The mod itself: the prompt hook, the Jev call, the band |
| `types/index.d.ts` | The shape of the values the band shows |
| `.claude-plugin/plugin.json` | The mod's name card |
| `~/.jev/router-log.jsonl` | One line per prompt: Jev's pick, confidence, speed |

## Rules it follows

- Jev gets 1.5 s. Slower, down, or no key: your prompt goes on unchanged.
- It skips slash commands, hidden prompts and other plugins' prompts.
- Only the first 4,000 characters of a prompt are sent to Jev.

## Privacy

With this mod on, every prompt you type is also sent to TypeSafe. Turn the mod
off for sensitive work.

## jev-monitor (optional companion)

A collapsible band above the prompt that shows jev-router at work, read from
`~/.jev/router-log.jsonl` (local only, no network):

- **Collapsed:** `▸ Jev`, the mode, and the last pick → model used, e.g. `Haiku 92 % → Opus`
- **Expanded** (click `▸ Jev` or type `/jev`): last prompt in detail, the Haiku / Sonnet / Opus
  split of Jev's picks, model switches, average latency, and the last 12 prompts.

It draws above the other plugins' bands (e.g. Ribbon) without hiding them.

Install: `/plugin install jev-monitor@jev-router` (desktop app: + → Plugins).
