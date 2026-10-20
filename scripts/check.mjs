// Finds the latest full edition, any live or scheduled edition, and stream health for every
// bulletin in bulletins.json, and writes status.json for the page to read.
// Node 20+, no dependencies. Needs a YouTube Data API key in YT_API_KEY.
//
//   YT_API_KEY=... node scripts/check.mjs
//
// Quota: one playlistItems call per YouTube channel plus one videos call per 50 videos,
// about 100 units a run against the free 10,000 a day.

import { readFile, writeFile, appendFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url);
const KEY = process.env.YT_API_KEY;
const API = process.env.YT_API_BASE || "https://www.googleapis.com/youtube/v3/";
const COUNTRY = process.env.VIEWER_COUNTRY || "US"; // where you watch from, for region blocks
const ORIGIN = process.env.PAGE_ORIGIN || "https://example.github.io";
const now = Date.now();

if (!KEY) {
  console.error("YT_API_KEY is not set. Add it as a repository secret (see README).");
  process.exit(1);
}

const lineup = JSON.parse(await readFile(new URL("bulletins.json", ROOT), "utf8")).bulletins;
let previous = {};
try { previous = JSON.parse(await readFile(new URL("status.json", ROOT), "utf8")); } catch {}

async function api(path, params) {
  const u = new URL(path, API);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const seconds = iso => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || "");
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
};

const localHHMM = (tz, t) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
const minutesApart = (a, b) => {
  const [ah, am] = a.split(":").map(Number), [bh, bm] = b.split(":").map(Number);
  const d = Math.abs(ah * 60 + am - (bh * 60 + bm));
  return Math.min(d, 1440 - d);
};

// ---- YouTube --------------------------------------------------------------------------------
const ytBulletins = lineup.filter(b => b.sources.some(s => s.type === "youtube"));
const candidates = new Map(); // bulletin id -> [{videoId, title}]
const errors = {};

for (const b of ytBulletins) {
  const list = [];
  for (const src of b.sources.filter(s => s.type === "youtube")) {
    const uploads = "UU" + src.channel_id.slice(2);
    try {
      const res = await api("playlistItems", { part: "snippet,contentDetails", playlistId: uploads, maxResults: 50 });
      const rx = src.title_pattern ? new RegExp(src.title_pattern, "iu") : null;
      for (const it of res.items || []) {
        const title = it.snippet?.title || "";
        if (rx && !rx.test(title)) continue;
        list.push({ videoId: it.contentDetails.videoId, title, embeddableHint: src.embeddable !== false });
      }
    } catch (e) {
      errors[b.id] = String(e.message || e);
    }
  }
  candidates.set(b.id, list);
}

// one videos call per 50 ids
const allIds = [...new Set([...candidates.values()].flat().map(c => c.videoId))];
const details = new Map();
for (let i = 0; i < allIds.length; i += 50) {
  const res = await api("videos", { part: "snippet,contentDetails,status,liveStreamingDetails", id: allIds.slice(i, i + 50).join(","), maxResults: 50 });
  for (const v of res.items || []) details.set(v.id, v);
}

const blockedHere = v => {
  const rr = v.contentDetails?.regionRestriction;
  if (!rr) return false;
  if (rr.blocked && rr.blocked.includes(COUNTRY)) return true;
  if (rr.allowed && !rr.allowed.includes(COUNTRY)) return true;
  return false;
};

const status = {};
const report = [];

