# jev-gates 0.7 spec

Status: built and verified 2026-09-24. Extends 0.6.0.

## Why

Measured on the author's machine, 2026-09-24:

- The intent guard ran on 590 prompts in six days and waited 1,060 ms on average. It added its note on 113 of them. On the rest, the Jev answer was used by nothing but the log.
- Of each call, about 650 ms is connection setup: TCP connect about 290 ms, TLS about 310 ms. The same request over a warm connection takes 350 to 450 ms. Every hook opens a fresh connection, so every gate pays setup on every call. The server keeps an idle connection for at least 90 s; Node's built-in `fetch` drops it after about 4 s.
- `~/.claude/hooks/jev-guard.sh`, a separate Bash risk hook, sent raw commands to Jev and wrote them unredacted to its log. One logged command carried a full `Api-Key` header value.
- The shell write detector scanned quoted text and treated git subcommands and flag values as file paths. `echo "a > b"` read as a write to `b`, and `git stash push -m msg` read as writes to `push` and `msg`. On a question turn each such hit asks the user.
- Every hook process stayed alive 3 s after its work was done: the stdin read timer was never cleared. Claude Code waits for hook exit, so headless `claude -p` took 10.0 s and 10.2 s with the gates on against 4.1 s and 3.6 s with them off.
- A prompt checker run over 45 real prompts flagged 10 of 17 change requests at a 0.5 cutoff, about 6 of them nags. Prompts pointing at attached screenshots were always flagged, because Jev cannot see images.

## Changes

### 1. Redaction (security, first)

`lib/redact.mjs` replaces secret values with `[redacted]` and keeps the names around them, so a judgment still sees that a command sends an API key.

Covered: key-value pairs whose key names a credential (`api_key`, `Api-Key:`, `token=`, `password:`, `Authorization: Bearer …`, `client_secret`, …), known token shapes (`sk-`, `ghp_`, `github_pat_`, `xox?-`, `AKIA…`, `AIza…`, `glpat-`, `npm_`, JWTs), PEM private key blocks, and `user:pass@` in URLs.

Not covered on purpose: generic long tokens. Git SHAs, hashes and long identifiers are ordinary content, and gates such as proof and commit need them.

Applied at two boundaries: every string in the `state` sent to Jev, and every field written to `decisions.log`. The data directory is created 0700 and its files 0600.

### 2. Warm connection broker

`lib/broker.mjs` is a small local process that holds one keep-alive connection to Jev. Hooks send it their request over a Unix socket in the data directory.

- Started lazily. When a hook finds no broker, it spawns one detached and makes its own call directly, so no call ever waits for a broker to boot.
- Holds nothing secret. The key travels with each request over the 0600 socket, and the broker keeps no copy.
- Refuses any base URL other than the one it started with. A hook with a different URL, or a stale broker from an older plugin version, gets a refusal and falls back to a direct call. A stale broker exits on refusal.
- Exits after 10 minutes without a request (`JEV_GATES_BROKER_IDLE_MS`). One broker per data directory; a second one that loses the socket race exits.
- `JEV_GATES_BROKER=off` restores direct calls.
- Any broker failure means a direct call, never a lost judgment.

### 3. Prompt gate: intent plus a gap check, one call

`hooks/intent-guard.mjs` keeps its name, marker, log line and note. Its one Jev request gains four yes/no checks, judged with the previous assistant turn as context:

| id | yes means |
|---|---|
| `goal` | the wanted outcome is clear |
| `where` | the place in the code or app is stated or obvious |
| `done_when` | there is a way to tell the work is finished |
| `bug_detail` | a bug report says expected vs actual and how to trigger it, or it is not a bug report |

When a previous turn exists, a fifth check, `follow_up`, asks whether that turn already defines the work: a reply, an approval, or a follow-up such as "same for X". At or above `JEV_GATES_FOLLOWUP_THRESHOLD` (default 0.4) the prompt is not checked. On real prompts, true gaps scored at most 0.27 here and follow-ups 0.43 to 0.92.

