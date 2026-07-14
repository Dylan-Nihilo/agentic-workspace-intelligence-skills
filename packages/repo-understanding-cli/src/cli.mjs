#!/usr/bin/env node

// Deterministic suite entrypoint. Agent execution remains owned by the host runtime.
await import('./commands.mjs')
