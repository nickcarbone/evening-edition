// Finds the latest full edition, any live or scheduled edition, and stream health for every
// bulletin in bulletins.json, and writes status.json for the page to read.
// Node 20+, no dependencies. Needs a YouTube Data API key in YT_API_KEY.
//
//   YT_API_KEY=... node scripts/check.mjs           (FULL=1 forces a full sweep)
//
// Two kinds of run:
// - a full sweep, at most every two hours: every YouTube channel and every stream;
// - a focus run, otherwise: only the bulletins about to air, on air, or due to be posted.
// A full sweep costs about 50 units of the free 10,000 a day; a focus run usually under 15,
// so the checker can run every 10 minutes.
//
// It also learns how each broadcaster publishes. Every new edition's upload time is compared
// with its airtime and kept in a short history. A bulletin whose editions appear on YouTube as
// it airs is "live"; one that is uploaded afterwards is "posted", with a "readyAfter" time in
// minutes after airtime by which its edition is usually up.

import { readFile, writeFile, appendFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url);
const KEY = process.env.YT_API_KEY;
const API = process.env.YT_API_BASE || "https://www.googleapis.com/youtube/v3/";
const COUNTRY = process.env.VIEWER_COUNTRY || "US"; // where you watch from, for region blocks
const ORIGIN = process.env.PAGE_ORIGIN || "https://example.github.io";
const now = Number(process.env.NOW_MS) || Date.now();
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const FULL_EVERY = 2 * HOUR;

if (!KEY) {
  console.error("YT_API_KEY is not set. Add it as a repository secret (see README).");
  process.exit(1);
}

const lineup = JSON.parse(await readFile(new URL("bulletins.json", ROOT), "utf8")).bulletins;
let previous = {};
try { previous = JSON.parse(await readFile(new URL("status.json", ROOT), "utf8")); } catch {}
const prevB = previous.bulletins || {};

let units = 0;
async function api(path, params) {
  const u = new URL(path, API);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) u.searchParams.set(k, v);
  units++;
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

// ---- airtimes, the same arithmetic as the page ------------------------------------------------
const fmt = {};
function parts(tz, t) {
  const f = fmt[tz] ||= new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const o = {}; for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday };
}
function offset(tz, t) { const p = parts(tz, t); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; }
function zoned(y, mo, d, h, mi, tz) { const g = Date.UTC(y, mo - 1, d, h, mi); let t = g - offset(tz, g); const o2 = offset(tz, t); if (o2 !== offset(tz, g)) t = g - o2; return t; }
function airtimes(b, around, back = 3, ahead = 2) {
  const [hh, mm] = b.local.split(":").map(Number), out = new Set();
  for (let k = -back; k <= ahead; k++) {
    const p = parts(b.tz, around + k * DAY);
    if (b.days === "weekdays" && (p.wd === "Sat" || p.wd === "Sun")) continue;
    out.add(zoned(p.y, p.mo, p.d, hh, mm, b.tz));
  }
  return [...out].sort((a, c) => a - c);
}
// minutes from the airtime an edition belongs to until it appeared on YouTube
function lagOf(b, published) {
  let best = null;
  for (const a of airtimes(b, published, 2, 1)) {
    const lag = (published - a) / MIN;
    if (lag > -120 && lag < 1440 && (best == null || Math.abs(lag) < Math.abs(best))) best = lag;
  }
  return best == null ? null : Math.round(best);
}
const lastAir = b => airtimes(b, now).filter(a => a <= now).pop();

// how the bulletin reaches YouTube, from its recent editions
function learn(b, history) {
  if (b.ready_after != null) return { delivery: b.ready_after <= 10 ? "live" : "posted", readyAfter: b.ready_after, learned: false };
  const lags = history.map(h => h.lag).filter(l => l != null).sort((a, c) => a - c);
  if (!lags.length) return { delivery: "posted", readyAfter: b.minutes + 60, learned: false };
  const q = p => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
  if (q(0.5) <= 10) return { delivery: "live", readyAfter: 0, learned: true };
  return { delivery: "posted", readyAfter: Math.ceil(Math.max(q(0.75), b.minutes) / 5) * 5, learned: true };
}

// ---- which bulletins this run looks at ------------------------------------------------------------
const full = process.env.FULL === "1" || !previous.lastFull || now - Date.parse(previous.lastFull) >= FULL_EVERY;
const ytAll = lineup.filter(b => b.sources.some(s => s.type === "youtube"));
function inFocus(b) {
  const p = prevB[b.id] || {};
  const { delivery, readyAfter } = learn(b, p.history || []);
  return airtimes(b, now, 1, 1).some(a => {
    if (delivery === "live") return now >= a - 3 * HOUR && now <= a + (b.minutes + 60) * MIN;
    // posted: from airtime until six hours past the usual posting time, unless today's is already in
    if (now < a || now > a + (readyAfter + 360) * MIN) return false;
    const pub = Date.parse(p.latest?.published || 0);
    return !(pub >= a - 120 * MIN);
  });
}
const ytBulletins = full ? ytAll : ytAll.filter(inFocus);

// ---- YouTube --------------------------------------------------------------------------------
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

