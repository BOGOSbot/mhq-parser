# Deploying /rules on an Upstash Box

*The public test deployment: a small Box behind a public URL with basic auth, its
startup command, and the way back to nothing.*

`/rules` is a long-lived Node server with a ~40 MB corpus on disk (no npm
dependencies), so it needs a container, not a serverless function. The Box is the
one host in the current stack that runs it unchanged.

## What is live (2026-10-23)

| | |
|---|---|
| Box | `optimum-imp-60273`, runtime node, size small, network `allow-all` |
| App | `/workspace/home/mhq-parser`, started by the box's init command |
| Build | `0afeb1a16714`, from the `BUILD` file the archive carries (`/health` reports it; `source:file`) |
| Corpus | payloadStamp `6d92e794`, 7,426 records / 6,363 delivered, 771 rules + 6,501 faction, export June 2026 |
| Owed | the vector index is 36 `rules` records behind the corpus, so `--ingest` then `--prune` are still to run - the drawer and the lexical find read the payload and are current, `ask` retrieves from the index |
| URL | `https://optimum-imp-60273-3000.preview.box.upstash.com` - **no auth during the mobile test**; `box public-url 3000 --basic-auth` puts it back (it overwrites the URL's credentials) |
| Short link | `https://tinyurl.com/2y7uju8c` -> `/rules` (a tinyurl redirect; the Box URL is the real one) |
| Keys | `/home/boxuser/.dsh/.credentials.yaml`, five keys: Upstash Vector URL +
  token, `OPENCODE_GO_API_KEY` (Jev free gateway), `SENSENOVA_API_KEY` (judge and
  fast model), `TINYFISH_API_KEY` |
| Traces | on (`RULES_TRACES=1`), so a test question is kept anonymously |

Cost: a small box is $0.10 per active CPU hour against a free tier of 10
concurrent boxes and 5 CPU-hours/month; it auto-pauses when idle and a request to
the public URL wakes it (the URL survives the pause, and the init command starts
the app again - verified: 200 in 2 s, a new node pid). The first request after a
long idle can take longer while the container resumes.

## First deploy

1. **Archive the app.** The corpus and the baked payloads are untracked, so a git
   clone is not enough: `tar -czf mhq-deploy.tgz BUILD src img workspace/rules-corpus
   workspace/wiki-data workspace/web-bundle.zip workspace/app-bundle.zip`.
   **The two zips are not optional either**: `/web-bundle.zip` is the one download the
   WebView app makes, and the server serves the file from disk (`WEB_BUNDLE_ZIP` or
   `workspace/web-bundle.zip`), so an archive without them leaves the Box handing the
   phone yesterday's client and payload while the server page itself is current
   (measured 2026-10-24: the Box served a 6,530,707-byte zip while the rebuilt one was
   6,496,461). `BUILD` is the file `/health` reads to name the build. The archive's
   `sha256` is checked inside the box after the parts are joined; at ~26 MB split it
   into 8 parts, not 6, because `files upload` refuses a part past a few MB.
   **img/ is not optional**: `src/server.mjs` reads `img/favicon-32.png` and
   `img/apple-touch-icon.png` at boot, and a missing file falls back to a 119-byte
   placeholder that answers 200. An archive without `img/` deploys a page whose
   favicon is silently wrong, which is what task-63 exists for.
2. **Create the box.**
   `box create --runtime node --size small --name mhq-rules --no-repl --no-use --json --network-policy allow-all`
3. **Upload.** `box files upload` refuses the 12.7 MB archive ("exceeds maximum
   size of 100 MB" for a 12.7 MB file - the cap is a few MB). Split it into four
   3.9 MB parts, `box files upload` each, then `cat mhq.part* > mhq.tgz && tar xzf`
   in the box. `files write --encoding base64` from PowerShell stdin did not work
   ("invalid base64 content"); `files upload` on split parts did.
4. **Credentials.** Write the five `NAME: value` lines to the box's
   `/home/boxuser/.dsh/.credentials.yaml` (upload a temp file, then `mv` it). The
   app reads env first, then that flat file.
5. **Start it detached**, or it dies with the exec:
   `cd /workspace/home/mhq-parser && RULES_TRACES=1 nohup node src/server.mjs --host 0.0.0.0 --port 3000 >> /tmp/rules.log 2>&1 &`
   Check `curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/health`.
6. **Make it survive a pause**: the same command as the init command.
   `box config init-command set '<command above>'` (the subcommand is `set`;
   without it the CLI reads the first word as a subcommand).
7. **Publish the port.** `box public-url 3000 --basic-auth --json` returns the URL
   and the generated user/password. One URL per port; recreating it overwrites the
   old credentials.
8. **Check the build and the brand icons, not just the status code.** A 200 is not
   evidence: the fallback answers 200 too, and a process that was never restarted keeps
   answering from the modules it loaded at boot. `node src/deploy-check.mjs <url>
   --expect $(git rev-parse --short=12 HEAD)` fetches `/health`, compares its `build.commit`
   with the commit this deploy shipped, and then fetches `/favicon.png`, `/favicon.ico` and
   `/apple-touch-icon.png` and fails unless the bytes are the real files' (2,620 and 32,093).
   Run it against the public URL after every deploy. It is the check that would have caught
   task-63 on the first deploy rather than the tenth, and task-90 every time it happened
   (measured 2026-10-24: the check fails with 'THE BOX IS SERVING ANOTHER BUILD' when the
   expectation and `/health` disagree, and also when `/health` cannot name its build at all).

## Refresh the app after a change

Rebuild the archive, upload the parts, extract over the old tree, then stop the old
node and start it again (or `box pause` then a request to the URL, which runs the
init command). The corpus and payloads are part of the archive, so a rebake is a
redeploy.

**Kill and start in two execs, never one.** `pkill -f "node src/server.mjs"`
matches the exec wrapper's own command line when the start command is in the same
string - the pattern appears in it - so the shell kills itself before the restart
and the deploy ends silently with the app down. Kill by pattern in one
`box exec` (the bracket in `node src/server[.]mjs` keeps the pattern from matching
its own text), then run the `nohup` start in a second exec and check
`curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/health` from the box.

## Tear down

`box delete --yes` removes the box, the app and the public URL. A box that exists
costs money even paused, so delete it when the test is over.

## Known limits of this deployment

- **The test URL is open** (no auth) because basic auth was friction on a phone. The host is an unguessable box id, not a secret; republish with `--basic-auth` for anything longer-lived.
- **The preview proxy is slow for a buffered response and fine for a stream.** The same question, measured 2026-10-18: **27.6 s in-box** (steps: retrieve+judge 13.1 s), **182 s through the public URL as one JSON body** (`stream:false`), and **0.68 s to the first SSE event** with a ~100 s total on the page's streaming path. The page streams, so a phone shows progress from under a second; a plain API client asking for `stream:false` will think the box is broken.
- **The paid judge route is not usable for a test yet.** `RULES_JEV_GATEWAY=openrouter` measured 289 s for one question and then hung past 10 minutes while the box sat idle at 0.6 % CPU and `openrouter.ai` answered in 51 ms from inside it. The Box runs the free gateway; the OpenRouter key stays in its credentials file, so the switch is one env var.
- **Cold wake** can exceed a phone's default timeout: the proxy holds the request
  while the box resumes and waits up to 30 s more for the port, then 503 with
  `Retry-After: 5`.
- **The free Jev gateway rate-limits.** A degraded run still answers, with the
  judge's verdict weaker. `RULES_JEV_GATEWAY=openrouter` plus the OpenRouter key
  (~$0.007 per question) is the paid override, a decision for Mandal.
- The army-list half (`/`, `/parse`) works, but `archive/` is not shipped: its
  counters read 0 on the box.