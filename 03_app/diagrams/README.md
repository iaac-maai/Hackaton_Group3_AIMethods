# Motion Atlas app: diagrams

The Wednesday diagrams for this app live in [`04_final/diagrams/`](../../04_final/diagrams/). Each has an editable SVG and a PNG.

| Diagram | Shows | Files |
| --- | --- | --- |
| System architecture | Browser, Worker, Render scoring API and D1, and what crosses each boundary | [SVG](../../04_final/diagrams/system-architecture.svg) · [PNG](../../04_final/diagrams/system-architecture.png) |
| Supervisor user flow | The site-supervisor story: sign in, analyse, then History overview → flagged window → score and threshold → decision | [SVG](../../04_final/diagrams/supervisor-user-flow.svg) · [PNG](../../04_final/diagrams/supervisor-user-flow.png) |
| Analysis and save sequence | The scoring request, then the separate automatic History save, with the saved and failed outcomes | [SVG](../../04_final/diagrams/analysis-and-save-sequence.svg) · [PNG](../../04_final/diagrams/analysis-and-save-sequence.png) |
| Reopen saved analysis | Loading History, opening one record (found / 404), and the optional local replay | [SVG](../../04_final/diagrams/reopen-saved-analysis.svg) · [PNG](../../04_final/diagrams/reopen-saved-analysis.png) |

The visual language, the checks against the code, and the user stories are in [`04_final/diagrams/README.md`](../../04_final/diagrams/README.md). The user stories are also in the [app README](../README.md#user-stories).
