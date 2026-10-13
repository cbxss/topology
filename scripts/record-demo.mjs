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
const page = await openBrowser({ width: 1080, height: 900, scale: 2, preload: "window.__topoSpeed = 0;" });
try {
  await page.goto("examples/order-events/order-events-light.html");
  await sleep(200);
  // Keep one crop while narration wraps and the camera changes aspect ratio.
  await page.eval('Object.assign(document.querySelector(".k-card").style, {minHeight: "550px", boxSizing: "border-box"})');
  const clip = await page.box(".k-card");
  // Advance the real model in fixed steps: 40 model seconds in 20 video seconds.
  // Rendering still uses Chrome's animation frames, including the camera morph.
  for (let frame = 0; frame < 400; frame++) {
    await page.eval('for(let i=0;i<6;i++) window.__topo.sim.step(1/60)');
    if (frame === 250) {
      await page.eval('document.querySelector("[tabindex=\\"0\\"]").focus()');
      await page.key("v");
    }
    await sleep(50);
    writeFileSync(join(frames, `${String(frame).padStart(4, "0")}.png`), await page.shot(clip, 2));
  }
  if (page.errors.length) throw new Error(page.errors.join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "20", "-i", join(frames, "%04d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${out}/order-events.mp4`]);
  // Quantize the original retina PNGs directly, never the lossy video. This
  // restrained palette needs no patterned dithering across text and pale fills.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "20", "-i", join(frames, "%04d.png"), "-filter_complex", "[0:v]split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse=dither=none", "-loop", "0", `${out}/order-events.gif`]);
  console.log(`Recorded ${out}/order-events.{gif,mp4}; browser console clean`);
} finally {
  await page.close();
  rmSync(frames, { recursive: true, force: true });
}
