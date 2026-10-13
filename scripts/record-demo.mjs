// Rebuild README media from the actual Order events page. Requires Chrome,
// Node 22+ and ffmpeg. Run from the repository root after building the example.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openBrowser, sleep } from "./browser.mjs";

const frames = mkdtempSync(join(tmpdir(), "topology-demo-"));
const out = "docs/media";
mkdirSync(out, { recursive: true });
const page = await openBrowser({ width: 1080, height: 900, scale: 1, preload: "window.__topoSpeed = 0;" });
try {
  await page.goto("examples/order-events/order-events-light.html");
  await sleep(200);
  // Keep one crop while narration wraps and the camera changes aspect ratio.
  await page.eval('Object.assign(document.querySelector(".k-card").style, {minHeight: "550px", boxSizing: "border-box"})');
  const clip = await page.box(".k-card");
  // Advance the real model in fixed steps: 40 model seconds in 20 video seconds.
  // Rendering still uses Chrome's animation frames, including the camera morph.
  for (let frame = 0; frame < 200; frame++) {
    await page.eval('for(let i=0;i<12;i++) window.__topo.sim.step(1/60)');
    if (frame === 125) {
      await page.eval('document.querySelector("[tabindex=\\"0\\"]").focus()');
      await page.key("v");
    }
    await sleep(100);
    writeFileSync(join(frames, `${String(frame).padStart(4, "0")}.png`), await page.shot(clip, 1));
  }
  if (page.errors.length) throw new Error(page.errors.join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "10", "-i", join(frames, "%04d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${out}/order-events.mp4`]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${out}/order-events.mp4`, "-filter_complex", "[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", `${out}/order-events.gif`]);
  console.log(`Recorded ${out}/order-events.{gif,mp4}; browser console clean`);
} finally {
  await page.close();
  rmSync(frames, { recursive: true, force: true });
}
