# Deploying /rules on an Upstash Box

*The public test deployment: a small Box behind a public URL with basic auth, its
startup command, and the way back to nothing.*

`/rules` is a long-lived Node server with a ~40 MB corpus on disk (no npm
dependencies), so it needs a container, not a serverless function. The Box is the
one host in the current stack that runs it unchanged.

## What is live (2026-10-18)

| | |
|---|---|
| Box | `optimum-imp-60273`, runtime node, size small, network `allow-all` |
| App | `/workspace/home/mhq-parser`, started by the box's init command |
| URL | `https://optimum-imp-60273-3000.preview.box.upstash.com` (basic auth) |
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
   clone is not enough: `tar -czf mhq-deploy.tgz src workspace/rules-corpus
   workspace/wiki-data` (12.7 MB gzipped, 41 MB inside the box). The archive's
   `sha256` is checked inside the box after the parts are joined.
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

## Refresh the app after a change

Rebuild the archive, upload the parts, extract over the old tree, then
`box exec -- 'cd /workspace/home/mhq-parser && pkill -f "node src/server.mjs" ; ...'`
and start it again (or `box pause` then a request to the URL, which runs the init
command). The corpus and payloads are part of the archive, so a rebake is a
redeploy.

## Tear down

`box delete --yes` removes the box, the app and the public URL. A box that exists
costs money even paused, so delete it when the test is over.

## Known limits of this deployment

- **Basic auth** is what keeps the URL private; it is not an account system.
- **Cold wake** can exceed a phone's default timeout: the proxy holds the request
  while the box resumes and waits up to 30 s more for the port, then 503 with
  `Retry-After: 5`.
- **The free Jev gateway rate-limits.** A degraded run still answers, with the
  judge's verdict weaker. `RULES_JEV_GATEWAY=openrouter` plus the OpenRouter key
  (~$0.007 per question) is the paid override, a decision for Mandal.
- The army-list half (`/`, `/parse`) works, but `archive/` is not shipped: its
  counters read 0 on the box.