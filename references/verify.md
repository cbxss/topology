# Verify

Rendering is cheap and guessing is expensive. Check the model, then look at the figure the way a reviewer would.

## 0. The edit loop

```sh
node scripts/serve.mjs examples --port 8765     # http://127.0.0.1:8765/ (over SSH: ssh -N -L 8765:localhost:8765 host)
```
Every page rebuilds on load and reloads when a spec, its layout file or anything in `kit/` changes; a build error shows as a page with the stack. `?edit` drags nodes in 2D and writes `<name>.layout.json`; delete that file to go back to the spec's own layout. Headless Chrome needs a few hundred MB of temp space: if `/tmp` is small or full, run the scripts with `TMPDIR=~/.cache/topology-tmp`.

## 1. The model

```sh
node scripts/build.mjs my.spec.mjs --check 30
```
```
Order events: 10 nodes, 9 edges, 30s simulated
  t=  5s  400/s in · lag 40 · healthy
  …
nodes:
  orders.v1 · in 420/s · billing lag 0 · 2/2 consumers · search lag 0 · 1/1 consumers
  billing-a · 280/s
  …
check passed
```
With a scenario, the check first prints the story, phase by phase:
```
story: 40s, loops, 3 phases, 4 steps
phase steady (0–10s): 428/s in · p50 16ms · p99 51ms · lag 13 · 0.0/s failing
phase consumer lost (10–22s): 393/s in · p50 15ms · p99 40ms · lag 1.3k · 0.0/s failing
    9.9s before fail billing-a: 420/s in · p50 15ms · p99 57ms · lag 0 · healthy
   13.0s   +3s  fail billing-a: 400/s in · p50 16ms · p99 19ms · lag 600 · 100/s lost
phase recovery (22–40s): 435/s in · p50 15ms · p99 37ms · lag 230 · 0.0/s failing
```
Every number your `say` lines and caption claim must match these. Then read the per-node lines: they are what the readout says when the reader hovers each node. Warnings to clear (or keep on purpose):

| Warning | Fix |
|---|---|
| `lag keeps growing` | The group's busiest member is slower than its share of the inflow. Raise its `rate`, add a consumer, or add partitions. Keep it only for a figure about lag. |
| `edge … never carried anything` | Nothing reaches the source, `p` is 0, or a `roundrobin` node has another edge taking everything. |
| `edge …: n of m dropped` | The target was down or over `capacity`. Expected at a rate limit; otherwise raise the capacity. |
| `no node has emit` | Give the sources an `emit` rate. |
| `nodes … overlap` | Set `at` or a larger `grid`. |
| `edge … passes under …` | `bend`, `via`, `axis`, or move a node. |
| `label … is hidden behind …` | Space the rows (`grid`), move a node, or `labelAt`. |
| `the story ends with lag …` / `ends failing …` | Recover what the story breaks and leave time to drain before `length`, or set `loop: false`. |
| `scenario step … names unknown node or edge` | Fix the id; edges are `"from>to"`, brokers `"topic:b0"`. |

Then simulate the failure you want the reader to try. In Node:
```js
import { createSim } from "./kit/topo-sim.mjs";
import { prepare, simSpec } from "./kit/topo.mjs";
const sim = createSim(simSpec(prepare(spec)));
for (let i = 0; i < 600; i++) sim.step(1 / 60);
sim.setUp("billing-a", false);
for (let i = 0; i < 600; i++) sim.step(1 / 60);
console.log(sim.statsOf("topic"), sim.summary());
```

## 2. The pictures

`scripts/capture.mjs` and `scripts/drive.mjs` start their own headless Chrome (set `CHROME_PATH` if they can't find one) and print the readout, console errors and whether the page scrolls sideways.

```sh
node scripts/capture.mjs my.html --out shots/iso.png                 # desktop, iso
node scripts/capture.mjs my.html --out shots/flat.png --key v        # the 2D view
node scripts/capture.mjs my-light.html --out shots/iso-light.png     # light theme (build with --light)
node scripts/capture.mjs my.html --out shots/phone.png --width 390   # phone
node scripts/capture.mjs my.html --out shots/t.png --times 2000,6000 # later moments
node scripts/capture.mjs my.html --out shots/zoom.png --zoom 300,150,200,140   # a 4x close-up, in card px
```

Drive a failure and watch its consequence (put long action lists in a file with `--actions`):
```json
[["wait", 1500],
 ["move", ".tp-iso [data-node='billing-a']", 0.5, 0.5], ["wait", 300], ["shot", "shots/hover.png"],
 ["click", ".tp-iso [data-node='billing-a']"], ["wait", 6000], ["shot", "shots/failed.png"],
 ["key", "v"], ["wait", 400], ["shot", "shots/failed-flat.png"]]
```
```sh
node scripts/drive.mjs my.html --actions fail.json --scale 2
```
Use `.tp-flat [data-node='…']` after switching to 2D. `["slow", 0.1]` slows the page's clock for a contact sheet (`["sheet", "s.png", 120, 12]`). The page exposes `window.__topo` (`sim`, `setView`, `setFocus`, `toggle`) for `["eval", …]` and `["until", …]`, for example `["until", "window.__topo.sim.lagOf('topic') > 100"]`.

Scenario pages: seek to each step and shoot it. `window.__topo.story.seek(t)` re-simulates to `t`:
```json
[["wait", 800], ["eval", "window.__topo.story.seek(17); 1"], ["wait", 900], ["shot", "shots/incident.png"],
 ["click", ".tp-phase[data-at='22']"], ["wait", 500], ["eval", "document.querySelector('.tp-say').textContent"],
 ["click", ".tp-iso [data-node='indexer']"], ["eval", "window.__topo.story.mode"]]
```
The last two lines check takeover: `mode` turns `free`. Morph: click `[data-view='flat']`, then `["slow", 0.5]` and `["sheet", "morph.png", 30, 12, null, 0.5, null, 4]`. The camera should swing smoothly to top-down and crossfade, with no pops and no blank frame.

## 3. Line ends

```sh
node scripts/lines.mjs my.html
node scripts/drive.mjs my.html '[["wait",800],["key","v"],["wait",300],["lines"]]'
```
Both must print `line ends: 0`. A line that stands for printed text or a pointer tip is marked `free`; every other line ends on a stroke, a dot or an outline.

## Checklist

Open every PNG and ask:

- Does it answer its question? Does the failure the hint invites change the picture and the readout the way the caption says?
- Is every number in the caption what `--check` prints?
- Iso: does every node read as its object at a glance? Is every label readable and unhidden? Do zones sit cleanly inside one another?
- Flat: do labels sit under their glyphs without colliding? Do parallel edges run in separate lanes?
- Do packets stay on their links and turn the right colour (blue out of a log, green on replication, red drops)?
- Kafka: are bright cells and cursors where the lag says they should be, for each group?
- Light theme: do packets and cursors stay legible on paper?
- Phone (390 wide): does it still read, with no sideways scroll?
- Reduced motion (`--reduced`): no packets move, and the readout still updates.
- Story: does each phase show what its narration says, at the moment it says it? Does it loop without a jump?
- Breakers, queue cells, edge labels and flag knobs: do they change when the readout says they should?
- Console: clean.