// carry forward everything this run didn't look at
for (const b of lineup) if (prevB[b.id]) status[b.id] = { ...prevB[b.id] };

for (const b of ytBulletins) {
  const entry = { latest: null, live: null, upcoming: null, checked: new Date(now).toISOString() };
  const vids = (candidates.get(b.id) || []).map(c => ({ c, v: details.get(c.videoId) })).filter(x => x.v);
  const usable = vids.filter(({ v }) => v.status?.privacyStatus === "public" && !blockedHere(v));

  const live = usable.find(({ v }) => v.snippet.liveBroadcastContent === "live");
  if (live) entry.live = { videoId: live.v.id, title: live.v.snippet.title, start: live.v.liveStreamingDetails?.actualStartTime || null };

  const upcoming = usable
    .filter(({ v }) => v.snippet.liveBroadcastContent === "upcoming" && v.liveStreamingDetails?.scheduledStartTime)
    .map(x => ({ ...x, at: Date.parse(x.v.liveStreamingDetails.scheduledStartTime) }))
    .filter(x => x.at > now - 2 * HOUR && x.at < now + 30 * HOUR)
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
  } else if (prevB[b.id]?.latest) {
    entry.latest = prevB[b.id].latest; // keep the last good edition
    entry.stale = true;
  }

  // learn the publishing pattern from each new edition, live or uploaded
  const history = [...(prevB[b.id]?.history || [])];
  for (const ed of [entry.live?.start && { v: entry.live.videoId, at: Date.parse(entry.live.start) },entry.latest && !entry.stale && { v: entry.latest.videoId, at: Date.parse(entry.latest.published) }]) {
    if (ed && !history.some(h => h.v === ed.v)) history.push({ v: ed.v, lag: lagOf(b, ed.at) });
  }
  entry.history = history.slice(-10);

  if (errors[b.id]) entry.error = errors[b.id];
  if (!vids.length) entry.error = entry.error || "no uploads matched the title pattern";
  status[b.id] = entry;
}

// delivery and ready time for every YouTube bulletin, including ones carried forward
for (const b of ytAll) {
  const s = status[b.id] || (status[b.id] = {});
  const { delivery, readyAfter } = learn(b, s.history || []);
  s.delivery = delivery; s.readyAfter = readyAfter;
  if (delivery === "posted" && s.latest) {
    const a = lastAir(b), pub = Date.parse(s.latest.published || 0);
    if (a && pub < a - 120 * MIN && now > a + (readyAfter + 120) * MIN) report.push(`${b.id}: today's edition is over two hours later than usual (usually ${readyAfter} min after airtime)`);
  }
}

// ---- broadcaster streams, on full sweeps only --------------------------------------------------
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

if (full && !process.env.SKIP_STREAMS) {
  for (const b of lineup) {
    const s = b.sources.find(x => x.type === "stream");
    if (!s) continue;
    const res = await probe(s.url);
    status[b.id] = { ...(status[b.id] || {}), stream: { ...res, checked: new Date(now).toISOString() } };
    if (!res.ok || !res.cors) report.push(`${b.id}: stream ${res.ok ? "plays but lacks CORS" : "failed"}${res.error ? " (" + res.error + ")" : ""}`);
  }
}

// ---- write only when something a viewer would notice has changed --------------------------------
const strip = o => JSON.stringify(o, (k, v) => (k === "checked" || k === "generated" ? undefined : v));
const prevAge = previous.generated ? now - Date.parse(previous.generated) : Infinity;
const out = {
  generated: new Date(now).toISOString(),
  lastFull: full ? new Date(now).toISOString() : previous.lastFull,
  country: COUNTRY,
  bulletins: status,
};

if (strip(out.bulletins) !== strip(prevB) || out.lastFull !== previous.lastFull || prevAge > 6 * HOUR) {
  await writeFile(new URL("status.json", ROOT), JSON.stringify(out, null, 2) + "\n");
  console.log("status.json updated");
} else {
  console.log("No change worth committing");
}

// ---- summary --------------------------------------------------------------------------------------
const looked = new Set(ytBulletins.map(b => b.id));
const rows = lineup.map(b => {
  const s = status[b.id] || {};
  const what = s.live ? "live now" : s.upcoming ? "scheduled " + s.upcoming.scheduledStart : s.latest ? (s.stale ? "kept last" : "latest") + " " + (s.latest.published || "").slice(0, 16) : s.stream ? (s.stream.ok ? "stream ok" : "stream failed") : "link only";
  const how = s.delivery === "posted" ? `posted, ~${s.readyAfter} min after air` : s.delivery || "";
  return `| ${b.id}${looked.has(b.id) ? " •" : ""} | ${b.programme.replace(/\|/g, "/")} | ${how} | ${what} | ${s.error ? s.error.replace(/\|/g, "/").slice(0, 80) : ""} |`;
});
const md = [`## ${full ? "Full sweep" : "Focus run"}: ${ytBulletins.length} YouTube bulletins checked (•), ${units} API units`, "",
  "| id | programme | reaches YouTube | state | problem |", "| --- | --- | --- | --- | --- |", ...rows, "",
  report.length ? "## Check these\n\n" + report.map(r => "- " + r).join("\n") : "No airtime or stream problems found."].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
