# Human Readable Visual Contract

Use the current package as the truth source.

## Architecture SVG

- Read diagram data from `static/code-map.json#architecture`.
- Use semantic components first, then boundaries, then sparse connections.
- Keep evidence-first labels and preserve source paths as traceable text.
- Do not import or copy external renderer code; use the local generator in `shared/understanding/human-readable-html.mjs`.

## Surface

- Use off-white paper, near-black ink, and one IKB-style accent.
- Keep information dense but readable.
- Prefer hairline grid and sharp panels.
- Avoid decorative gradients, blobs, fake screenshots, and marketing hero copy.
- Visible text should describe the repository and package artifacts, not the implementation rationale.

## Verification

- Page is nonblank.
- Architecture SVG is visible.
- Validation, coverage, verifier, and gap data are populated.
- Mobile width does not overlap text.
- Theme toggle works.
- SVG export does not throw.
