# Obsidian Dashboard Plugin v3

完整仪表盘插件，包含全部功能。

## 新增功能（v3）

| 功能 | 说明 |
|------|------|
| **双击重命名** | 置顶区文件名双击进入内联编辑，Enter 确认，Escape 取消，调用 `fileManager.renameFile` 同步 Vault |
| **拖拽排序置顶** | 置顶列表支持 HTML5 原生拖拽，拖放后立即持久化顺序到 `data.json` |
| **Dataview 统计** | 主面板顶部 6 张统计卡：总文件数、置顶数、字数估算、标签总数、最大分类、平均修改间隔 |
| **侧边栏 Tab** | 注册独立 `VIEW_TYPE_SIDE` Leaf，嵌入 Obsidian 左侧边栏；含导航（分类/置顶/标签）和统计（进度条+Top8标签）两个 Tab |

## 全部功能一览

- 文件分类卡片（按 Vault 文件夹或 frontmatter tags）
- 实时搜索（文件名 + 内容预览 + 标签，命中关键词高亮）
- 置顶文件（持久化，⭐ 按钮悬停显示）
- **拖拽排序置顶文件**
- **双击置顶文件名内联重命名**
- 标签云（frontmatter + 行内标签，点击筛选）
- **Dataview 风格统计卡片**
- **侧边栏 Tab（导航 + 统计双 Tab）**
- 新建文件（弹窗选分类，自动写 frontmatter tags）
- 深色/浅色主题完整适配

## 文件结构

```
obsidian-dashboard-v3/
├── main.ts              # 全部逻辑（两个 ItemView + Modal + SettingTab）
├── styles.css           # 主面板 + 侧边栏样式，含 dark theme 覆盖
├── manifest.json
├── package.json
├── esbuild.config.mjs   # dev watch + production build
└── tsconfig.json
```

## 快速安装

```bash
# 1. 用官方脚手架初始化构建环境
git clone https://github.com/obsidianmd/obsidian-sample-plugin
cd obsidian-sample-plugin

# 2. 覆盖本插件文件
cp /下载路径/main.ts .
cp /下载路径/styles.css .
cp /下载路径/manifest.json .
cp /下载路径/package.json .
cp /下载路径/esbuild.config.mjs .
cp /下载路径/tsconfig.json .

# 3. 安装依赖 & 构建
npm install
npm run build      # 输出 main.js（生产）
# 或
npm run dev        # 监听模式，修改 main.ts 自动重编译

# 4. 复制到 Vault
mkdir -p <你的Vault>/.obsidian/plugins/obsidian-dashboard
cp main.js manifest.json styles.css <你的Vault>/.obsidian/plugins/obsidian-dashboard/

# 5. Obsidian → 设置 → 第三方插件 → 启用 Dashboard
```

## 侧边栏 Tab 说明

插件启动时自动在 **左侧边栏** 注册一个 Leaf。

- **导航 Tab**：分类列表（含文件数徽章）→ 置顶文件快捷入口 → 高频标签 Top 15
- **统计 Tab**：各分类文件数进度条 + KB 分布 + 近7/30天活跃 + 标签 Top 8 进度条

手动打开命令：`Ctrl+P` → `打开仪表盘（侧边栏）`

## Dataview 对比

本插件统计数据基于 Obsidian 原生 API（`vault`、`metadataCache`），**不依赖 Dataview 插件**，开箱即用。

若你已安装 Dataview，可在任意 `.md` 文件中叠加使用标准 Dataview 查询，两者互不干扰。

## 分类识别规则

优先级：
1. 文件路径一级文件夹（`运营/周报.md` → 「运营」）
2. frontmatter `tags` 字段中包含分类名

默认分类：工作 / 学习 / 运营 / 日记，可在插件设置中自定义。
