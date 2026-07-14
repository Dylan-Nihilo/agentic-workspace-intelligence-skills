#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const skillNames = [
  'repo-understanding',
  'repo-explorer',
  'repo-fact-verifier',
  'repo-synthesizer',
  'repo-human-readable',
]

const triggerPhrases = {
  'repo-understanding': [
    'only supported end-to-end workflow',
    'understand a frontend codebase',
    'reconstruct user journeys',
    'repo knowledge package',
  ],
  'repo-explorer': [
    'semantic-research ResearchContract',
    'evidence-backed Hypotheses',
    'TaskOutcome',
  ],
  'repo-fact-verifier': [
    'adjudicate conflicting semantic Hypotheses',
    'high-risk frontend Journey bindings',
    'adjudicate ResearchContract',
  ],
  'repo-synthesizer': [
    'human-facing synthesis',
    'synthesize repo-work-item/v3',
    'completed Application, Experience, Runtime Flow, and Change Maps',
  ],
  'repo-human-readable': [
    'self-contained HTML view',
    'final readable projection',
    'existing frontend repo-understanding package',
  ],
}

const cases = [
  {
    expected: 'repo-understanding',
    prompt: 'Analyze this React frontend end to end and produce governed journeys plus the application, experience, runtime-flow, and change maps.',
  },
  {
    expected: 'repo-explorer',
    prompt: 'Investigate the semantic ambiguity in this ResearchContract: compare hypotheses, cite source evidence, and return a TaskOutcome.',
  },
  {
    expected: 'repo-fact-verifier',
    prompt: 'Resolve a conflict between hypotheses for a high-risk request/outcome Journey binding under the adjudication contract.',
  },
  {
    expected: 'repo-synthesizer',
    prompt: 'Summarize the completed four product maps and governed journeys into the reader-facing narrative without inspecting source code.',
  },
  {
    expected: 'repo-human-readable',
    prompt: 'Render the validated maps, journeys, and narrative into a standalone self-contained HTML artifact.',
  },
]

const nonAgentCases = [
  'Infer product intent from stakeholder interviews and roadmap documents.',
  'Observe an external payment runtime and production traffic behavior.',
  'Repair an unresolved import and parser failure in the deterministic graph.',
]

try {
  const skills = Object.fromEntries(skillNames.map(name => [name, readSkill(name)]))
  const forbiddenRuntimeTerms = /\bCodex\b|\bClaude\b|codex exec|Task tool|spawn_agent/
  for (const skill of Object.values(skills)) {
    assert(JSON.stringify(frontmatterKeys(skill.body)) === JSON.stringify(['description', 'name']), `${skill.name} frontmatter must contain only name and description`)
    assert(!forbiddenRuntimeTerms.test(skill.body), `${skill.name} SKILL.md contains runtime-specific instructions`)
    for (const phrase of triggerPhrases[skill.name]) {
      assert(normalize(skill.description).includes(normalize(phrase)), `${skill.name} description is missing trigger phrase: ${phrase}`)
    }
  }
  for (const testCase of cases) {
    const ranked = rankPrompt(testCase.prompt, skills)
    assert(ranked[0].score > 0, `no skill matched: ${testCase.prompt}`)
    assert(
      ranked[0].name === testCase.expected,
      `expected ${testCase.expected}, got ${ranked[0].name} for ${testCase.prompt}; scores=${JSON.stringify(ranked)}`,
    )
    assert(ranked[0].score > ranked[1].score, `ambiguous trigger between ${ranked[0].name} and ${ranked[1].name}`)
  }
  for (const prompt of nonAgentCases) {
    const rankedLeaves = rankPrompt(prompt, skills).filter(value => value.name !== 'repo-understanding')
    assert(rankedLeaves.every(value => value.score === 0), `non-semantic work must not trigger a leaf agent: ${prompt}`)
  }
  console.log(JSON.stringify({
    schemaVersion: 'repo-triggering-eval/v3',
    passed: true,
    checked: [
      'skills:minimal-frontmatter',
      'skills:runtime-neutral-prose',
      'trigger:repo-understanding',
      'trigger:repo-explorer',
      'trigger:repo-fact-verifier',
      'trigger:repo-synthesizer',
      'trigger:repo-human-readable',
      'trigger:product-intent-no-leaf-agent',
      'trigger:runtime-external-no-leaf-agent',
      'trigger:deterministic-diagnostic-no-leaf-agent',
    ],
  }, null, 2))
} catch (error) {
  console.error(error.stack || error.message)
  process.exitCode = 1
}

function rankPrompt(prompt, skills) {
  const descriptions = skillNames.map(name => skills[name].description)
  return skillNames
    .map(name => ({ name, score: descriptionScore(prompt, skills[name].description, descriptions) }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}

function readSkill(name) {
  const file = path.join(repoRoot, 'skills', name, 'SKILL.md')
  const body = fs.readFileSync(file, 'utf8')
  return { name, body, description: readFoldedDescription(body) }
}

function readFoldedDescription(body) {
  const lines = body.split(/\r?\n/)
  const index = lines.findIndex(line => /^description:\s*/.test(line))
  if (index < 0) return ''
  const inline = lines[index].replace(/^description:\s*/, '').trim()
  if (inline && inline !== '>-' && inline !== '>' && inline !== '|-' && inline !== '|') return inline
  const values = []
  for (let cursor = index + 1; cursor < lines.length && /^\s+\S/.test(lines[cursor]); cursor += 1) {
    values.push(lines[cursor].trim())
  }
  return values.join(' ')
}

function frontmatterKeys(body) {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return []
  return match[1]
    .split(/\r?\n/)
    .map(line => line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):/u)?.[1])
    .filter(Boolean)
    .sort()
}

function descriptionScore(prompt, description, descriptions) {
  const promptTokens = new Set(tokens(prompt))
  const descriptionTokens = new Set(tokens(description))
  const overlap = [...promptTokens].filter(token => descriptionTokens.has(token))
  if (overlap.length < 2) return 0
  return overlap.reduce((score, token) => {
    const documentFrequency = descriptions.filter(value => new Set(tokens(value)).has(token)).length
    return score + 1 + Math.log((descriptions.length + 1) / (documentFrequency + 1))
  }, 0)
}

function tokens(value) {
  const stopWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'be', 'by', 'code', 'do', 'existing', 'for', 'from',
    'in', 'into', 'is', 'it', 'of', 'on', 'one', 'only', 'or', 'package', 'repo',
    'repository', 'the', 'this', 'to', 'use', 'user', 'when', 'with', 'without',
  ])
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .map(canonicalToken)
    .filter(token => token.length > 2 && !stopWords.has(token))
}

function canonicalToken(token) {
  const aliases = {
    adjudication: 'adjudicate',
    analysis: 'orchestrate',
    analyze: 'orchestrate',
    coordinate: 'orchestrate',
    hypotheses: 'hypothesis',
    journeys: 'journey',
    maps: 'map',
    bindings: 'binding',
    build: 'construct',
    building: 'construct',
    completed: 'complete',
    conflicting: 'conflict',
    governed: 'govern',
    produce: 'construct',
    producing: 'construct',
    readable: 'read',
    rendered: 'render',
    rendering: 'render',
    summarize: 'author',
    summarizing: 'author',
    synthesized: 'synthesis',
    understand: 'orchestrate',
    understanding: 'orchestrate',
    write: 'author',
    writing: 'author',
  }
  return aliases[token] || token.replace(/s$/, '')
}

function normalize(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function assert(value, message) {
  if (!value) throw new Error(message)
}
