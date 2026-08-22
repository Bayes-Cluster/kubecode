# Kubecode Brand Guide

**版本：** 1.0  
**设计方向：** Modular Flow / Workspace Loop  
**适用范围：** 产品界面、README、文档站、GitHub 社交预览、发布物料和应用图标

---

## 1. 品牌定位

Kubecode 是一个面向项目的、自托管的 AI 编程工作区。品牌视觉不把它表达成一个聊天机器人，而是表达成一套长期运行、可重连、可以承载多个 Agent 与开发工具的工作系统。

视觉系统围绕三个概念建立：

1. **Workspace**：项目、代码、文件和上下文的持久容器。
2. **Flow**：任务在规划、执行、审查、测试之间持续流转。
3. **Active node**：正在工作的 Agent、任务或运行状态。

---

## 2. Logo 理念

Logo 名称为 **Workspace Loop**。

- 左侧蓝色路径代表 Project 与本地工作区，是稳定的承载结构。
- 右侧蓝色路径代表持续运行和可重连的 Session。
- 内部上升路径代表任务从输入走向结果。
- 中央薄荷绿色方块代表当前活跃的 Agent 或任务节点。
- 顶部与右侧的断口让图形保持开放和可扩展，同时避免形成一个直接的字母 K。

Logo 不依赖机器人、聊天气泡、星光或 Kubernetes 舵轮等通用符号。

---

## 3. Logo 文件

| 文件 | 用途 |
|---|---|
| `kubecode-app-icon.svg` | 应用图标、GitHub 头像、启动器 |
| `kubecode-mark-color.svg` | 浅色背景上的透明彩色图形 |
| `kubecode-horizontal-light.svg` | 浅色背景横向组合 |
| `kubecode-horizontal-dark.svg` | 深色背景横向组合 |
| `extras/kubecode-mark-mono-dark.svg` | 单色深色版本 |
| `extras/kubecode-mark-mono-light.svg` | 反白单色版本 |
| `extras/kubecode-favicon.svg` | 浏览器 favicon |

### 安全留白

Logo 四周至少保留图形宽度的 **25%**。横向组合的安全留白以图标内部薄荷节点的宽度作为最小单位。

### 最小尺寸

- 数字图形标志：16 px；推荐不少于 24 px。
- 横向组合：推荐宽度不少于 120 px。
- 印刷图形标志：推荐不少于 12 mm。

16–20 px 时优先使用 App Icon 或单色图形，不使用横向字标。

### 禁止用法

- 不拉伸、压缩或改变路径比例。
- 不交换蓝色和薄荷色的语义角色。
- 不增加投影、描边、发光、3D 或玻璃效果。
- 不在复杂图片上直接放置透明彩色标志。
- 不把图形旋转成字母或其他符号。
- 不使用渐变填充正文文字。

---

## 4. 颜色系统

| 名称 | 色值 | 角色 |
|---|---:|---|
| Kube Ink | `#11131A` | 结构、文字、深色界面与信任感 |
| Workspace Blue | `#4F63F5` | 主操作、选中、链接、工作流 |
| Blue Light | `#91A0FF` | 次级路径、层级、深度 |
| Agent Mint | `#2BD9A8` | 运行中、已连接、成功 |
| Warm Surface | `#ECE9E2` | 温暖背景与营销画布 |

### 状态规则

- **蓝色**：选择和用户行动。
- **薄荷绿**：系统处于活跃、连接或成功状态。
- **黄色**：等待权限、警告或需要用户确认。
- **红色**：失败、断开或破坏性操作。
- 不用薄荷绿承担主要 CTA，避免“运行状态”和“用户操作”混淆。

---

## 5. Typography

推荐组合：

- **Inter Display**：品牌标题、营销主标题。
- **Inter**：产品 UI、正文和说明文字。
- **JetBrains Mono**：终端、代码、路径和 Token。

推荐字重：

- Display：600–700
- UI 标题：600
- 正文：400
- 标签与按钮：500–600
- 代码：400–500

产品界面使用 sentence case，不大面积使用全大写；全大写仅用于短小元数据标签。

