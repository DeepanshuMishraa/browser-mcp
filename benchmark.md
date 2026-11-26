# Benchmarks

How the mini-browser MCP performs on real tasks, measured in time, turns, tokens and cost. The goal
from review feedback: be on par with Codex on a long cross-site task (YouTube, Sheets, Excalidraw,
Photopea, Docs, Gmail) in tokens, turns and speed.

Raw data for every run is in `logs/`: `benchmark-*.json` / `bench-*.json` (metrics), the matching
`*.jsonl` (every MCP call with arguments, result and time) and the output files.

## How a run is measured

- **Agent:** Claude Code, Opus 5.5, effort medium. Each task is given as one sentence with no hints.
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

| | v1 (server instructions) | v2 (settle, batch, screenshot, snapshot, drag, schema fixes) | Change | Codex |
|---|---|---|---|---|
| Completed | yes, all 6 apps | yes, all 6 apps | | not run yet |
| Wall time | 333s | 251s | **-25%** | |
| MCP time | 110.3s | 83.9s | **-24%** | |
| Model time (wall minus MCP) | 223s | 168s | -25% | |
| Model turns | 59 | 52 | -12% | |
| MCP calls | 74 (34 `batch`) | 54 (25 `batch`) | -27% | |
| Steps per `batch` | 6.8 (231 steps) | 4.6 (115 steps) | | |
| `wait` steps in batches | 39 (21.5s) | 9 (11.1s) | -77% | |
| `read` steps | n/a | 7 | | |
| Screenshots | 28 (644KB) | 17 (330KB), 0 omitted as unchanged | **-39%** | |
| Settle timeouts ("did not settle") | 5 (~27s) | 1 (5.5s) | -4 | |
| "still loading in background" | n/a | 6 (settled in 1.5-3.5s) | | |
| Failed steps or calls | 2 | 3 | +1 | |
| Text returned by the MCP | 34.4k chars | 25.1k chars | -27% | |
| Output tokens | 17.4k | 11.0k | -37% | |
| Avg context per turn | 83k | 71k | -15% | |
| Context at first turn | 53.6k | 53.3k | same | |
| Cost: output | $0.35 | $0.22 | | |
| Cost: cache read | $0.97 (4.83M) | $0.73 (3.63M) | | |
| Cost: cache write | $0.44 (55.5k) | $0.34 (43.0k) | | |
| **Cost: total** | **$1.76** | **$1.29** | **-27%** | |

Per-tool time (calls × total ms):

| Tool | v1 | v2 |
|---|---|---|
| `batch` | 34 × 56.3s (avg 1.66s) | 25 × 50.2s (avg 2.01s, 1 error) |
| `eval_js` | 6 × 12.4s | 4 × 15.0s |
| `wait_for` | 6 × 11.7s | 0 (6 `wait_for` steps inside batches) |
| `tab_open` | 6 × 4.5s | 5 × 7.1s |
| `navigate` | 1 × 5.2s | 1 × 5.5s |
| `paste` | 3 × 8.0s | 3 × 4.1s |
| `click` | 2 × 5.8s | 0 |
| `upload` | 1 × 5.2s | 1 × 0.8s |
| `drop_files` | 1 × 0.6s | 1 × 0.5s |
| `screenshot` / `snapshot` | 6 × 0.4s | 7 × 0.4s |
| `find` | 6 × 0.2s | 4 × 0.3s |
| `downloads` | 2 × 0s | 3 × 0s |

Data: v1 `logs/bench-cross-site.json`, trace `logs/2026-11-25T16-17-37-794Z.jsonl`, output
`logs/bench-cross-site.png`. v2 `logs/bench-cross-site-v2.json`, trace `logs/2026-11-26T05-51-29-524Z.jsonl`.

Both runs started fresh at about 53k tokens of context, so the cost comparison holds. Running the
v2 script on the v1 data gives 60 turns and $1.82 instead of the published 59 and $1.76. That gap
is under 4% and makes v1 look slightly worse, so the v2 gains above, if anything, understate the
improvement.

The server instructions worked: 34 of 74 calls were `batch` (zero in the discarded Kleki run).
`paste`, `drop_files`, `upload`, `wait_for` and `downloads` were all used on real sites.

#### What the numbers say (v1 → v2)

Improved:

- **Settle on Google apps.** Settle timeouts went from 5 (about 27s) to 1. The settle network
  filter (images and fonts ignored, stop once the DOM is quiet 500ms) let Sheets, Docs and Gmail
  return in 1.5-3.5s with the leftover requests listed. `paste` fell from 8.0s to 4.1s and `upload`
  from 5.2s to 0.8s. The one timeout left was the YouTube watch page, where the video kept the DOM
  changing.
- **Fewer wait steps and calls.** With waits between batch steps, the agent used 9 `wait` steps
  instead of 39 and made no standalone `wait_for` or `click` calls. The `read` step (7 uses) closed
  batches with the result, for example the Gmail field lookup and the Drafts count. Calls fell 27%.
- **Fewer, smaller screenshots.** 17 instead of 28, at half the total size (330KB vs 644KB), because
  of half-scale defaults and `clip`. This is most of the 23% drop in cache writes. The
  unchanged-image dedupe never triggered (0 omitted).
- **Less text per turn.** The MCP returned 27% less text, and average context per turn fell from
  83k to 71k. With 7 fewer turns, cache reads fell by 1.2M tokens ($0.24), the largest cost saving.
  The compact snapshot helps here through the snapshots that `navigate` and `tab_open` return; the
  agent never called `snapshot` itself.
- **Excalidraw.** Three boxes, labels and two arrows went in one 23-step batch and were checked
  with one `eval`; v1 lost about 12 turns there. The arrows started outside the boxes this time,
  so this run does not test the drag-timing fix.
- **Trimmed schemas: not measurable here.** Context at the first turn was the same (53.3k vs 53.6k)
  because Claude Code loads schemas lazily, and the saving is about 1.5k tokens.

Got worse:

- **Average `batch` time went up 21%** (1.66s to 2.01s). Each step now waits up to 1.5s for the DOM,
  and one Gmail batch spent 3s on a failed name lookup. Total batch time still fell.
- **`tab_open` on Gmail went from 0.3s to 3.1s.** v1 returned before Gmail had rendered; v2 waited
  for the DOM to go quiet. The total `tab_open` time rose from 4.5s to 7.1s.
- **Failures went from 2 to 3.** One was the agent inventing a `paste_skip` step, which schema
  validation rejected in 3ms with nothing run. Photopea's "Export as" hover failed in both runs.
  Gmail "To recipients" failed because two compose windows were open; see below.

Agent or environment problems (not the MCP):

- Sheets read `2:24` as a time. v1 needed 3 turns to re-enter it as text; v2 needed 9 calls before
  writing `2m 24s` instead. This was the largest single loss in v2.
- Excalidraw (v1) already held a drawing from the shared browser profile, and arrows drawn from
  inside a box did not bind: about 12 turns.
- Photopea's scripting API posts results to `window.parent`, so it returns nothing in a top-level
  tab. Both runs fell back to File > Export as. v1 spent 12s of `eval` on this; v2 spent 15s on two
  `eval`s that waited 5s and 10s for replies. Photopea menu items have no accessible names, so the
  name-based hover failed both times.
- Gmail (v2): opening `#inbox?compose=new` and then clicking Compose opened two compose windows.
  The agent discarded one, and the draft count went from 3 to 4.
- A first v1 attempt hit a Google sign-in confirmation page; the measured v1 run is the second attempt.
- The agent still added 9 `wait` steps, although the server instructions say steps wait on their own.


