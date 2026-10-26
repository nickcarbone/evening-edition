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

- **Two lanes.** *Live* is the timeline of bulletins that stream as they air: official streams, links, and YouTube channels that broadcast live. *Posted* holds bulletins the broadcaster uploads after the broadcast, newest first. A posted bulletin leaves the lane once its next broadcast has aired and comes back when that edition is up; until then it sits behind the "not up yet" link, with the time it's usually posted.
- **Older editions are flagged.** When the newest edition the page has is older than the latest broadcast, say Sunday's while Monday's has aired, the player shows a "Yesterday's edition" badge with the date, and the tile and clock panel say so.
- **Flip** with the arrow keys, the arrows on the clock panel, or a swipe across it on a phone. Tap any tile. The arrows step through the Live lane, then Posted, then the ones not up yet.
- **Follow live** switches the player to each live bulletin as it starts, and plays posted editions as they arrive, waiting for the end of whatever is playing.
- **Catch up** plays today's editions you haven't watched, oldest first. It never includes an older edition standing in for a newer one.
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
| `ready_after` | Optional. Minutes after airtime by which the edition is usually on YouTube. Leave it out and the checker learns it; set it to override (10 or less counts as live) |
| `time_basis` | `verify` marks airtimes taken from memory; the checker's run summary reports any edition that started more than 20 minutes away from `local` |
| `sources` | In priority order. `youtube` needs `channel_id` and a `title_pattern` (a regular expression matched against video titles); `stream` is an official HLS address; `page` is the broadcaster's own player |

## What the checker does

For each YouTube channel it reads the latest 50 uploads, keeps those whose titles match the bulletin's pattern, and fetches their details. It records:

- the newest finished edition long enough to be a full one, public, and not blocked in the US;
- an edition that is live right now;
- an edition scheduled to start in the next 30 hours.

For the six broadcaster streams it follows the playlist down to a video segment from the GitHub runner, which is in the US, and records whether it played and allowed browser playback.

It also learns how each broadcaster publishes. Every new edition's YouTube time is compared with the airtime it belongs to, and the last ten are kept as `history` in `status.json`. If the median is within ten minutes of airtime the bulletin is *live*; otherwise it is *posted*, with `readyAfter` set to the time by which three editions in four were up. The run summary lists each bulletin's pattern and flags any posted edition running over two hours later than usual.

There are two kinds of run. A **full sweep**, at most every two hours, reads every channel and tests the streams, about 50 of the API's free 10,000 daily units. In between, a **focus run** reads only the bulletins that matter at that moment: live ones from three hours before airtime to an hour after, and posted ones from airtime until their edition arrives. A focus run usually costs under 25 units, so a run every 10 minutes stays under half the daily quota.

## Running it every 10 minutes

GitHub's own schedule asks for an hourly run, but on a free account GitHub delays and skips scheduled runs when it's busy; in practice they came every three to seven hours. Posted editions then reach the page hours late, and live streams can be missed because the checker never saw them scheduled. An outside scheduler that starts the workflow through GitHub's API fixes this. The hourly schedule stays as a fallback.

1. **Make a token.** GitHub → your picture → *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*. Name it `evening-edition scheduler`, set the longest expiry you're comfortable with and note the date, choose *Only select repositories* → `evening-edition`, and under *Repository permissions* set **Actions** to *Read and write*. Nothing else. Copy the token.
2. **Make the job** at [cron-job.org](https://cron-job.org) (free). *Create cronjob*:
   - URL: `https://api.github.com/repos/nickcarbone/evening-edition/actions/workflows/check.yml/dispatches`
   - Schedule: every 10 minutes
   - *Advanced*: request method `POST`; headers `Authorization: Bearer <your token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`; request body `{"ref":"main"}`
3. **Test it** with the job's *Test run*. A success is HTTP 200 or 204 and a new run under *Actions → Check bulletins*. A 401 means the token is wrong or expired; a 403 or 404 means it lacks Actions write access to this repository.

The token can only start and manage workflow runs in this one repository. If it leaks, delete it on GitHub and make another. When it expires the job starts failing with 401, and the page falls back to GitHub's slower schedule until you replace it.

On a public repository Actions minutes are free. Each run that finds something new commits `status.json`, which republishes the site; GitHub Pages allows about ten builds an hour, and at most six runs an hour stays inside that.

## Known limits

- Live detection depends on broadcasters scheduling their streams ahead, which most of these do. One that goes live without notice is picked up on the next run.
- Some streams are blocked outside their country during programmes without foreign rights. DR1 played from the US at 2am Eastern on 20 October and was blocked at 3:40am.
- Embedded YouTube will not play in some automated or data-centre browsers; this is YouTube's own check and doesn't affect normal viewing.
