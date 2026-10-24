# Training feasibility

*What can be trained and hosted without a GPU, what Upstash can and cannot do, and what the new machine changes.*

Asked 2026-10-15, when the generated pairs needed a named consumer: "a LLaMA model, and or a reranker / embedder, but we need a feasibility study. What can we host on Upstash with no GPU, and can we run the training there? Or do we need to wait for my new machine?"

Numbers below are labelled **measured** (ours, in this repo), **sourced** (someone else's measurement, cited) or **estimated** (arithmetic on one of the two). Do not promote an estimate by repetition.

## The verdicts, in one table

| Question | Verdict |
|---|---|
| Host the index on Upstash, no GPU | **Already done, and it is the right shape.** Upstash embeds server-side; we send raw text. No GPU anywhere in the path. |
| Host a *model* of ours on Upstash | **No.** Upstash Box is CPU-only containers (2-8 vCPU, 4-16 GB) built for coding agents, billed per active CPU hour, no GPU. Custom Docker is "coming soon". |
| Run the training on Upstash | **No.** No GPU and no training service in any Upstash product. |
| Use a *fine-tuned* embedder with Upstash | **Not on the current index; probably on a new one.** A hosted index's embedding model is fixed at creation. But Upstash Vector accepts **precomputed vectors** over REST, so a new index could store vectors we compute ourselves. Verify with a test upsert before relying on it. |
| Train a reranker on the current tower | **Yes, at the cheap end.** Logistic regression: minutes. MiniLM-class cross-encoder: hours. bge-m3 LoRA: no. |
| Train bge-m3 at all | **Rent a GPU for under a dollar.** On CPU it is a dead end; on a rented 3090 a LoRA run is 1-3 hours at $0.09-0.17/hr. |
| Do we need to wait for the new machine? | **No.** It makes iteration comfortable, but one-time training is cheaper to rent than to wait for. |

## 1. What we have - measured

| Fact | Value | Source |
|---|---|---|
| Tower RAM | 7.9 GB, **2.9 GB free** under load | measured, `notes/migration-linux.md` |
| Tower GPU | GTX 660 (Kepler) - **no CUDA**, driver branch dropped | measured, `notes/migration-linux.md` |
| bge-m3 inference here | **6-12 s per section**; 25.65 s for 4 records, 169.7 s and 188.0 s for two 16-record batches, 98% CPU / 2% GPU | measured 2026-10-13, `src/rules-corpus.mjs` |
| Whole wiki corpus through it | 13-25 hours | measured, `src/rules-corpus.mjs` |
| Local vector backend | flat Float32 file + cosine, milliseconds at 6,000 sections, **accepts any vectors** | measured, `src/rules-corpus.mjs` |
| Generated pairs | 282, covering **94 rules** of the ~3,460 the generator can write from | measured, `workspace/dataset/generated.jsonl` |
| Bank coverage by those pairs | **2 of 33** graded questions | measured 2026-10-15 |

The last row is the one that changes the plan. The generation lane is not merely unscaled, it is **unmeasurable**: any "do generated questions help?" test has n=2. Fix that before training is worth discussing, and it is nearly free to fix (see §5).

## 2. Upstash: an index host, not a compute host

**Upstash Vector** is what we already use. An index is created with one embedding model from their list (bge-large/base/small-en-v1.5, bge-m3, BM25 for sparse) and after that you upsert **raw text** - vectorisation happens on their side. No fine-tuning and no custom model in the hosted path.

The one opening: Upstash Vector's REST API accepts **precomputed vectors**, and its LangChain integration documents bringing your own embedding function. So the BGE-M3-bound index we have cannot hold a model of ours, but a *new* index could store vectors we produce ourselves. Sourced from the API docs and the integration page rather than an explicit "custom vectors" page - **verify with a test upsert before building on it.**

**Upstash Box** is their newer compute product: a durable isolated container with shell, filesystem, git, snapshots and an optional coding agent, in Node/Python/Go. Sizes are Small 2 vCPU / 4 GB / 5 GB, Medium 4 / 8 / 10, Large 8 / 16 / 20, priced **$0.10-0.40 per active CPU hour**; it auto-pauses when idle. Every documented use is an agent doing agent things. **No GPU, no training service.**

So: **Upstash hosts the index and does the embedding; it does not host our models and cannot train anything.** The corollary for a future fine-tune is that the vectors must be produced client-side - and the natural home is the **local backend that already exists** (flat file + cosine, any vectors), with Upstash kept as the published index.

## 3. The consumer question is really a data-shape question

"a LLaMA model, and or a reranker / embedder" are two consumers wanting two datasets, and we have one of them:

- **(question -> rule id) pairs** train a **retriever-side** model: an embedder adapter, a cross-encoder reranker, or a plain feature-based reranker. That is what the 282 pairs are.
- **A local LLM replacing the judge or the writer** needs **(question, passage, verdict)** labels - "this passage does, or does not, answer this question". That is the **trace lane**, whose reader-gold content is exactly **1 record**. No number of pairs trains it.

A LLaMA consumer is blocked on reader labels. A reranker/embedder consumer is the one the pairs fit.

## 4. The training paths, cheapest first

**A. No training at all - free, and it stays the first thing to try.** Mine the pairs for the phrasings players use per rule and feed them to `expandQuery`. No weights, no training step. Not measurable at 2.7% coverage yet (§5).

**B. A feature-based reranker - minutes, and probably the best value here.** A logistic regression (or LightGBM/LambdaMART) over features we already compute: vector dot product, BM25 score, term overlap. Trains in **under a minute** on CPU with scikit-learn, serves in **under 5 ms**, and the comparison it comes from claims Tier-C rerankers of this kind capture a large share of a neural reranker's gain for a fraction of the cost ([ThinkingLoop, 2025-09-23](https://medium.com/@ThinkingLoop/12-vector-rerankers-compared-cost-vs-quality-83703b2cbf0c)) - that "3-7 nDCG points" figure is **their claim on their data, not ours**. Our pairs carry positives *and* negatives, so the training data for this already exists in the right shape.

**C. A MiniLM-L6 cross-encoder (~22M params) - feasible on this tower.** ~90 MB, so it fits where bge-m3 does not. Estimated **1-3 hours** for 20-50k pairs by way of per-pair latency (**estimated**, scaled from ~10-20 ms/pair inference at ~3x for backward). A published walkthrough budgets "about an hour on CPU", with a GPU cutting "43 minutes to a few minutes" (**sourced**, someone else's dataset). Inference over 20-50 candidates is **100-300 ms** on CPU, 100-400 ms with ONNX int8 - it serves, and it is noticeable ([Roku engineering, 2025-03-11](https://engineering.roku.com/improving-search-relevance-using-crossencoders-and-llms)).

**D. bge-reranker-base (~278M) - borderline on CPU, fine on a GPU.** Estimated 5-10 hours CPU training (**estimated**, extrapolated from C; no direct benchmark found) and 600-5000 ms inference for 20-50 candidates - too slow to serve interactively without heavy optimisation.

**E. bge-m3 LoRA (568M) - a dead end on CPU, and cheap on a rented GPU.** The frozen base alone is ~2.3 GB in fp32 before activations, against 2.9 GB free. For scale: a 9k-pair LoRA took 6-8 hours on an M1 Ultra with PyTorch, so CPU-only is **estimated at 30-80 hours for 9k pairs and 67-222 hours for 20-50k** - days, which kills iteration ([r/LocalLLaMA, 2026-03-28](https://www.reddit.com/r/LocalLLaMA/comments/1s662vo/mlx_lora_pipeline_for_embedding_models_56_min_vs/)). On a rented RTX 3090 the same run is **1-3 hours at $0.09-0.17/hr, so under a dollar**.

## 5. What unblocks each path

1. **Make the data measurable first, for pennies.** Generate pairs for the rules the **bank already expects** (~33 rules, one call each, ~$0.25). Then measure whether each generated question retrieves its own rule through the existing index. If they self-retrieve near 100% while human bank questions sit at 54.5, the generator is producing lexically easy questions and the lane is a shortcut - the risk this repo already flags and cannot settle today. No training, no GPU, no new hardware, and it decides whether A-E are worth anything.
2. **Then B** - a feature-based reranker, minutes to train and free, evaluated on the bank. It is the cheapest thing that could actually move the player lane.
3. **Then C on CPU** if B is not enough: hours, still free.
4. **Never E on CPU.** If bge-m3 is genuinely wanted, rent a 3090/4090 for an hour (under a dollar) or wait for the new machine - either beats days of CPU.

**Renting instead of waiting.** Live Vast.ai point-in-time prices (2026-10-15): RTX 3090 24 GB from **$0.09/hr**, RTX 4090 24 GB from **$0.14/hr**. At those rates a MiniLM run is cents, a bge-reranker-base run is under $0.30 and a bge-m3 LoRA is under $1 - which makes "train it locally on CPU" hard to justify for anything but B. Prices move hourly. Vast.ai and Runpod are already in [notes/bookmarks-to-explore.md]; the used-market alternative is RTX 3090 24 GB at about EUR 1,100 or RTX 5060 Ti 16 GB new at EUR 580-840 ([notes/ex-mining-gpus-for-llm.md]).

## 6. Bottom line

Upstash is the index, not the gym: it will host and embed for us forever without a GPU, and it will never train a model for us - though a *new* index may accept vectors we compute ourselves. On the current tower, **B is nearly free and C is a few hours**; **E is a dead end on CPU and under a dollar on a rented GPU**, so "wait for the new machine" is the wrong frame for one-time training. And none of it is worth starting until the pairs cover the bank's own rules, because today the lane they feed cannot be measured at all.

Sources: [Upstash Vector - Embedding Models](https://upstash.com/docs/vector/features/embeddingmodels) · [Upstash Vector - LangChain integration](https://upstash.com/docs/vector/integrations/langchain) · [Upstash Vector intro, 2024-01-31](https://upstash.com/blog/introducing-vector-database) · [Upstash Box - How it works](https://upstash.com/docs/box/overall/how-it-works) · [Upstash Box pricing](https://upstash.com/pricing/box) · [Upstash Box, 2026-03-09](https://upstash.com/blog/upstash-box) · [SBERT cross-encoder training](https://sbert.net/docs/cross_encoder/training_overview.html) · [cross-encoder CPU walkthrough, 2025-01-17](https://ranjankumar.in/hands-on-tutorial-fine-tune-a-cross-encoder-for-semantic-similarity) · [reranker cost/quality comparison, 2025-09-23](https://medium.com/@ThinkingLoop/12-vector-rerankers-compared-cost-vs-quality-83703b2cbf0c) · [Roku cross-encoder latency, 2025-03-11](https://engineering.roku.com/improving-search-relevance-using-crossencoders-and-llms) · [bge-m3 LoRA timings, 2026-03-28](https://www.reddit.com/r/LocalLLaMA/comments/1s662vo/mlx_lora_pipeline_for_embedding_models_56_min_vs/) · [Vast.ai pricing](https://vast.ai/pricing) · local: `notes/migration-linux.md`, `notes/ex-mining-gpus-for-llm.md`, `src/rules-corpus.mjs`.
