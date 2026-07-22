# state-machine

A Claude Code skill that structures a small script — scraper, data pipeline, job poller, retry loop — as a tiny **declarative state machine** so it stays readable months later.

The pattern is three layers:

- **machine** — pure data: what states exist, which event goes where
- **runtime** — pure transition engine: look up → switch state → hand to log
- **log** — all observation: single-line transition log + a live ASCII state diagram

Side effects live at the call site (no `onEnter`), so control flow stays visible. The skill also gates itself: if your script is a linear pipeline (`fetch → parse → transform → write`), it tells you to just write plain functions instead of forcing a state machine.

The reference lives in [`skills/state-machine/references/`](skills/state-machine/references/) as four files — `machine.json` (pure-data definition), `machine-runtime.ts` (transition engine), `log.ts` (observation + `render()`), `main.ts` (usage). It's a **shape reference**, not a mandate to use TypeScript: the machine definition is always **pure data in a separate `machine.json`**, and the skill picks the language that best fits your project (Python, TS/JS, Go, Bash…) while keeping the design contract intact.

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
