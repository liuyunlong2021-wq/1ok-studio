---
description: One OK Studio GitHub 发布流程 - 安全提交、敏感数据扫描、推送到 GitHub 公开仓库
---

# One OK Studio GitHub 发布流程

此 skill 整合了从本地开发到 GitHub 公开仓库的完整发布流程，包含安全检查和规范约束。

## 核心规则

- **禁止直接推送 `main` 分支** — 必须通过 feature 分支 + PR
- **只推送 `origin`** —— 它是本仓库唯一的 remote，也就是下面的 GitHub 仓库。
  （旧版本此处写的是 `github` remote，实际不存在；`origin` 也不是已废弃的 GitLab 镜像。）
- **推送前必须执行敏感数据扫描**
- **Commit Message 遵循 Conventional Commits** (`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`)
- **Git remote 名称为 `origin`**，仓库地址：`https://github.com/liuyunlong2021-wq/1ok-studio.git`
- **沿用仓库已配置的提交身份**，不要覆盖提交作者；`git config user.name` / `user.email` 已指向维护者账号
- **创建 PR 需要 GitHub CLI**；若本机未安装 `gh`，先推送分支、再在浏览器里开 PR —— 分支推上去就算发布了

## 阶段一：提交前检查

### 1. 确认分支

```bash
git branch --show-current
```

**必须**在 `feature/*`、`fix/*`、`docs/*` 分支上工作。如果在 main 上：

```bash
git checkout -b feature/<your-feature-name>
```

### 2. 敏感数据扫描

逐项执行，**任何一项命中都必须修复后才能继续**：

**搜索硬编码密钥（40+ 字符字符串）:**
```bash
git grep -E "['\"][a-zA-Z0-9_-]{40,}['\"]" -- ':(exclude)*.lock' ':(exclude)node_modules'
```

**搜索内部域名:**
```bash
git grep -i "alibaba-inc.com"
```

**搜索 API Key 模式:**
```bash
git grep -iE "(sk-|AKID|access_key|password|pwd|token|bearer)" -- ':(exclude)*.lock' ':(exclude)*.example' ':(exclude)node_modules'
```

**检查敏感文件是否被追踪:**
```bash
git ls-files | grep -E "\.env$|secret|credential|\.key$|\.pem$" | grep -v "\.example"
```

### 3. 检查 .gitignore 完整性

```bash
grep -E "^\.env|^\.agent|^CLAUDE\.md|^output/" .gitignore
```

确保至少包含：`.env`、`.agent/`、`CLAUDE.md`、`output/`

### 4. 镜像工作流对等性检查（如改动了 workflow 镜像）

如果本次改动涉及 `.claude/commands/` 或 `.codex/workflows/`，必须运行：

```bash
python3 scripts/check_workflow_parity.py
```

比对失败时：同步两侧镜像文件，或在脚本的 `WAIVERS` 中记录有意分歧及理由。

## 阶段二：代码质量（可选但推荐）

**Python 代码格式化:**
```bash
black --check src/
flake8 src/
```

**前端 Lint:**
```bash
cd frontend && npm run lint
```

## 阶段三：提交与推送

### 1. 暂存文件

```bash
git add <specific-files>
```

**不要使用 `git add .`**，逐一确认文件。

### 2. 提交

```bash
git commit -m "feat: your descriptive commit message"
```

提交前确认作者身份符合项目约定：

```bash
git log -1 --format='%an <%ae>'
```

期望作者：仓库已配置的维护者身份（`git config user.name` / `user.email`），不要覆盖。

Commit 类型：
- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式（不影响逻辑）
- `refactor:` 重构
- `test:` 测试
- `chore:` 构建/工具/依赖

### 3. 推送到 GitHub

```bash
git push -u origin <branch-name>
```

### 4. 创建 Pull Request

先切换到有 PR 创建权限的账号：

```bash
gh auth switch --hostname github.com --user Star-Lotus
```

```bash
gh pr create --repo liuyunlong2021-wq/1ok-studio --title "feat: your PR title" --body "$(cat <<'EOF'
## Summary
- <change description>

## Test plan
- [ ] <test checklist>

EOF
)"
```

## 阶段四：推送后验证

- 访问 https://github.com/liuyunlong2021-wq/1ok-studio 确认内容正确
- 检查 README 格式渲染
- 确认无敏感信息泄露

## 紧急情况：撤销敏感信息

**未 push:**
```bash
git reset --soft HEAD~1
```

**已 push:**
需要使用 BFG Repo-Cleaner 清理历史并 force push。联系团队协助。