Only when intent is `make_changes` and the prompt is not a follow-up are the checks used. A check at or below `JEV_GATES_CHECK_THRESHOLD` (default 0.3) is weak. Two weak checks, or one at or below half the threshold, make a gap: on real prompts a single borderline score flipped between runs, while real gaps showed several low scores. A gap sends Claude one note that names the gaps and tells it to look in the repo, the app, or the conversation first and to ask one short question only if it still cannot tell. Images the user attached are declared to Jev as present but unseen, and supply what the prompt points at. `JEV_GATES_CHECK=off` removes the checks from the request.

### 4. Bash guard, moved into the plugin

`hooks/bash-guard.mjs` ports `jev-guard.sh`: the same local skips (read-only commands, owned git operations, credential paths left to `deny-secret-access.sh`, `find` action flags), the same risk question, the same 0.7 threshold, a per-command cache keyed by hash, and still only ever `ask`. Differences: the command is redacted before it is sent or logged, the decision goes to `decisions.log`, and the call uses the broker.

Opt-in with `JEV_GATES_BASH=on`, like the other guards that ask before a tool runs. Enabling it replaces the `jev-guard.sh` entry in `settings.json`; running both doubles the calls.

### 5. Hooks exit when their work is done

`readStdinJson` clears its timeout once stdin ends. Every hook now exits in about 40 ms instead of 3,050 ms after its last line.

### 6. Shell write detector

`lib/shell.mjs` masks quoted text before it looks for redirects and splits segments, so operators inside quotes no longer count. Git subcommands (`stash push`, `stash pop`, …) and the values of `-m`, `-b`, `-B`, `-s`, `--message`, `--source` are no longer read as paths. `git stash` without paths reports `(worktree)`.

## Review fixes

A fresh-context review of the first build found eight defects, each reproduced by running code, and all are fixed with a test:

1. A pooled connection that died unnoticed lost the judgment. The broker now retries once on a fresh socket, and any upstream failure falls back to a direct call within the remaining time budget.
2. Brokers racing over a stale socket file could strand each other. A broker now binds a private name and renames it into place, and removes the socket file on exit only while it is still its own.
3. Redaction missed `PGPASSWORD=`, camelCase keys such as `githubToken`, suffixed keys such as `SECRET_KEY_BASE`, escaped JSON, and `Authorization: Token`. The key pattern takes a lazy prefix and separated suffixes, so it stays linear on long tokens. Scheme values must look like credentials, so "Basic authentication" is left alone.
4. Text was clipped before it was redacted, so a token cut at the boundary was logged in part. `clip()` now redacts first.
5. `mode` on create left 0.6 files and folders readable. Directories are set to 0700 and files to 0600 on every write.
6. An apostrophe in a shell comment opened a quote that swallowed the rest of the command. The scanner now knows comments.
7. A background `&` did not split commands, so `cat notes & rm -rf build` skipped Jev. It splits now.
8. Read-only programs used to write skipped Jev: `git branch -D`, `git tag -d`, `git reflog expire`, awk `system()`, `sort -o`, `sed -n 'w file'`, `find -fls`, `uniq in out`, `fd -x`, and `1>file`. Each is checked per program now. Most were inherited from `jev-guard.sh`.

Git value flags are read per subcommand as well, so `git checkout -m main` is a worktree change again.

## Not changed

Stop, done, claims, proof and commit gates. The proof file jev-lens reads. The intent log line and marker format. The rule and scope guards stay opt-in.

## Results

- 86 tests pass, including a regression test that every hook exits within 1.5 s.
- Replayed over 4,529 real Bash commands, the shell detector silenced 234 false writes, corrected 145 target lists, and flagged nothing new. None of the silenced ones was a real write.
- On 45 real prompts the prompt check flagged the same 3 of 17 change requests in two runs and skipped 6 follow-ups. Hook wall time: median 430 to 450 ms, first cold call about 1.1 s.
- Headless `claude -p` with the new code: 4.7 s with the gates on against 4.0 s off, after a cold first run of 6.9 s.

## Verification

- Unit tests for redaction (abuse cases first), the shell detector regressions, the broker (reuse, fallback, refusal, idle exit), the prompt gate (gaps note, silence on complete prompts and replies, images, check off), and the bash guard (skips, ask, redaction, cache, opt-in).
- Live: the prompt gate and bash guard against the real API through the broker, with latency before and after.
- `claude plugin validate .` passes.
