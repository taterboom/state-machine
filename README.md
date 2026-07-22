# state-machine

A Claude Code skill that structures a small script — scraper, data pipeline, job poller, retry loop — as a tiny **declarative state machine** so it stays readable months later.

The pattern is three layers:

- **machine** — pure data: what states exist, which event goes where
- **runtime** — pure transition engine: look up → switch state → hand to log
- **log** — all observation: single-line transition log + a live ASCII state diagram

Side effects live at the call site (no `onEnter`), so control flow stays visible. The skill also gates itself: if your script is a linear pipeline (`fetch → parse → transform → write`), it tells you to just write plain functions instead of forcing a state machine.

The reference is written in TypeScript ([`skills/state-machine/references/example.ts`](skills/state-machine/references/example.ts)), but it's a **shape reference** — the skill picks the language that best fits your project (Python, TS/JS, Go, Bash…) and translates while keeping the design contract intact.

## Install

```
npx skills add taterboom/state-machine
```

Add `-g -y` to install globally (user-level) without prompts:

```
npx skills add taterboom/state-machine -g -y
```

## License

MIT
