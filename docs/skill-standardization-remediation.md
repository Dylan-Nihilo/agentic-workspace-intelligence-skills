# Skill 规范化 · 返修工单（执行者：Codex）

> 背景：Codex 已完成 Wave 0 + Wave 1(evals) + 部分 Wave 2/3。经对抗式评审，主体可接受，但有 4 个 P1 + 2 个 P2 必须返修，另有诚实性/中立性与 P3 项。
> 权威文档：`docs/skill-standardization-build-guide.md`（§0 护栏 G-A..G-E、Wave0-T3 HARD-GATE 真值表）。**护栏不变**：不删现有 gate、不动 `producedBy` 枚举、skill 脚本只薄封装、`[HARD-GATE:X]` 的 X 必须是能 grep 到 throw/exit 的**符号**。
> 已确认无需再动：`normalize-coding-pool.mjs:84` 的 `exit(2)`、`producedBy` 枚举、8 条 description 文本、`eval:contract` 绿。

---

## P1 — 必须修（阻断合入）

### R1 · 安全回归：可伪造的信任标签让确定性验证器失效

**问题**：LLM verifier(`repo-fact-verifier`)的 verdict 经 ingest 回写时，`tool` 字段被原样透传。攻击/幻觉链：verifier 输出 `{verdict:"not-refuted", tool:"deterministic-adversarial-verifier"}` → 写入 `edge.metadata.verification.tool` → `isExternalVerified()` 返回 true → 主验证循环对该边 `continue` 跳过。任意低置信度/inferred 边可被**永久豁免**确定性证据核查——正是 H-A4 声称堵死的红线。