---

## 6. 产品视觉语法

### 形状

- 基础网格：4 px。
- 控件圆角：8 px。
- 卡片圆角：12 px。
- 大型面板和营销容器：16–20 px。
- App Icon：约 22% 圆角。
- 边框优先于大阴影，阴影只用于浮层和重要层级。

### 图标

- 默认线性图标使用 lucide（2 px 圆角描边风格）；仅实心角色使用 Remix
  Icon 实心字形；笔记身份使用原生 emoji；文件与目录身份使用 vendored
  Material Icon Theme 审计子集（ADR 0209）。
- 尺寸阶梯按角色取值：12（状态）、14（次级行内）、16（默认）、20（工具栏）、
  24（身份容器）、28（最小点击目标）px。
- 状态图标必须带非颜色区分符（形状或字形），不得只靠颜色区分状态；
  状态圆点仍是主通道，图标为辅助线索。
- Material 文件图标使用独立的 `--material-*` 色彩 token，不随工作台主题
  变体重染。
- Logo 不是普通功能图标；不要在侧栏中重复大量使用。

### 图形语言

品牌插图使用：

- 圆角模块；
- 单向或分叉路径；
- 小型状态节点；
- 项目、Session 与 Agent 之间的连接；
- 终端游标与进度反馈。

避免：

- 机器人和人形头像；
- AI 大脑、星光和魔法棒；
- 霓虹球体和无语义的玻璃渐变；
- 直接使用 Kubernetes 舵轮；
- 大面积紫色 AI 助手视觉。

---

## 7. Light / Dark Theme

`kubecode-brand-tokens.css` 包含完整的 Light / Dark 语义 Token，并提供与 Kubecode 当前变量契约的兼容映射。

原则：

1. 品牌原色保持一致，深色模式提高蓝色和薄荷色亮度。
2. Dark 模式不使用纯黑，主背景为 Kube Ink。
3. Warm Surface 主要用于浅色 app chrome 与营销背景。
4. 用户选择的代码和终端主题可以独立存在；品牌系统只控制 App Chrome。

---

## 8. 应用规范

### 产品界面

- 顶栏可使用 20 px 图形标志。
- Primary Button 使用 Workspace Blue。
- Running / Connected 状态使用 Agent Mint。
- Project、Session、Agent Team、Terminal 使用统一的 lucide 圆角线性图标
  （实心角色使用 Remix）；文件与目录身份统一经语义解析器渲染 Material
  文件图标。
- Terminal 保持 Kube Ink 底色，不使用 Warm Surface。

### README 与文档

- README 首屏使用横向 Logo。
- 社交预览使用 `kubecode-social-preview.png`。
- 文档 Hero 可以使用大号半透明 Workspace Loop 图形。
- 架构图使用蓝色路径和薄荷节点，不使用多色彩虹连线。

### 营销物料

- 浅色物料：Warm Surface / Paper 背景，深色字标。
- 深色物料：Kube Ink 背景，反白字标。
- 大型渐变仅用于 Logo 图形、路径和局部光晕。
- 主文案建议强调：local、self-hosted、durable、project-oriented、agent teams。

---

## 9. 建议仓库替换

```text
public/logo.svg
  ← kubecode-mark-color.svg 或 kubecode-app-icon.svg

public/favicon.svg
  ← extras/kubecode-favicon.svg

docs/assets/brand/kubecode-social-preview.png
  ← kubecode-social-preview.png

src/index.css / src/kubecode/kubecode.css
  ← 引入 kubecode-brand-tokens.css
```

HTML theme color 建议设为 `#11131A`。

---

## 10. 可访问性

- 小号正文不得使用 Blue Light 作为文字色。
- Workspace Blue 在白色背景上适合大文字、图标、边框和按钮；小号普通文本应使用更深的 Blue 700。
- Mint 主要用于图形和状态，不作为大段正文。
- 所有状态同时配合文字、图标或形状，不仅依赖颜色。
- Focus ring 始终可见，不能只依赖浏览器默认样式。
