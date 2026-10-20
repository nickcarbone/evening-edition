# Evening Edition (working title)

Follows the main evening news bulletin around the world. The page shows a dial of 48 flagship bulletins in airtime order, plays the live edition while one is on air and the latest full edition otherwise, and can follow the evening automatically as each bulletin starts.

Everything plays from the broadcasters' own sources: their YouTube channels, six official live streams, or a link to their own site.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app: one page, no build step |
| `bulletins.json` | The lineup, edited by hand |
| `status.json` | Latest, live and scheduled editions, rewritten by the checker |
| `scripts/check.mjs` | The checker (Node 20+, no dependencies) |
| `.github/workflows/check.yml` | Runs the checker every hour and commits `status.json` |

`status.json` ships with editions collected by hand on 20 October 2026, so the page works before the checker's first run.

## Setup

1. **Create the repository** and upload this folder as it is, including the hidden `.github` folder (in the Mac Finder, Cmd+Shift+. shows hidden files).
2. **Get a YouTube Data API key.** In the [Google Cloud console](https://console.cloud.google.com/), create a project, enable *YouTube Data API v3*, then create an API key under *Credentials*. Restrict the key to that API.
3. **Add the key as a secret.** Repository *Settings → Secrets and variables → Actions → New repository secret*, named `YT_API_KEY`.
4. **Run the checker once.** *Actions → Check bulletins → Run workflow*. The run summary lists every bulletin's state and flags airtimes that don't match the lineup. If the commit step fails with a permissions error, set *Settings → Actions → General → Workflow permissions* to *Read and write*.
5. **Turn on Pages.** *Settings → Pages → Deploy from a branch*, branch `main`, folder `/ (root)`.

### A private repository

GitHub Pages from a private repository needs GitHub Pro, Team or Enterprise. The published site is still reachable by anyone with its address unless the repository belongs to a GitHub Enterprise Cloud organisation, which can restrict it to members. The page carries a `noindex` tag so search engines skip it.

### Testing locally

The page reads its JSON files over HTTP and YouTube refuses to play inside pages opened straight from disk, so serve the folder:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

## Using it

- **Flip** with the arrow keys, the arrows on the clock panel, or a swipe across it on a phone. Tap any tile on the dial.
- **Follow live** switches the player to each bulletin as it starts.
- **Catch up** plays the editions from the last day you haven't watched, oldest first.
- **CC** asks YouTube for English captions where the broadcaster provides captions.
- **Lineup** hides bulletins and marks favourites. These choices stay in your browser only.
- A link like `.../#kbs` opens straight on that bulletin.

## Editing the lineup

Each entry in `bulletins.json`:

| Field | Meaning |
| --- | --- |
| `tz`, `local`, `days` | Time zone (IANA name), local airtime, `daily` or `weekdays`. The page converts to your own time, so clock changes need no edits. |
| `minutes` | Typical length, used to decide when a bulletin counts as on air |
| `min_minutes` | Shortest upload the checker accepts as a full edition, to skip clips |
| `time_basis` | `verify` marks airtimes taken from memory; the checker's run summary reports any edition that started more than 20 minutes away from `local` |
| `sources` | In priority order. `youtube` needs `channel_id` and a `title_pattern` (a regular expression matched against video titles); `stream` is an official HLS address; `page` is the broadcaster's own player |

## What the checker does

For each YouTube channel it reads the latest 50 uploads, keeps those whose titles match the bulletin's pattern, and fetches their details. It records:

- the newest finished edition long enough to be a full one, public, and not blocked in the US;
- an edition that is live right now;
- an edition scheduled to start in the next 30 hours.

For the six broadcaster streams it follows the playlist down to a video segment from the GitHub runner, which is in the US, and records whether it played and allowed browser playback.

A full run costs about 100 of the API's free 10,000 daily units. On a private repository each run uses about a minute of the plan's Actions allowance, roughly 720 minutes a month.

## Known limits

- Live detection depends on broadcasters scheduling their streams ahead, which most of these do. One that goes live without notice is picked up on the next hourly run.
- Some streams are blocked outside their country during programmes without foreign rights. DR1 played from the US at 2am Eastern on 20 October and was blocked at 3:40am.
- Embedded YouTube will not play in some automated or data-centre browsers; this is YouTube's own check and doesn't affect normal viewing.
