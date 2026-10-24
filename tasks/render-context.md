# recordBody takes a context, not a six-key bag

*The bag was got wrong once and 834 records rendered differently from the route, silently. A factory and a named shape turn the production bug into a constructor.*

- **State:** pending
- **Priority:** P2
- **Owner:** worker

## Where it stands

`src/wiki-cards.mjs:932-996` takes `recordBody(record, {corpora, chunk, index, href, selfId, state, frText, lang})`, writes `opts.selfId` and `opts.state`, and takes `corpora` as a Map that passed the guard. Three call sites assemble the bag: `server.mjs:1035`, `web-bundle.mjs:126-150`, and the app bundle. The French path has a second spelling of the same context.

## Next action

A render context built once by a factory the server and both bundlers call, never written after construction, with named parts instead of six untyped keys. `recordBody` stops writing to its arguments. Acceptance: all three call sites use the factory, the fixtures build four contexts, and the rendered HTML for the 6,171 records is byte-identical to the current tree.

## Notes for a fresh session

The 834-record incident is the reason this exists: the shape was wrong and nothing failed. `corpora` being a Map rather than the expected shape passed the guard because the guard checked truthiness.
