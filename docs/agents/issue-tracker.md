# 议题系统：本地 Markdown

本仓库的议题与规格存放在 `.scratch/`。

## 约定

- 每项功能使用一个目录：`.scratch/<feature-slug>/`。
- 规格文件为 `.scratch/<feature-slug>/spec.md`。
- 实现议题每项一个文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号。
- 议题使用靠近文件顶部的 `Status:` 行记录分流状态，具体值见 `triage-labels.md`。
- 评论和讨论历史追加在文件底部的 `## Comments` 下。

## 技能操作

- 技能要求“发布到议题系统”时，在对应功能目录创建 Markdown 文件。
- 技能要求读取议题时，读取用户提供的路径或编号对应的文件。

## Wayfinding 约定

- 地图文件为 `.scratch/<effort>/map.md`。
- 子议题位于 `.scratch/<effort>/issues/NN-<slug>.md`。
- 子议题通过 `Type:` 记录类型，通过 `Status:` 记录 `claimed` 或 `resolved`。
- 依赖通过 `Blocked by: NN, NN` 记录；所有依赖解决后，议题才算解除阻塞。
- 认领议题时先将状态改为 `claimed`；解决时追加 `## Answer`，将状态改为 `resolved`，并把上下文指针写回地图。
