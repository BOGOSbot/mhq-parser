---
tags:
  - mhq
  - corpus
updated: 2026-10-15
---

*What can be trained and hosted without a GPU, what Upstash can and cannot do, and what the new machine changes.*

# Training feasibility

Asked 2026-10-15, when the generated pairs needed a named consumer: "a LLaMA model, and or a reranker / embedder, but we need a feasibility study. What can we host on Upstash with no GPU, and can we run the training there? Or do we need to wait for my new machine?"

## The verdicts, in one table

| Question | Verdict |
|---|---|
| Host the index on Upstash, no GPU | **Already done, and it is the right shape.** Upstash does the embedding server-side; we send raw text. No GPU exists anywhere in the path. |
| Host a *model* of ours on Upstash | **No.** Upstash Box is CPU-only containers (2-8 cores, 4-16 GB) built for coding agents, billed per active CPU with a tiny monthly budget. No GPU. |
| Run the training on Upstash | **No.** No GPU on any Upstash product, and no training service. |
| Serve a *fine-tuned* embedder on the current Upstash index | **No.** The index's embedding model is chosen from Upstash's list when the index is created. A model of ours is not on that list. |
| Train on the current tower, CPU only | **Cross-encoder: marginal but real (~1 h CPU class). bge-m3: no.** The binding limit is 8 GB RAM (2.9 GB free), not CPU speed. |
| Do we need to wait for the new machine? | **Not to get a first real signal.** Wait for it before any bge-m3 work, or rent a GPU for a few hours instead. |

## 1. What we have, measured, not estimated

| Fact | Value | Source |
|---|---|---|
| Tower RAM | 7.9 GB, **2.9 GB free** under load | `notes/migration-linux.md` |
| Tower GPU | GTX 660 (Kepler) - **no CUDA**, driver branch dropped | `notes/migration-linux.md` |
| bge-m3 inference, this CPU | **6-12 s per section**; 25.65 s for 4 records, 169.7 s and 188.0 s for two 16-record batches, 98% CPU / 2% GPU | `src/rules-corpus.mjs` (measured 2026-10-13) |
| Whole wiki corpus through it | 13-25 hours | `src/rules-corpus.mjs` |
| Local vector backend | flat Float32 file + cosine, milliseconds at 6,000 sections, **accepts any vectors** | `src/rules-corpus.mjs` |
| Generated pairs | 282, covering **94 rules** of the ~3,460 the generator can write from | `workspace/dataset/generated.jsonl` |
| Bank coverage by those pairs | **2 of 33** graded questions | measured 2026-10-15 |

The last row is the one that changes the plan. The generation lane is not merely unscaled, it is **unmeasurable**: any "do generated questions help?" test has n=2. That has to be fixed before training is worth discussing, and it is cheap to fix (see §5).

## 2. Upstash: an index host, not a compute host

**Upstash Vector** is what we already use. An index is created with one embedding model from their list (bge-large/base/small-en-v1.5, bge-m3, and BM25 for sparse), and after that you upsert **raw text** - the vectorisation happens on their side. There is no fine-tuning, no custom model, and no GPU to rent. The model is a property of the index, fixed at creation.

**Upstash Box** is their newer compute product: a durable isolated container per box, with a shell, filesystem, snapshots and an optional coding agent, in Node/Python/Go. Read the limits before dreaming: **small 2 cores / 4 GB, medium 4 / 8 GB, large 8 / 16 GB**, 5-20 GB storage, up to 10 concurrent boxes, and the pricing page advertises **5 CPU hours per month**. It is built for agent work that mostly waits on model inference - billed per *active* CPU, auto-pausing when idle. Every documented use is an agent doing agent things. There is no GPU and no training service anywhere in the product line.

So the honest split: **Upstash hosts the index and does the embedding; it does not host our models and cannot train anything.** That is not a limitation to work around - it is why the current stack has zero dependencies and no GPU in the path at all.

The corollary matters for a future fine-tune: a model of ours cannot live on the BGE-M3 index. If we ever fine-tune an embedder, the vectors must be produced client-side, and the natural home is the **local backend that already exists** (flat file + cosine, any vectors). Upstash stays the published index for the deployed page.

## 3. The consumer question is really a data-shape question

"a LLaMA model, and or a reranker / embedder" are two different consumers wanting two different datasets, and we only have one of them:

