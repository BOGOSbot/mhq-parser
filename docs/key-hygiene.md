# Key hygiene and box hardening

Where the keys live, what must never touch a prompt or a command line, and the
checklist for the box that serves the /rules preview. The credential-store path
is in `src/rules.mjs`; the corpus it searches is described in
`docs/corpus-storage.md`, the page in `docs/rules-page.md`.

## Where a key comes from

`credential(name)` reads the environment first, then one line of the
machine-global DSH store at `~/.dsh/.credentials.yaml` (`DSH_CREDENTIALS`
points at another file; a public deployment sets the variables and never has the
store). The names in use: `OPENCODE_GO_API_KEY` (Jev), `SENSENOVA_API_KEY`
(the writer), `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` (the
index), and whatever `RULES_*_KEY` names a configured route.

The store lives outside the repository, and nothing in the repository holds a
key. `git grep` over the tracked tree finds no secret-shaped string; the
untracked server logs hold none either; there is no credential-shaped file
anywhere under the repository. Nothing accepts a key as a command-line argument:
no script in `src/` or `tests/` parses one, and `vectorConfig()` has no
fallback URL or token, so a missing key fails its step instead of falling back to
something baked in.

## The standing rules

- **A key lives in the credential store or the environment, nowhere else.** Not
  in a file in the repository, not in a fixture, not in a test, not in a comment,
  not in a chat message, not in a prompt.
- **Never on a command line.** The box CLI echoes the command it ran into stderr,
  and stderr is captured in a log - so `curl -H "Authorization: Bearer ..."`,
  `KEY=... node ...` and `--key ...` all end up written to a file by the side
  effect of being run. Set the variable in the environment or the store.
- **Never in a prompt.** The translation, judge and writer prompts carry the
  question and the findings; a key pasted into one is a key in the model
  provider's request log.
- **Snapshots capture any key written to a file.** The Box snapshot is a copy of
  the filesystem, so a key that reached a file - an `.env`, a shell history, a
  log with an echoed command - is in the recovery point too.
- **Rotate on any exposure**, and treat "it was only in a log" as exposure: the
  log is on disk, the disk is snapshotted, and the snapshot is off-machine.
- **One key, one purpose.** A key that signs a git push is not a key that spends
  the writer, and neither is a key that reads the index.

## Box hardening checklist

The box is Upstash Box (2-8 vCPU, no GPU) serving the /rules preview, and it
brings its own keys - the platform's "LLM budget" is not a model it serves.

- [ ] **Scope the git PAT.** `/home/boxuser/.git-credentials` holds a
      fine-grained, **read-only** token limited to the two repositories this box
      clones, with a short expiry - not a classic PAT with `repo` scope, and not
      a deploy key that can write anywhere else.
- [ ] **Put auth in front of the /rules preview URL.** Every request that reaches
      the page can spend the writer key, so an open preview is an open wallet.
      Put the access control in front of the whole route, not only in front of
      `/rules/ask`.
- [ ] **Restrict egress to the LLM endpoints plus Upstash.** The writer's
      endpoint, the fast route's endpoint, the Jev gateway and the Upstash vector
      REST host are what a serving box needs; Wahapedia only while scraping.
      Nothing else outbound.
- [ ] **Rotate on any exposure.** If a key reached a file, a log, a snapshot or a
      transcript, rotate it - the snapshot keeps the old one alive, and deleting
      the file does not reach back into an existing snapshot.
- [ ] **Know what the snapshot takes.** The recovery point is the whole
      filesystem, so treat it as readable by everyone who can read the box's
      storage, and keep anything that must not be in it off the disk.
