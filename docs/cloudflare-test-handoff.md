# Cloudflare search + rerank test

*Keep the server and the index on Upstash; add Cloudflare's reranker and AI Search as optional arms, and let the 39-question bank decide.*

Written 2026-10-15 from the assessment in the vault (notes/mhq-cloudflare-hosting.md). Nothing here is deployed: both arms sit behind env flags, the Upstash path stays the default until a reading beats it.

## The one-line version

The reranker is the cheap, juicy win and it does not require moving anything: bge-reranker-base costs about 130 Neurons for a whole 78-call eval run, inside the 10,000 Neurons/day free allowance, and it removes the Jev gateway and the 429-driven DEGRADED runs. Do that first. The full Cloudflare retrieval arm is a second, slower experiment.

## What already exists

- AI Search instance **40k** in the default namespace of the account, built-in vector DB at **1,024 dims**, currently **0 indexed** (its last job saw "1 pages/batches, 0 files"). Account id is the one in the dashboard URL.
- The eval instrument: `tests/eval-retrieval.mjs`, 39 questions, 78 rerank calls per run, noise floor 2-4 points.
- The deployed reading to beat, rerank ON: exact hit@1 **54.5**, reachable **60.6**, MRR **0.633 / 0.696**.
- The rerank-off control on the same index state: exact 30.3 / reachable 33.3, MRR 0.454 / 0.495.

## Token

Create a custom API token (My Profile > API Tokens) with:

- Account > **AI Search:Edit**
- Account > **AI Search:Run**
- Account > **Workers AI:Read** (the reranker is a Workers AI model)

Store it in the DSH credential store as `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`, which is not a secret), never inline, never printed - `tests/test-dev.mjs` already asserts that known credential values do not reach the HTML. Same rule as the Upstash pair in `docs/key-hygiene.md`.

## Arm 1 - swap the reranker (do this first)

Call the cross-encoder directly from the Node server; no Worker, no index move.

    POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/baai/bge-reranker-base
    Authorization: Bearer $CLOUDFLARE_API_TOKEN
    { "query": "...", "contexts": [{ "text": "..." }, ...], "top_k": 20 }

The response is the scored contexts in order; map back to records by position. Constraints and costs:

- **512 input tokens per context.** A record is capped at 2,000 characters, so most fit; truncate the tail for the rest and record that you did - do not silently drop records.
- $0.00311 per M input tokens = **283 Neurons per M tokens**. 78 calls x ~20 contexts x ~300 tokens is about 0.5M tokens = **~130 Neurons per run**, inside the 10,000/day free tier.
- Wire it as `RULES_RERANK=jev|cf|off` in the rerank function of `src/rules-corpus.mjs`; keep `jev` the default. One function, no Upstash change.
- Acceptance: two clean runs of

    node tests/eval-retrieval.mjs --retriever dual --per-side 10 --net 60 --topk 20 --rerank on

  with **0 fallbacks**, exact/reachable hit@1 and MRR compared against 54.5 / 60.6 and 0.633 / 0.696. A win has to clear the 2-4 point noise floor; a tie is a win, because it also removes the gateway, its cost and its rate limits.

## Arm 2 - Cloudflare retrieval as a second retriever

Only after Arm 1. Build it as an extra arm in the eval harness, never as the deployed path.

- Instance: `POST /accounts/{id}/ai-search/namespaces/default/instances` with `{"id":"rules-cf"}` (reuse `40k` or make a clean one - the failed first upload is still in it).
- Upload one file per record: `POST .../instances/{id}/items` with `-F file=@...`. 100k files/instance is the free ceiling and the corpus is 6,271 records, so one file per record is the way to keep the structural records intact; AI Search chunks recursively, so set the chunk size at or above the record size and verify you get one chunk per file.
- Query: `POST .../instances/{id}/search` with

      { "messages": [{ "role": "user", "content": "..." }],
        "ai_search_options": { "retrieval": { "retrieval_type": "hybrid", "fusion_method": "rrf", "max_num_results": 20 },
                               "reranking": { "enabled": true, "model": "@cf/baai/bge-reranker-base" } } }

  Each chunk comes back with `scoring_details`: vector_score, keyword_score, vector_rank, keyword_rank, fusion_method, reranking_score. Log those into the trace store the same way the Upstash arms do, or the bank cannot read the arm.
  Use `/search`, not `/chat/completions` - generation stays ours.
- **Trap: AI Search namespaces are API path containers, not the vector namespaces we use.** Our rules/factions/rulings split has to become three instances, three folders, or metadata - not "namespaces". Built-in `filename` / `folder` / `timestamp` help; custom metadata is capped at **5 fields**, and our record carries id, source, set, heading, ruleId, anchor, url, chars, hash - so pick five and put the rest in the file path.
- Free budget, before billing starts **2026-11-01**: 5M ingestion tokens + 10 GB-month + **1,000 semantic and 1,000 full-text queries per month**. The corpus is ~3-4M tokens, so **one full rebuild per month fits**; a hybrid query spends one of each. Keep the eval bank under roughly 900 runs/month or the meter becomes the experiment.
- Measure p50 latency for search and for rerank separately, from the Box (it runs in AWS us-east-1): two extra round trips per question is the cost the bank will not show.

## What not to do

- Do not port `server.mjs` to Workers for this test: no fs, 10 ms CPU per request on free, and Cloudflare Containers are paid. The server stays on Upstash Box.
- Do not change the deployed retriever or reranker until a reading beats the current one.
- Do not publish the corpus or the index. It is copyrighted third-party material and stays account-private on Cloudflare exactly as it is on Upstash (`docs/corpus-storage.md`).

## Decision rule

Arm 1 holds the head -> adopt the Cloudflare reranker, keep Upstash, close the question. Arm 2 beats the deployed reading by more than the noise floor -> then, and only then, discuss moving the index and the host.

## Sources

[AI Search REST search](https://developers.cloudflare.com/ai-search/api/search/rest-api/) · [Items REST](https://developers.cloudflare.com/ai-search/api/items/rest-api/) · [hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/) · [reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/) · [metadata](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/) · [supported models](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/) · [limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) · [bge-reranker-base](https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/).