for (const b of ytBulletins) {
  const entry = { latest: null, live: null, upcoming: null, checked: new Date(now).toISOString() };
  const vids = (candidates.get(b.id) || []).map(c => ({ c, v: details.get(c.videoId) })).filter(x => x.v);
  const usable = vids.filter(({ v }) => v.status?.privacyStatus === "public" && !blockedHere(v));

  const live = usable.find(({ v }) => v.snippet.liveBroadcastContent === "live");
  if (live) entry.live = { videoId: live.v.id, title: live.v.snippet.title, start: live.v.liveStreamingDetails?.actualStartTime || null };

  const upcoming = usable
    .filter(({ v }) => v.snippet.liveBroadcastContent === "upcoming" && v.liveStreamingDetails?.scheduledStartTime)
    .map(x => ({ ...x, at: Date.parse(x.v.liveStreamingDetails.scheduledStartTime) }))
    .filter(x => x.at > now - 2 * 36e5 && x.at < now + 30 * 36e5)
    .sort((a, b2) => a.at - b2.at)[0];
  if (upcoming) entry.upcoming = { videoId: upcoming.v.id, title: upcoming.v.snippet.title, scheduledStart: upcoming.v.liveStreamingDetails.scheduledStartTime };

  const minSec = (b.min_minutes || 10) * 60;
  const done = usable
    .filter(({ v }) => v.snippet.liveBroadcastContent === "none" && seconds(v.contentDetails.duration) >= minSec)
    .map(x => ({ ...x, at: Date.parse(x.v.liveStreamingDetails?.actualStartTime || x.v.snippet.publishedAt) }))
    .sort((a, b2) => b2.at - a.at);
  const pick = done.find(({ v }) => v.status.embeddable) || done[0];
  if (pick) {
    entry.latest = {
      videoId: pick.v.id,
      title: pick.v.snippet.title,
      published: new Date(pick.at).toISOString(),
      duration: seconds(pick.v.contentDetails.duration),
      embeddable: !!pick.v.status.embeddable,
    };
    // the airtime as actually broadcast, when YouTube knows the live start
    const actual = pick.v.liveStreamingDetails?.actualStartTime;
    if (actual) {
      entry.observedLocal = localHHMM(b.tz, Date.parse(actual));
      if (minutesApart(entry.observedLocal, b.local) > 20) report.push(`${b.id}: lineup says ${b.local}, last edition started ${entry.observedLocal} local`);
    }
  } else if (previous.bulletins?.[b.id]?.latest) {
    entry.latest = previous.bulletins[b.id].latest; // keep the last good edition
    entry.stale = true;
  }
  if (errors[b.id]) entry.error = errors[b.id];
  if (!vids.length) entry.error = entry.error || "no uploads matched the title pattern";
  status[b.id] = entry;
}

// ---- broadcaster streams -----------------------------------------------------------------------
async function probe(url) {
  const hop = async u => {
    const r = await fetch(u, { headers: { Origin: ORIGIN, "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    return { ok: r.ok, cors: !!r.headers.get("access-control-allow-origin"), url: r.url, text: r.ok ? await r.text() : "" };
  };
  const firstUri = (text, base) => {
    for (const line of text.split(/\r?\n/)) { const l = line.trim(); if (l && !l.startsWith("#")) return new URL(l, base).href; }
    return null;
  };
  try {
    let h = await hop(url); const hops = [h];
    let next = h.ok && firstUri(h.text, h.url);
    if (next && h.text.includes("#EXT-X-STREAM-INF")) { h = await hop(next); hops.push(h); next = h.ok && firstUri(h.text, h.url); }
    if (next) {
      const r = await fetch(next, { headers: { Origin: ORIGIN, Range: "bytes=0-2047" } });
      hops.push({ ok: r.ok, cors: !!r.headers.get("access-control-allow-origin") });
      await r.arrayBuffer().catch(() => {});
    }
    return { ok: hops.length > 1 && hops.every(x => x.ok), cors: hops.every(x => x.cors) };
  } catch (e) {
    return { ok: false, cors: false, error: String(e.message || e) };
  }
}

for (const b of lineup) {
  const s = b.sources.find(x => x.type === "stream");
  if (!s) continue;
  const res = await probe(s.url);
  status[b.id] = { ...(status[b.id] || {}), stream: { ...res, checked: new Date(now).toISOString() } };
  if (!res.ok || !res.cors) report.push(`${b.id}: stream ${res.ok ? "plays but lacks CORS" : "failed"}${res.error ? " (" + res.error + ")" : ""}`);
}

// ---- write only when something a viewer would notice has changed --------------------------------
const strip = o => JSON.stringify(o, (k, v) => (k === "checked" || k === "generated" ? undefined : v));
const prevAge = previous.generated ? now - Date.parse(previous.generated) : Infinity;
const out = { generated: new Date(now).toISOString(), country: COUNTRY, bulletins: status };

if (strip(out.bulletins) !== strip(previous.bulletins || {}) || prevAge > 6 * 36e5) {
  await writeFile(new URL("status.json", ROOT), JSON.stringify(out, null, 2) + "\n");
  console.log("status.json updated");
} else {
  console.log("No change worth committing");
}

// ---- summary --------------------------------------------------------------------------------------
const rows = lineup.map(b => {
  const s = status[b.id] || {};
  const what = s.live ? "live now" : s.upcoming ? "scheduled " + s.upcoming.scheduledStart : s.latest ? (s.stale ? "kept last" : "latest") + " " + (s.latest.published || "").slice(0, 16) : s.stream ? (s.stream.ok ? "stream ok" : "stream failed") : "link only";
  return `| ${b.id} | ${b.programme.replace(/\|/g, "/")} | ${what} | ${s.error ? s.error.replace(/\|/g, "/").slice(0, 80) : ""} |`;
});
const md = ["## Bulletins", "", "| id | programme | state | problem |", "| --- | --- | --- | --- |", ...rows, "",
  report.length ? "## Check these\n\n" + report.map(r => "- " + r).join("\n") : "No airtime or stream problems found."].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
