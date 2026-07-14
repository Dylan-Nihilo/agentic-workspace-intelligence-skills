# Human-readable HTML layer

> Archived v2 design. The current HTML projection consumes the v3 Product Maps,
> governed Journeys, semantic Evidence/Claims, and the accepted synthesis narrative.
> See `docs/repo-understanding-harness-design.md` and
> `skills/repo-human-readable/references/visual-contract.md`.

This layer turns an existing `repo-understanding` package into one static HTML page.

## Goal

Give a reader a fast, evidence-backed understanding of a repository without opening raw JSON first.

The page is a projection, not a fact source. It reads existing artifacts and writes only:

```text
<package-dir>/human-readable.html
```

## Inputs

- `static/code-map.json#architecture` for the semantic architecture model
- `fact-graph.json` for nodes, edges, confidence, and high-importance files
- `gap-queue.json` for unresolved work
- `verification.json` for adversarial verifier outcomes
- `validation.json` for quality gate state
- `index.json` for package metadata and counts
- `knowledge-index.json` for evidence references when available

## Visual Direction

The page uses a Swiss engineering-report style:

- off-white paper, near-black ink, and one IKB-style accent
- dense information hierarchy
- sharp panels and hairline separators
- inline SVG architecture diagram
- no decorative gradients, fake screenshots, or marketing copy

The architecture diagram borrows Archify's method, not its renderer:

- semantic components before drawing
- explicit boundaries
- sparse connections
- evidence-first labels
- self-contained SVG with theme-aware CSS classes

## Commands

```bash
npm run --silent understanding:human-html -- --package <package-dir>
npm run --silent understanding:harness -- html --package <package-dir>
```

Optional:

```bash
npm run --silent understanding:human-html -- --package <package-dir> --out <file.html>
```

## Verification

```bash
node --check shared/understanding/human-readable-html.mjs
npm run --silent understanding:human-html -- --package outputs/code-understanding/shop-manage-mobile-20260706-182841
npm run --silent understanding:harness -- html --package outputs/code-understanding/shop-manage-mobile-20260706-182841 --out /tmp/shop-readable.html
```

Then open the generated page and check that:

- architecture SVG is visible
- validation, coverage, verifier, and gap data are populated
- text does not overlap at narrow widths
- theme toggle works
- SVG export does not throw
