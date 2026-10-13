// The scenario player, inlined after topo-live.js when the spec has a `scenario` and the
// `scenario` feature is on. A timeline under the stage shows the named phases and each step;
// the story plays and loops on its own. Scrubbing or jumping to a phase re-simulates from 0
// (the sim is seeded, so the same time always looks the same). Clicking a node takes over:
// the story stops applying and the reader plays freely until they press play again.
(() => {
  const story = normalizeScenario(DATA.spec.scenario);
  if (!story) return;
  const plate = stage.closest(".k-card");
  const hint = plate.querySelector('[data-corner="hint"]');
  const hintText = hint ? hint.textContent : "";
  const pct = (t) => `${((100 * t) / story.length).toFixed(3)}%`;
  const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const phases = story.phases
    .map((phase, index) => `<button type="button" class="tp-phase" data-at="${phase.at}" style="left:${pct(phase.at)};width:${pct(phase.end - phase.at)}" title="${esc(phase.name)} (${index + 1})"><span>${esc(phase.name)}</span></button>`)
    .join("");
  const ticks = story.steps.map((step) => `<i class="tp-tick" style="left:${pct(step.at)}"${step.say ? ` title="${esc(step.say)}"` : ""}></i>`).join("");
  const bar = document.createElement("div");
  bar.className = "tp-story";
  bar.innerHTML = `<div class="tp-timeline"><button type="button" class="tp-play"></button><div class="tp-track" tabindex="0" role="slider" aria-label="Story time" aria-valuemin="0" aria-valuemax="${story.length}">${phases}${ticks}<div class="tp-head"></div></div><span class="tp-time"></span></div><p class="tp-say" aria-live="polite"></p>`;
  stage.after(bar);
  const play = bar.querySelector(".tp-play");
  const track = bar.querySelector(".tp-track");
  const head = bar.querySelector(".tp-head");
  const clock = bar.querySelector(".tp-time");
  const line = bar.querySelector(".tp-say");

  let mode = "story";
  let playing = !still.matches;
  paused = !playing;
  let preview = null;

  function seek(t) {
    const next = createSim(DATA.spec);
    const steps = Math.round(Math.max(0, Math.min(t, story.length)) * 60);
    for (let i = 0; i < steps; i++) next.step(1 / 60);
    resetVisuals(next);
    mode = "story";
    render();
  }

  const phaseAt = (t) => story.phases.filter((phase) => phase.at <= t + 1e-6).pop();
  const sayAt = (t) => story.steps.filter((step) => step.say && step.at <= t + 1e-6).pop();
  let shown = { say: null, phase: null };
  function render() {
    const t = preview ?? Math.min(sim.time, story.length);
    head.style.left = pct(t);
    clock.textContent = `${t.toFixed(1)}s`;
    track.setAttribute("aria-valuenow", t.toFixed(1));
    bar.dataset.mode = mode;
    play.textContent = playing && mode === "story" ? "❚❚" : "▶";
    play.setAttribute("aria-label", mode === "free" ? "Resume the story" : playing ? "Pause" : "Play");
    const phase = mode === "story" ? phaseAt(t) : null;
    const step = mode === "story" ? sayAt(t) : null;
    if (phase !== shown.phase) {
      shown.phase = phase;
      bar.querySelectorAll(".tp-phase").forEach((el) => el.toggleAttribute("data-now", phase && +el.dataset.at === phase.at));
      if (hint) hint.textContent = mode === "free" ? "Free play · ▶ resumes the story" : story.phases.length > 1 ? `Click a node to take over · 1–${Math.min(9, story.phases.length)} jump · V for 2D` : hintText;
    }
    const text = mode === "free" ? "You've taken over: click nodes to fail and restore them." : step ? step.say : "";
    if (text !== shown.say) {
      shown.say = text;
      line.textContent = text;
    }
  }

  hooks.tick.push(() => {
    if (mode === "story" && sim.time >= story.length) {
      if (story.loop) seek(0);
      else {
        playing = false;
        paused = true;
      }
    }
    render();
  });
  hooks.takeover.push(() => {
    if (mode !== "story") return;
    mode = "free";
    playing = true;
    paused = false;
    // Free play: the rest of the script no longer applies.
    sim.stepIndex = Infinity;
    shown.phase = undefined;
    render();
  });
  hooks.key.push((event) => {
    if (/^[1-9]$/.test(event.key) && story.phases[+event.key - 1]) {
      seek(story.phases[+event.key - 1].at);
      return true;
    }
    if (event.key === "p" || event.key === "P") {
      toggle_();
      return true;
    }
    return false;
  });

  function toggle_() {
    if (mode === "free") {
      seek(sim.time);
      playing = true;
    } else playing = !playing;
    paused = !playing;
    render();
  }
  play.addEventListener("click", toggle_);
  bar.querySelectorAll(".tp-phase").forEach((el) =>
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      seek(+el.dataset.at);
    }),
  );
  const fractionOf = (event) => {
    const box = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  };
  track.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".tp-phase")) return;
    track.setPointerCapture(event.pointerId);
    preview = fractionOf(event) * story.length;
    render();
  });
  track.addEventListener("pointermove", (event) => {
    if (preview == null) return;
    preview = fractionOf(event) * story.length;
    render();
  });
  const release = () => {
    if (preview == null) return;
    const t = preview;
    preview = null;
    seek(t);
  };
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);
  track.addEventListener("keydown", (event) => {
    const t = Math.min(sim.time, story.length);
    if (event.key === "ArrowRight") seek(t + 1);
    else if (event.key === "ArrowLeft") seek(t - 1);
    else if (event.key === "Home") seek(0);
    else if (event.key === " ") toggle_();
    else return;
    event.preventDefault();
  });
  window.__topo.story = { seek, get mode() { return mode; }, get playing() { return playing; }, story };
  render();
})();
