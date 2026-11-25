# Benchmarks

How the mini-browser MCP performs on real tasks, measured in time, turns, tokens and cost. The goal
from review feedback: be on par with Codex on a long cross-site task (YouTube, Sheets, Excalidraw,
Photopea, Docs, Gmail) in tokens, turns and speed.

Raw data for every run is in `logs/`: `benchmark-*.json` / `bench-*.json` (metrics), the matching
`*.jsonl` (every MCP call with arguments, result and time) and the output files.

## How a run is measured

- **Agent:** Claude Code, Opus 5.5, effort low. Each task is given as one sentence with no hints.
- **Time:** from the first mini-browser call to the task's last action.
- **Turns and tokens:** summed from the session transcript (`~/.claude/projects/<project>/<session>.jsonl`),
  assistant messages in that window, deduped by `message.id`.
- **Cost:** Opus 5.5 prices: $4/MTok input, $20/MTok output, $0.20/MTok cache read, $8/MTok cache write (1h).
- **MCP time:** sum of `ms` in the MCP trace for the same window. The rest of the wall time is the model.

Not comparable across runs: the starting context. The baseline ran in a session that already held
about 110k tokens of earlier work; later runs started fresh. Turns, MCP calls and MCP time compare
cleanly; dollar cost only roughly.

## Results

### Kleki: "paint a portrait of Albert Einstein, save it as a PNG"

| | Baseline | After fixes | Change |
|---|---|---|---|
| Code | commit `cdc06c5` | settle, diff, batch, paste fixes | |
| Wall time | 242s | 219s | -10% |
| MCP time | 44.1s | 17.9s | **-59%** |
| Model time (wall minus MCP) | 198s | 201s | +2% |
| Model turns | 21 | 23 | +2 |
| MCP calls | 19 | 22 | +3 |
| `batch` calls | 10 | 16 | +6 |
| Avg time per `batch` | 3,971ms | 886ms | **-78%** |
| Avg settle per action | 846ms (512-1,947) | 348ms (261-565) | **-59%** |
| Failed steps or calls | 1 eval error, 2 batches that silently missed (dialog toggled closed) | 1 stale ref | |
| Screenshots | 10 | 16 | +6 |
| Text returned by the MCP | 7.3k chars | 7.0k chars | -5% |
| Output tokens | 19.9k | 16.9k | -15% |
| Avg context per turn | 138k | 84k | not comparable (baseline session was not fresh) |
| Cost: output | $0.40 | $0.34 | |
| Cost: cache read | $0.57 | $0.38 | |
| Cost: cache write | $0.34 | $0.45 | +$0.11 (more screenshots) |
| **Cost: total** | **$1.31** | **$1.16** | -11% |
| Result | `logs/kleki-einstein-baseline.png` | `logs/kleki-einstein-after.png` | |

Per-tool time (calls × total ms):

| Tool | Baseline | After |
|---|---|---|
| `batch` | 10 × 39.7s | 16 × 14.2s |
| `tab_open` / `navigate` | 1 × 2.4s | 1 × 3.2s |
| `mouse_click` / `mouse_drag` | 2 × 1.5s | 1 × 0.4s |
| `eval_js` | 5 × 0.4s (1 error) | 2 × 0.01s |
| `screenshot` / `snapshot` | 1 × 0.06s | 2 × 0.07s |

What the numbers say:

- **The MCP got much faster.** Each action now waits about 350ms instead of about 850ms for the page
  to settle, and a batch of steps returns in under 1s instead of about 4s.
- **The run did not get much faster**, because the MCP was only 18% of the baseline's wall time.
  The model spent about 200s thinking and writing stroke coordinates in both runs.
- **Turns stayed the same.** Both agents painted a few strokes, looked, then painted more. Fewer turns
  needs the agent to plan bigger batches, which is why the server instructions were added later.
- **Cost fell 11%**, mostly from the smaller context. The after run took 6 more screenshots, which
  raised cache-write cost; batch screenshots now default to half scale for that reason.
- **Fewer silent failures.** In the baseline two batches typed into a dialog that had toggled closed,
  and painted with the wrong colour without any error. In the after run the only failure was a stale
  ref, reported with a clear message (now rebound automatically).

Both portraits are recognisable. The after run has fuller, more detailed hair and drawn eyes; the
baseline has a cleaner face shape and a tie.

A later run (discarded) took 36 turns and 68 calls and **never used `batch`**. Claude Code loads MCP
tool schemas lazily: the agent only sees tool names until it picks one, and it never picked `batch`,
so it never read why to use it. Fix: the server now sends MCP `instructions`, which clients show up
front, telling the agent to use `batch` for any sequence it can plan.

### Cross-site: YouTube → Sheets → Excalidraw → Photopea → Docs → Gmail

> Find the official trailer for Dune: Part Two on YouTube and note its title, length and view count.
> Put them in a new Google Sheet with a header row. In Excalidraw, draw three boxes labeled YouTube,
> Sheet and Email connected by arrows, and export it as a PNG. Open that PNG in Photopea, add the
> text "Benchmark" at the top, and export it as a PNG. Write a short Google Doc summarizing the
> trailer stats with a link to the sheet. Finally, draft (don't send) a Gmail to yourself with the
> doc link and the Photopea PNG attached.

| | mini-browser (with server instructions) | Codex |
|---|---|---|
| Completed | yes, all 6 apps | not run yet |
| Wall time | 333s | |
| MCP time | 110.3s | |
| Model turns | 59 | |
| MCP calls | 74 (34 `batch`) | |
| Screenshots | 28 | |
| Output tokens | 17.4k | |
| Avg context per turn | 83k | |
| Cost | $1.76 | |

Data: `logs/bench-cross-site.json`, trace `logs/2026-11-25T16-17-37-794Z.jsonl`, output `logs/bench-cross-site.png`.

The server instructions worked: 34 of 74 calls were `batch` (zero in the discarded Kleki run).
`paste`, `drop_files`, `upload`, `wait_for` and `downloads` were all used on real sites.


Agent or environment problems (not the MCP):

- Sheets read `2:24` as a time; the agent needed 3 turns to re-enter it as text.
- Excalidraw already held a drawing from the shared browser profile, and arrows drawn from inside a
  box did not bind: about 12 turns.
- Photopea's scripting API posts results to `window.parent`, so it returns nothing in a top-level
  tab; the agent fell back to the File > Export as menu (4 turns, 12s of `eval`).
- A first attempt hit a Google sign-in confirmation page; the measured run is the second attempt.


