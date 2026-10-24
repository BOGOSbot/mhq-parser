# Give the client a tree model

*Every assertion about the reader is a regex against `wiki-surface.js`, and the real bugs live in the call graph. Split the model from the view.*

- **State:** pending
- **Priority:** P2
- **Owner:** worker

## Where it stands

`src/wiki-surface.js` is a 2,306-line IIFE: state closed over at `:25-36`, DOM at `:88-787`, 40 functions, and the only interface at `:2240-2301`. `tests/test-rules-page.mjs:363-418` pulls three functions out with `new Function` and `tests/test-reader-nav.mjs:18` matches the source with a regex. None of the row logic is reachable from a test.

## Next action

A real module that takes the payloads and answers rows, order and addressing as plain functions, and a view that keeps the DOM and the scroll. The reader's behaviour must not change: the acceptance is the existing regex test suite still passing against the view, plus new model tests in Node.

## Notes for a fresh session

This lands after the title module (`tasks/title-module.md`), because the model's row labels come from there. It also shares its addressing with `tasks/rows-contract-phase2.md`: read `index/rows.json`, do not re-walk the payloads.
