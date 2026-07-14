# Real Repository Benchmark

Runs the v3 frontend-first package contract on caller-provided repositories: `scout -> analyze -> status -> optional dispatch -> Product Maps -> verify`.

The benchmark does not launch workers. It records support scope, Static Program Graph size and parser provenance, semantic-store counts, ResearchContracts and planned WorkItems, Journey closure, four Product Map artifacts, verification gates, deterministic wall time, and package size. Backend repositories must fail closed; fullstack repositories are measured only through their declared frontend subtrees.

Legacy FactGraph, gap queue, coverage, synthesis-context, and knowledge-chunk metrics are intentionally absent because they are not part of the v3 contract. The benchmark recursively checks artifact paths and textual package content, including unsupported runs.
