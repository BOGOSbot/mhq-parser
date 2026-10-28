# Docs

*One line per topic. The doc holds the detail; this page only routes.*

## The army-list parser

| Doc | What it covers |
| --- | --- |
| [formats.md](formats.md) | The source formats the parser accepts, and the JSON it writes |
| [developer-doc.md](developer-doc.md) | How the parser is built: URL shapes, the exporter, the seams a change crosses |
| [warnings.md](warnings.md) | The warnings the parser raises, what each means, and the weekly recompute |

## The /rules page and its corpus

| Doc | What it covers |
| --- | --- |
| [rules-page.md](rules-page.md) | The page itself: the two corpora, the ask path, the reader, the wiki tree, the decisions behind each |
| [mfm-source.md](mfm-source.md) | The faction half and the missions read from GW's own app export (the MFM dump), and the CSV rollback |
| [gdm-canon.md](gdm-canon.md) | gdmissions.app's data changelog as the canon for staleness: `--check`, `--update`, and the 2026-10-28 verification |
| [corpus-storage.md](corpus-storage.md) | Where the corpus lives, how it is snapshotted, and what a rebuild re-downloads |
| [corpus-wiki.md](corpus-wiki.md) | The original design of the corpus as a wiki, with the phase A and B measurements that shaped it |
| [dataset.md](dataset.md) | The record shape and the label sources behind the citation metric |
| [question-traces.md](question-traces.md) | The traces kept for a question, what they contain, and how to read one |
| [translate.md](translate.md) | The French path: dictionaries, the glossary, and why the overlay is frozen |
| [glossary-fr-en.md](glossary-fr-en.md) | The FR to EN glossary itself, the reference table the translation pass reads |
| [training-feasibility.md](training-feasibility.md) | Whether this corpus could train a model, and the arithmetic |
| [wiki-revamp-prd.md](wiki-revamp-prd.md) | The PRD for the wiki revamp, and what of it still stands |

## Operating it

| Doc | What it covers |
| --- | --- |
| [deploy.md](deploy.md) | Deploying /rules on an Upstash Box: the archive, the split, the restart, the check that proves it |
| [key-hygiene.md](key-hygiene.md) | Where the keys live, and how the box is hardened |
| [cloudflare-test-handoff.md](cloudflare-test-handoff.md) | The Cloudflare search and rerank trial, and what it would take to leave the Box |
| [HANDOFF.md](HANDOFF.md) | The 2026-10-12 restart point for /rules: what was live then and what was measured |

## Not a doc

The changelog is the commits. A task in flight is an artifact in [tasks/](../tasks/) with its line in [STATUS.md](../STATUS.md). An architecture review lives in the workspace, not here, because it describes a proposal and not the code.
