# Give rules-corpus a seam

*`rules-corpus.mjs` is 5,735 lines and 204 exports. The interface is the implementation, so a caller who wants one function imports the scraper.*

- **State:** pending
- **Priority:** P3
- **Owner:** worker

## Where it stands

Nine regions in one file: scrape, shape, embed, retrieve, rerank, agent, writer. Sixteen env knobs are frozen at import. Module-level counters make tests order-dependent, which is why the retry test runs two child processes to check one branch. `isDelivered` is the model to copy: one definition, 31 call sites.

## Next action

Four modules behind four small interfaces: corpus (read, build, write, the delivery predicate), retrieve, agent, gateway. The agent path is parked, so it needs a seam that keeps its tests off the scraper, not a rewrite. Acceptance: a retrieval test imports no scraper name, and the counters are owned by the caller.

## Notes for a fresh session

This is the largest slice and the one with the least product value today. Do it after the payload and client work unless a specific change forces it. Do not move code and change behaviour in the same commit.