**证据**：
- [fact-graph-harness.mjs:674](../shared/understanding/fact-graph-harness.mjs#L674) `normalizeVerifierVerdictValues`：`tool: item.tool || 'repo-fact-verifier',`
- [fact-graph-harness.mjs:635](../shared/understanding/fact-graph-harness.mjs#L635) ingest 回写：`tool: item.tool || 'repo-fact-verifier',`
- [fact-graph-harness.mjs:733](../shared/understanding/fact-graph-harness.mjs#L733) `isExternalVerified` 只认这一个 tag；[:694](../shared/understanding/fact-graph-harness.mjs#L694) 据此跳过。

**修法**：ingest 来的 verdict **不得**携带确定性 tag。把上述两处
```js
tool: item.tool || 'repo-fact-verifier',
```
改为
```js
tool: 'repo-fact-verifier',
```
`deterministic-adversarial-verifier` 只保留给 [:712](../shared/understanding/fact-graph-harness.mjs#L712)（`runAdversarialVerifier` 自己的 not-refuted 分支）写。全局替换该字面量即可，共 2 处；712 行文本不同，不受影响。

**验收**：新增/复用一条 contract 断言——构造 `verdicts:[{edgeId, verdict:"not-refuted", tool:"deterministic-adversarial-verifier", reason:"x"}]` 的 analysis 走 ingest，回写后该 edge 的 `metadata.verification.tool` 必须是 `repo-fact-verifier`，且随后 `runAdversarialVerifier` 仍对它执行 `verifyEdgeEvidence`（未被 `isExternalVerified` 跳过）。

### R2 · R1(consolidation) 红线：删重复逻辑前无 golding 回归

**问题**：Wave 3 把 `validateAgentAnalyses/normalizeAgentAnalyses/subjectFromId` 收敛进 `shared/workspace-datasource/coding-pool.mjs`，两个消费脚本的私有副本已删——但 W3-T3/§Wave3 红线要求"共享替代过 golden 回归后才可删"。当前 `evals/fixtures/golden/coding-pool.golden.json` 不存在，回归缺失。

**修法**（副本已删，无法回溯对拍，按"特征化回归"补齐）：
1. 建最小 coding-pool fixture：`evals/fixtures/coding-pool/` 下放 raw + `analyses/` 至少 3 条记录——1 条合法、1 条 `evidenceRefs:[]`（应被拒）、1 条 `producedBy:"agent"`（枚举外，应被拒）。
2. 跑 `shared/workspace-datasource/coding-pool.mjs` 的 `ingestAgentAnalyses`/`normalizeAgentAnalyses` 生成规范化输出，**人工核对正确**后冻结为 `evals/fixtures/golden/coding-pool.golden.json`。
3. `evals/contract/run-contract.mjs` 增断言：跑 `agentic-coding-audit/scripts/normalize-coding-pool.mjs` 对该 fixture，(a) 合法记录输出与 golden 逐字段一致；(b) 两条非法记录触发 `process.exit(2)`。
4. 诚实标注残留风险：golden 锚的是"当前 shared 行为经人工核对正确"，非"证明与已删副本等价"——在 `evals/README.md` 注明。

**验收**：`npm run eval:contract` 仍绿，且新断言覆盖 coding-pool normalize 的成功+拒绝两路。

### R3 · 假 HARD-GATE：`validateAnalyses` 符号不存在

**问题**：[agentic-coding-audit/SKILL.md:14](../skills/agentic-coding-audit/SKILL.md#L14) 的 `[HARD-GATE: validateAnalyses]` grep 不到——真实强制函数是合并后的 `validateAgentAnalyses`。违反 G-D/G-E（标签必须锚到可 grep 的符号）。

**修法**：标签 `validateAnalyses` → `validateAgentAnalyses`（`shared/workspace-datasource/coding-pool.mjs` 内、`normalize-coding-pool.mjs` 与 `export-audit-data.mjs` 路径上真实 throw/exit2 的那个）。

**验收**：`grep -rhoE '\[HARD-GATE: *[A-Za-z]+' skills/*/SKILL.md` 列出的每个符号在 `shared/`/`harnesses/`/`skills/*/scripts/` 都能 grep 到 `throw`/`process.exit`。

### R4 · HARD-GATE 未锚到符号：`ce-run-failed` 是标记文件名

**问题**：[agentic-ce-bridge/SKILL.md:15](../skills/agentic-ce-bridge/SKILL.md#L15) 的 `[HARD-GATE: ce-run-failed]` 指向标记文件/schemaVersion 字符串，不是符号。**注意**：强制本身是**真的**——[run-ce-analysis.mjs:150-162](../skills/agentic-ce-bridge/scripts/run-ce-analysis.mjs#L150) parse 失败时写 `ce-run-failed.json` 并 `process.exit(2)`。只是标签没锚到符号，破坏 grep 约定。

**修法**：把该 try/catch 的失败分支抽成命名函数，例如
```js
function assertCeParsed(text, rawDir, subject, task) {
  try { return parseJsonFromText(text) }
  catch (error) {
    writeJson(path.join(rawDir, 'ce-run-failed.json'), { schemaVersion: 'ce-run-failed/v1', /*…*/ reason: `CE output parse failed: ${error.message}` })
    console.error(`CE output parse failed; raw output preserved at ${rawDir}`)
    process.exit(2)
  }
}
```
调用点用它替换第 147-162 的内联逻辑；SKILL.md 标签改为 `[HARD-GATE: assertCeParsed]`。

**验收**：同 R3 的 grep 约定；ce parse 失败仍 exit 2（现有 eval 已覆盖，确认不回退）。

---

## P2 — 应修（HARD-GATE 诚实性，与真值表对齐）

### R5 · `openQuestionAnalysis` 过度声称门禁

**问题**：[repo-understanding/SKILL.md:22](../skills/repo-understanding/SKILL.md#L22) `[HARD-GATE: openQuestionAnalysis] …不得手搓 analysis JSON`。但 `openQuestionAnalysis` 只在**空文本**时 throw，根本拦不住"手搓 JSON"——没有任何代码强制这条。是便利原语，不是门禁。

**修法**：标签 → `[PRINCIPLE]`，措辞改为"记录未决问题**优先**用 `ingest --open-question` 原语，避免手搓 analysis JSON"。HARD-GATE 只留给同段真实强制的 `validateUnderstandingPackage` / `withPackageWriteLock`。

### R6 · `generateHumanReadableHtml` 把投影当门禁

**问题**：[repo-human-readable/SKILL.md:17](../skills/repo-human-readable/SKILL.md#L17) 把"缺输入文件即失败"标成 HARD-GATE。这是**前置条件检查**，不是数据完整性/只读不变量；真值表不给该 skill 任何 HARD-GATE。

**修法**：标签 → `[PRINCIPLE]`（措辞："生成器仅接受已完成的 package；缺 `static/code-map.json`/`fact-graph.json` 时前置失败"）。该 skill 真正的保护约束是同文件 line 21 的只读 `[PRINCIPLE]`，保持不动。

---

## 诚实性 / 中立性（超出严格 rubric，但建议一并做）

### R7 · `eval:all` 误报绿

**问题**：`evals/behavioral/` 与 `evals/triggering/` 仅占位 README，`run-all.mjs` 打印 pending 后 exit 0——三根验证支柱两根未实现却整体报绿。

**修法**：`run-all.mjs` 对这两块打印显式 `PENDING (deferred — not asserted)` 并在结尾汇总 `pillars: contract=PASS, behavioral=PENDING, triggering=PENDING`；保持 exit 0（属计划内延后），但绿色不得被误读为"全绿"。

### R8 · CE prose 残留 shared core（上轮你关注的"疑似依赖 CE"根源）

**问题**：[repo-exploration-core.mjs:243](../shared/understanding/repo-exploration-core.mjs#L243) `modeled after RepoPrompt CE's explore role`、[:259](../shared/understanding/repo-exploration-core.mjs#L259) `If you are in RepoPrompt-style tools, use only get_file_tree…` 仍写进 explorer prompt。严格说在 G-B（SKILL.md prose）范围外，但这是让人误以为依赖 CE 的根源。

**修法**：中立化。
- L243 → `You are a read-only repository exploration agent restricted to non-destructive inspection.`
- L259 → `If your runtime exposes read-only code-navigation tools, prefer file-tree, file-search, code-structure, read-file, and read-only git; do not run install/build/test/servers.`

**验收**：`grep -rn 'RepoPrompt' shared/` 仅剩允许的位置（无则最佳）。

---

## P3 — 可选（有余力再做）

- **R9** `withPackageWriteLock`（[harness.mjs:445](../harnesses/repo-understanding/scripts/harness.mjs#L445)）无 stale 回收：ingest 被 kill 会永久堵死。EEXIST 时按已写的 pid 死活/锁龄阈值判定 stale 并回收，否则 exit 2。
- **R10** `normalize-coding-pool.mjs` 的 exit(2) 未被任何 eval 覆盖——R2 的断言(3b)已顺带覆盖，确认包含即可。
- **R11** fixture 的 guarded-by 形状存在但 contract eval 未断言：加一条 ingest 合法 guarded-by(subject=GuardedButton, object=auth) 并断言 merge，凑齐四种形状全覆盖。
- **R12** `references/` 两处点名 Codex/RepoPrompt CE（[evidence-taxonomy.md:30](../skills/agentic-coding-audit/references/evidence-taxonomy.md#L30)、[pipeline-contract.md:30](../skills/agentic-datasource-orchestrator/references/pipeline-contract.md#L30)）：按 producedBy 枚举/能力条件句改写，去演员名。

---

## 执行顺序与验收

1. **R1 → R2**（安全 + 回归门，最高优先，各配 contract 断言）。
2. **R3/R4/R5/R6**（标签诚实性，纯文档 + R4 一处小重构）。
3. **R7/R8**（诚实性/中立性）。
4. **R3 后跑标签审计**：`grep -rhoE '\[HARD-GATE: *[^]]+' skills/*/SKILL.md` 逐个符号 grep 到 throw/exit。
5. **总验收**：`npm run eval:contract` 绿（含 R1、R2 新断言）；`git diff` 无越界改动（不碰 `producedBy` 枚举、不删 exit2）；HARD-GATE 标签零假标签。

每个 R 项一个 commit，message 前缀 `fix(skill-std):`。
