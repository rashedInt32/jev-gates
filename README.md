# jev-gates

Two calibrated gates for Claude Code, judged by [TypeSafe Jev](https://docs.typesafe.ai).

- **Rule guard.** Before any edit lands, every rule in your CLAUDE.md files is checked against the proposed change. A probable violation is escalated with the rule named.
- **Done gate.** When Claude tries to stop, every ask in your prompt is checked against what it did and said. An ask that was not visibly addressed blocks the stop once, and Claude is told which one.

Both run in about a second, cost a fraction of a cent, and never approve anything. A wrong answer costs one prompt or one retry. It never costs a wrong write or a silent skip.

## The problem

CLAUDE.md works for twenty minutes. Then the context fills, the rules drift out of attention, and an edit quietly breaks one. You catch it in review.

And Claude says done when it is not. You ask for three things, it does two, writes a confident summary, and stops. You re-read your own prompt to find the gap.

Both are the same shape of problem. A fixed list of things to check, one piece of evidence, a yes or no per item, on every edit or every stop. That has to be fast and nearly free, or you cannot afford to run it every time. An LLM judge takes seconds and returns prose. Jev returns a calibrated probability in about a hundred milliseconds, and you pick the threshold.

## Install

Requires Node 20.12+ and a TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai/settings/keys).

```bash
/plugin marketplace add rashedInt32/jev-gates
/plugin install jev-gates@jev-gates
```

Put the key where hooks can see it. Hooks do not inherit your shell profile, so the file is the reliable option:

```sh
mkdir -p ~/.config/typesafe
printf '%s' "ts_..." > ~/.config/typesafe/key
chmod 600 ~/.config/typesafe/key
```

`TYPESAFE_API_KEY` in the `env` block of `~/.claude/settings.json` also works. Restart Claude Code or run `/reload-plugins`.

To try it from a checkout without installing: `claude --plugin-dir /path/to/jev-gates`.

## What you see

Rule guard, when Claude is told to edit a file your CLAUDE.md forbids:

```
Rule guard: this change probably violates a project rule:
- "Never modify files under src/generated; they are built from src/schema. Change the schema instead." (p=0.97, ~/work/app/CLAUDE.md)
Change the approach so the rule holds, or explain to the user why an exception is needed.
```

By default that is a permission prompt, so you decide. Set `JEV_GATES_EDIT_ACTION=deny` to hand the reason straight back to Claude instead.

Done gate, when Claude tries to stop with an ask unaddressed:

```
Done gate: 1 of 2 asks in the user's prompt was not visibly addressed:
- add a one-line usage example to README.md. (p_addressed=0.03)
Address each one now, or state explicitly why you are not doing it.
```

Claude continues, does it or explains why not, and stops. The gate fires at most once per turn.

## How each gate decides