- **(question -> rule id) pairs** train a **retriever-side** model: an embedder adapter, or a cross-encoder reranker. That is what the 282 pairs are.
- **A local LLM replacing the judge or the writer** needs **(question, passage, verdict)** labels - "this passage does, or does not, answer this question". That is the **trace lane**, whose reader-gold content is exactly **1 record**. The pairs cannot train it, no matter how many we generate.

So a LLaMA consumer is blocked on reader labels, not on pairs. A reranker/embedder consumer is the one the pairs actually fit - which is also the cheaper model to train and the one that would shorten the pipeline.

## 4. The three training paths, cheapest first

**A. No training at all.** Mine the pairs into an expansion / alias vocabulary: the phrasings players use for a rule, keyed by rule id, feeding `expandQuery`. No GPU, no weights, no training step. At 2.7% rule coverage this is not measurable yet - see §5 - and it stays the cheapest thing to try once coverage exists.

**B. A small cross-encoder reranker (MiniLM-L6 class, ~22M params).** The only training that fits this tower. The model is ~90 MB: it fits in the 2.9 GB free, where bge-m3 does not. A published walkthrough budgets **about an hour on CPU** for a cross-encoder fine-tune, with a GPU cutting "about 43 minutes to a few minutes" on the same data - treat that as an order of magnitude from someone else's dataset, not our number ([ranjankumar.in, 2025-01-17](https://ranjankumar.in/hands-on-tutorial-fine-tune-a-cross-encoder-for-semantic-similarity)). It would rerank the top 20-50 candidates client-side or on a small VM. This is the cheapest real learning signal available without new hardware.

**C. A bge-m3 LoRA (568M params).** Not on this box. The frozen base alone is ~2.3 GB in fp32 before activations and optimiser state, against 2.9 GB free with Windows and Firefox resident - and inference with the same model already costs 6-12 s per section. Full fine-tuning of 568M needs a GPU; every practical guide to LoRA/QLoRA assumes one. On a 16 GB card, a bge-m3 LoRA is comfortable.

## 5. What unblocks each path

1. **Make the data measurable first, for pennies.** Generate pairs for the rules the **bank already expects** (~33 rules, one call each). Then measure whether each generated question retrieves its own rule through the existing index. If generated questions self-retrieve near 100% while human bank questions sit at 54.5, the generator is producing lexically easy questions and the whole lane is a shortcut - the exact risk this repo already flags and cannot currently settle. **No training, no GPU, no new hardware, and it decides whether paths A, B and C are worth anything.**
2. **Then try B on CPU.** One hour of training for a first cross-encoder, evaluated on the bank. If it moves the player lane, it has earned the next step.
3. **Only then C**, on the new machine or a rented GPU.
4. **Renting instead of waiting.** Vast.ai and Runpod are already bookmarked ([notes/bookmarks-to-explore.md]) and a 3090/4090-class card is a few dollars for a few hours - likely less than the electricity and the evening spent fighting a CPU. Note the used-market alternative already researched: RTX 3090 24 GB at about EUR 1,100, RTX 5060 Ti 16 GB new at EUR 580-840 ([notes/ex-mining-gpus-for-llm.md]).

## 6. Bottom line

Upstash is the index, not the gym: it will host and embed for us forever without a GPU, and it will never train a model for us. The **current tower** can train a small cross-encoder and nothing bigger; the **new machine (RTX 5060 Ti 16 GB)** makes bge-m3 work comfortable; a **rented GPU for a few hours** is the way to avoid waiting for it. And none of that is worth starting until the pairs cover the bank's own rules, because today the lane they feed cannot be measured at all.

Sources: [Upstash Vector - Embedding Models](https://upstash.com/docs/vector/features/embeddingmodels) · [Upstash Box - How it works](https://upstash.com/docs/box/overall/how-it-works) · [Upstash Box pricing](https://upstash.com/pricing/box) · [Upstash Box, 2026-03-09](https://upstash.com/blog/upstash-box) · [SBERT cross-encoder training](https://sbert.net/docs/cross_encoder/training_overview.html) · [cross-encoder CPU walkthrough, 2025-01-17](https://ranjankumar.in/hands-on-tutorial-fine-tune-a-cross-encoder-for-semantic-similarity) · local: `notes/migration-linux.md`, `notes/ex-mining-gpus-for-llm.md`, `notes/bookmarks-to-explore.md`, `src/rules-corpus.mjs`.
