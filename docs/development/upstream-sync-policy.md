# 上游同步与 Fork 开发策略（steel-browser）

日期：2026-09-14
状态：生效
规范来源：kt-agent-skills/oss-fork-maintenance

## 仓库角色

- `upstream` = https://github.com/steel-dev/steel-browser（只读，禁止 push）
- `origin` = KTAIorg/steel-browser（KT fork，true fork，保留完整上游历史）
- 采纳基线：upstream/main `2b41124d8e2953b0afe355c534e3c9aa71edae26`（2026-09-02，介于 v0.5.4-beta 与 main HEAD）

## 分支模型

- `main`：KT 生产线（上游基线 + 白名单定制）
- `upstream-sync`：上游跟随缓冲线（`git merge upstream/main` 或指定 tag，在此解冲突）
- 部署镜像：`ghcr.io/ktaiorg/steel-browser`，tag 形如 `<上游版本>-kt<n>` 与 `sha-<12>`

## KT 定制边界（白名单，超出需 PR 论证）

1. **CDP 暴露面安全**：`api/src/services/cdp-gateway.service.ts`、`api/src/plugins/browser.ts`（网关接线）、`api/entrypoint.sh`（nginx 默认关闭）、`api/nginx.conf`
2. **会话参数修复**：`api/src/services/session.service.ts`（userDataDir 优先级）、`api/src/modules/sessions/`（fingerprint 透传）
3. **文档**：`README.md`（顶部 fork 说明）、`docs/`（本文件、MULTI_SESSION_ROADMAP.md）
4. **CI/镜像**：`.github/workflows/kt-*.yml`（KT 自有 workflow 一律 `kt-` 前缀，不与上游 workflow 混名）

## 同步频率

- 安全修复：即时
- 常规：**每月或每上游 release 跟进**（上游节奏 1–4 个月一版，均 beta；取 tag 优先于 main HEAD）

## 冲突优先级

安全修复以上游为准 > 上游已内建则收敛 KT 定制 > 白名单域定制保留重施 > 纯风格以上游为准

## 验证清单

- [ ] `npm ci && npm run build`（根 workspace：api + ui）
- [ ] `npm test`（api：vitest）
- [ ] CDP 网关行为回归：无 CDP_TOKEN 时拒绝启动（`CDP_ALLOW_ANONYMOUS=true` 则仅绑回环）、带/不带 token 的 `/json/list` 过滤与 401/403/405、`devtoolsFrontendUrl` 不泄露
- [ ] userDataDir 优先级回归（session.service.test.ts）
- [ ] 镜像 smoke：`.github/scripts/kt-cdp-smoke.sh`（`/v1/health` 200、无 token 拒绝启动、带 token `/json/list` 仅本会话 targets 且为白名单投影、`/devtools/browser` 与 `/devtools/page/<id>` 真实握手 101、外部 target 403）
- [ ] 上游安全 fix 确认已含

## 同步记录

| 日期 | 上游 from→to | 冲突摘要 | 验证 | 操作者 |
|---|---|---|---|---|
| 2026-09-14 | 采纳基线 2b41124 | —（Day 0） | build+test 全绿，CI 镜像 smoke | kimi-code-swarm |