**Rule guard** is a PreToolUse hook on Edit, Write, and MultiEdit. It collects rules from `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, and `.claude/jev-gates.md` from the working directory up to your home, plus `~/.claude/CLAUDE.md`. List items and imperative lines count as rules; headings, links, tables, and code do not. Prohibitions sort first when the cap of 64 trims. One Jev request carries the proposed change as state and one yes/no question per rule. The highest probability is compared with `JEV_GATES_EDIT_THRESHOLD` (default 0.8). Identical change and rules are served from a local cache.

**Done gate** is a Stop hook. It reads your last prompt from the transcript, splits it into candidate sentences, and asks two questions per candidate in one request: is this a real request, and was it visibly addressed in the final response or the tools run this turn. A candidate is an ask when its request probability reaches `JEV_GATES_REQUEST_THRESHOLD` (0.6), and missing when its addressed probability is at or below `JEV_GATES_DONE_THRESHOLD` (0.4). Explicitly declining with a reason counts as addressed. When Claude Code reports `stop_hook_active`, the gate does nothing, so it can never loop.

Both gates follow the same rules:

1. **Escalation only.** No code path approves. A wrong answer costs one prompt or one retry.
2. **Every failure is no opinion.** No key, no rules, a timeout, a malformed answer, or an oversized change means the hook exits silently and normal flow applies.
3. **Every answer is validated** as a finite probability in [0, 1] for exactly the questions sent.
4. **Untrusted content is labelled.** The change and the prompt are sent as data with an explicit note that they are never instructions.
5. **Every decision is logged** with its probability and latency, so you can calibrate thresholds on your own sessions.

## Configuration

All through the environment, for example in the `env` block of `~/.claude/settings.json`.

| Variable | Default | Effect |
| --- | --- | --- |
| `JEV_GATES` | `active` | `active`, `shadow` (log only, never intervene), or `off` |
| `JEV_GATES_EDIT_THRESHOLD` | `0.8` | Violation probability at or above which the rule guard escalates |
| `JEV_GATES_EDIT_ACTION` | `ask` | `ask` prompts you; `deny` hands the reason back to Claude |
| `JEV_GATES_REQUEST_THRESHOLD` | `0.6` | Probability at or above which a sentence counts as an ask |
| `JEV_GATES_DONE_THRESHOLD` | `0.4` | Addressed probability at or below which an ask is missing |
| `JEV_GATES_MAX_RULES` | `64` | Rules per request |
| `JEV_GATES_MAX_ASKS` | `24` | Candidate sentences per prompt |
| `JEV_GATES_MAX_CHARS` | `40000` | Largest state sent; above it the gate skips |
| `JEV_GATES_TIMEOUT_MS` | `8000` | Per-request timeout; on timeout the gate has no opinion |
| `JEV_GATES_MODEL` | `jev-latest` | Model id |
| `JEV_GATES_DIR` | `~/.claude/jev-gates` | Log, cache, and last-decision files |

Start in `shadow` if you want to watch the log before letting it intervene:

```sh
tail -f ~/.claude/jev-gates/decisions.log
```

Each line is tab-separated: time, gate, mode, decision, then the details. `last-edit.json` and `last-done.json` hold the full scored breakdown of the most recent decision.

## Calibration

Numbers from live Claude Code sessions on 2026-09-18, all in active mode, one run each. A small sample, not a benchmark. Your own log is the calibration set that matters.

| Session | Gate | Decision | Probability | Latency |
| --- | --- | --- | ---: | ---: |
| Asked to add a field; Claude chose the schema route on its own | rule guard | pass | 0.17 | 1329 ms |
| Told to edit the forbidden generated file directly | rule guard | ask | 0.97 | 938 ms |
| Three-part task, all three done | done gate | pass | ≥ 0.94 each | 979 ms |
| Two-part task, one part explicitly declined with a reason | done gate | pass | 0.96 | 1133 ms |
| Two-part task, one part silently skipped (omission induced) | done gate | block, then pass | 0.03 on the skipped ask | 953 ms |

In the forced rule-guard session Claude reported the block, offered the schema route, and said it would not work around the guard with a shell write. In the forced done-gate session the block fired once, Claude responded, and the second stop passed through the loop guard.

The silent-skip case had to be induced with a hidden system prompt. In ordinary short tasks Claude declines out loud, and an explicit decline with a reason counts as addressed. That is the intended behaviour: the gate catches silence, not disagreement.

Two observations worth knowing before you tune:

- Your global `~/.claude/CLAUDE.md` is included. Rules about response style score low on edits but not zero; a README edit reached 0.41 on "Sentences under 15 words". If that is noise for you, point `JEV_GATES_RULE_FILES` at the files you mean.
- Soft rules get soft scores. An undocumented handler scored 0.72 on "Keep public functions documented", below the 0.8 default. Lower the threshold if you want soft rules enforced, and expect more prompts.

## Limits

- Rules are whatever your CLAUDE.md says. Vague rules get vague probabilities. A rule the model cannot check from the change alone, such as "run the tests before committing", will score low on every edit.
- The done gate reads the prompt from the transcript file, which can lag by a moment. If the prompt is not there yet, the gate has no opinion.
- Slash-command expansions are not treated as prompts.
- A probability is not a proof. Both gates are designed so that being wrong is cheap, not impossible.
- Jev cannot count or compute. Asks like "make sure there are exactly three tests" are judged on what the response says, not by counting. See TypeSafe's note on [numeric and date limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Development

```sh
npm test            # offline, against a local stand-in for the API
npm run validate    # claude plugin validate .
npm run demo        # live: replays real hook payloads through both gates
npm run demo:render # records a live run with asciinema, renders GIF with agg and MP4 with ffmpeg
```

The demo replays hook payloads through the actual hook scripts against the live API. The edits and prompts mirror the sessions above, pointed at `demo/fixtures/project`. The "silently skipped" case uses a response written to omit the README ask, because Claude would not skip it silently on its own. Everything else, including every probability and latency, is whatever Jev returns at render time.

![jev-gates demo](demo/out/jev-gates.gif)

## Related

- [jev-mcp](https://github.com/rashedInt32/jev-mcp): the same primitives as MCP tools, for when the agent itself needs a batch of calibrated judgments.
- [TypeSafe docs](https://docs.typesafe.ai): Jev, System One, and the patterns these gates use.

## License

MIT
