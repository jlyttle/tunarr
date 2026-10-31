const LABELS = { break: "Break", not_break: "Not a break", unsure: "Unsure" };
const KEYS = { b: "break", n: "not_break", u: "unsure" };
const state = { rel: null, rows: [], focus: 0, complete: false };

const el = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function formatTime(ms) {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function showError(message) {
  el("error").textContent = message;
  el("error").hidden = !message;
}

async function request(url, body) {
  const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

function episodeStatus(episode) {
  if (episode.complete) return episode.held_out ? "complete (held out)" : "complete";
  return episode.user_decisions > 0 ? "in progress" : "not started";
}

function episodeLink(episode) {
  const link = make("a", "", episode.rel);
  link.href = `/episode?rel=${encodeURIComponent(episode.rel)}`;
  return link;
}

function episodeRow(episode) {
  const tr = make("tr");
  const name = make("td");
  name.appendChild(episodeLink(episode));
  tr.append(name, make("td", "", String(episode.decisions)), make("td", "", String(episode.user_decisions)), make("td", "", episodeStatus(episode)));
  return tr;
}

async function reviewIndex() {
  try {
    const summary = await request("/api/show");
    el("show").textContent = summary.show;
    document.title = `${summary.show} - breakdetect`;
    el("episodes").tBodies[0].append(...summary.episodes.map(episodeRow));
  } catch (e) {
    showError(e.message);
  }
}

function isDecided(row) {
  return row.decision !== null && row.decision.source === "user";
}

function rowTimes(row) {
  if (row.start_ms === null) return "added or imported";
  return `${row.kind}, dark ${formatTime(row.start_ms)} to ${formatTime(row.end_ms)}`;
}

function decisionNote(row) {
  if (row.decision === null) return "undecided";
  return row.decision.source === "user" ? "decided" : `${row.decision.source} ${LABELS[row.decision.label].toLowerCase()}`;
}

function buttonsFor(row, index) {
  const box = make("div", "buttons");
  for (const [label, text] of Object.entries(LABELS)) {
    const button = make("button", row.decision && row.decision.label === label && isDecided(row) ? "active" : "", text);
    button.addEventListener("click", () => decide(index, label));
    box.appendChild(button);
  }
  return box;
}

function rowNode(row, index) {
  const node = make("div", "row");
  node.id = `row-${index}`;
  if (isDecided(row)) node.classList.add(`decided-${row.decision.label}`);
  if (index === state.focus) node.classList.add("focused");
  const head = make("div", "row-head");
  head.append(make("span", "time", formatTime(row.cut_ms)), make("span", "meta", rowTimes(row)), make("span", "meta", decisionNote(row)));
  if (state.complete && row.score !== null) head.appendChild(make("span", "meta", `score ${row.score.toFixed(2)}`));
  const strip = make("img", "strip");
  strip.loading = "lazy";
  strip.src = `/strip?rel=${encodeURIComponent(state.rel)}&ms=${row.cut_ms}`;
  node.append(head, strip, buttonsFor(row, index));
  node.addEventListener("click", () => setFocus(index));
  return node;
}

function renderRows() {
  el("rows").replaceChildren(...state.rows.map(rowNode));
  attachClip();
  el("complete").disabled = !state.rows.every(isDecided);
}

function attachClip() {
  document.querySelectorAll(".row video").forEach((v) => v.remove());
  const node = el(`row-${state.focus}`);
  if (!node || !state.rows[state.focus]) return;
  const video = make("video");
  video.controls = true;
  video.autoplay = true;
  video.src = `/clip?rel=${encodeURIComponent(state.rel)}&ms=${state.rows[state.focus].cut_ms}`;
  video.addEventListener("error", () => showError("The clip could not be built for this break."));
  node.insertBefore(video, node.querySelector(".buttons"));
}

function setFocus(index) {
  if (index < 0 || index >= state.rows.length || index === state.focus) return;
  state.focus = index;
  renderRows();
  el(`row-${index}`).scrollIntoView({ block: "center" });
}

async function reload() {
  const episode = await request(`/api/episode?rel=${encodeURIComponent(state.rel)}`);
  state.rows = episode.rows;
  state.complete = episode.complete;
  state.focus = Math.min(state.focus, Math.max(0, state.rows.length - 1));
  el("held-out").checked = episode.held_out;
  el("complete-status").textContent = episode.complete ? "Marked complete." : "";
  renderRows();
  return episode;
}

async function decide(index, label) {
  const row = state.rows[index];
  if (!row) return;
  showError("");
  try {
    await request("/api/decision", { rel: state.rel, cut_ms: row.cut_ms, label });
    await reload();
    setFocus(index + 1);
  } catch (e) {
    showError(`Decision NOT saved: ${e.message}`);
  }
}

async function complete() {
  showError("");
  try {
    await request("/api/complete", { rel: state.rel, complete: true, held_out: el("held-out").checked });
    await reload();
  } catch (e) {
    showError(`Not marked complete: ${e.message}`);
  }
}

async function addBreak() {
  const ms = Math.round(el("full").currentTime * 1000);
  showError("");
  try {
    await request("/api/add-break", { rel: state.rel, ms });
    await reload();
    el("add-status").textContent = `Added break at ${formatTime(ms)}.`;
    setFocus(state.rows.findIndex((r) => Math.abs(r.cut_ms - ms) <= 1500));
  } catch (e) {
    showError(`Break NOT added: ${e.message}`);
  }
}

function onKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target.tagName === "INPUT") return;
  if (KEYS[event.key]) decide(state.focus, KEYS[event.key]);
  else if (event.key === "j" || event.key === "ArrowDown") moveFocus(event, 1);
  else if (event.key === "k" || event.key === "ArrowUp") moveFocus(event, -1);
  else if (event.key === "Enter" && event.target.tagName !== "BUTTON") attachClip();
}

function moveFocus(event, step) {
  event.preventDefault();
  setFocus(state.focus + step);
}

async function reviewEpisode() {
  state.rel = new URLSearchParams(location.search).get("rel");
  try {
    const episode = await reload();
    el("title").textContent = episode.name;
    document.title = `${episode.name} - breakdetect`;
    el("loading").hidden = true;
    el("finish").hidden = false;
    el("scrub").hidden = false;
    el("full").src = `/video?rel=${encodeURIComponent(state.rel)}`;
    el("complete").addEventListener("click", complete);
    el("add-break").addEventListener("click", addBreak);
    document.addEventListener("keydown", onKey);
  } catch (e) {
    el("loading").hidden = true;
    showError(e.message);
  }
}
