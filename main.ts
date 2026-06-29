import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Main editor pane — full dashboard */
const VIEW_TYPE_MAIN = "dashboard-main";
/** Sidebar leaf — compact navigator */
const VIEW_TYPE_SIDE = "dashboard-side";
const PREVIEW_CHARS = 45;

// ─── Settings ─────────────────────────────────────────────────────────────────

interface DashboardSettings {
  categories: string[];
  recentLimit: number;
  defaultCategory: string;
  pinnedFiles: string[];   // ordered list of file paths
}

const DEFAULT_SETTINGS: DashboardSettings = {
  categories: ["工作", "学习", "运营", "日记"],
  recentLimit: 12,
  defaultCategory: "工作",
  pinnedFiles: [],
};

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class DashboardPlugin extends Plugin {
  settings: DashboardSettings;

  async onload() {
    await this.loadSettings();

    // ── Register both views
    this.registerView(VIEW_TYPE_MAIN, (leaf) => new MainDashboardView(leaf, this));
    this.registerView(VIEW_TYPE_SIDE, (leaf) => new SideDashboardView(leaf, this));

    // ── Ribbon: open main dashboard
    this.addRibbonIcon("layout-dashboard", "打开仪表盘", () =>
      this.activateMain()
    );

    // ── Commands
    this.addCommand({
      id: "open-dashboard",
      name: "打开仪表盘（主面板）",
      callback: () => this.activateMain(),
    });
    this.addCommand({
      id: "open-sidebar",
      name: "打开仪表盘（侧边栏）",
      callback: () => this.activateSide(),
    });

    // ── Settings tab
    this.addSettingTab(new DashboardSettingTab(this.app, this));

    // ── Auto-open on startup
    this.app.workspace.onLayoutReady(async () => {
      if (!this.app.workspace.getActiveFile()) await this.activateMain();
      // Always open sidebar leaf too
      await this.activateSide();
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MAIN);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SIDE);
  }

  async activateMain() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MAIN)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_MAIN, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async activateSide() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SIDE)[0];
    if (!leaf) {
      // Open in LEFT sidebar
      leaf = workspace.getLeftLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_SIDE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // ── Pin helpers ─────────────────────────────────────────────────────────────

  getPins(): string[] { return this.settings.pinnedFiles; }

  isPinned(path: string): boolean {
    return this.settings.pinnedFiles.includes(path);
  }

  async pin(path: string) {
    if (!this.isPinned(path)) this.settings.pinnedFiles.push(path);
    await this.saveSettings();
  }

  async unpin(path: string) {
    this.settings.pinnedFiles = this.settings.pinnedFiles.filter((p) => p !== path);
    await this.saveSettings();
  }

  async reorderPins(newOrder: string[]) {
    this.settings.pinnedFiles = newOrder;
    await this.saveSettings();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.pinnedFiles)) this.settings.pinnedFiles = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Notify all open views to re-render
    this.refreshAll();
  }

  refreshAll() {
    for (const t of [VIEW_TYPE_MAIN, VIEW_TYPE_SIDE]) {
      this.app.workspace.getLeavesOfType(t).forEach((leaf) => {
        const view = leaf.view as MainDashboardView | SideDashboardView;
        view.render?.();
      });
    }
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function getCategory(app: App, file: TFile, categories: string[]): string {
  const parts = file.path.split("/");
  if (parts.length > 1 && categories.includes(parts[0])) return parts[0];
  const meta = app.metadataCache.getFileCache(file);
  const tags: string[] = meta?.frontmatter?.tags ?? [];
  for (const t of tags) {
    if (categories.includes(t)) return t;
  }
  return "";
}

function formatTime(date: Date): string {
  const d = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (d === 0) return "今天";
  if (d === 1) return "昨天";
  if (d < 7) return `${d}天前`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

const CAT_EMOJI: Record<string, string> = {
  工作: "💼", 学习: "📖", 运营: "📢", 日记: "📓",
};

const COLOR_KEYS = ["purple", "teal", "amber", "coral", "blue", "pink"];

function catColorKey(cat: string, categories: string[]): string {
  return COLOR_KEYS[categories.indexOf(cat) % COLOR_KEYS.length] ?? "gray";
}

async function readPreview(app: App, file: TFile): Promise<string> {
  try {
    const content = await app.vault.cachedRead(file);
    return content
      .replace(/^---[\s\S]*?---\n?/, "")
      .replace(/^#+\s+/gm, "")
      .replace(/[*_`!\[\]]/g, "")
      .trim()
      .slice(0, PREVIEW_CHARS);
  } catch {
    return "";
  }
}

// ─── Main Dashboard View ──────────────────────────────────────────────────────

class MainDashboardView extends ItemView {
  plugin: DashboardPlugin;

  // Filter state
  private activeCat: string | null = null;
  private activeTag: string | null = null;
  private searchQuery = "";

  // Drag state
  private dragSrcPath: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_MAIN; }
  getDisplayText() { return "仪表盘"; }
  getIcon() { return "layout-dashboard"; }

  async onOpen() {
    await this.render();
    const r = () => this.render();
    this.registerEvent(this.app.vault.on("create", r));
    this.registerEvent(this.app.vault.on("delete", r));
    this.registerEvent(this.app.vault.on("rename", r));
    this.registerEvent(this.app.vault.on("modify", r));
  }

  async onClose() {}

  // ── render ──────────────────────────────────────────────────────────────────

  async render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("db-root");

    const allFiles = this.app.vault.getMarkdownFiles();
    const sorted = [...allFiles].sort((a, b) => b.stat.mtime - a.stat.mtime);
    const { categories } = this.plugin.settings;

    // ── Header
    this.buildHeader(root, allFiles.length, categories.length);

    // ── Search
    this.buildSearch(root);

    // ── Stat cards  (Dataview-style aggregate row)
    this.buildStatCards(root, allFiles, categories);

    // ── Categories
    root.createEl("div", { cls: "db-sec-label", text: "文件分类" });
    this.buildCategories(root, allFiles, categories);

    // ── Tag cloud
    root.createEl("div", { cls: "db-sec-label", text: "标签云" });
    this.buildTagCloud(root, allFiles);

    // ── Pinned files (drag-sortable, double-click rename)
    if (this.plugin.getPins().length > 0) {
      const pinRow = root.createDiv("db-sec-row");
      pinRow.createEl("div", { cls: "db-sec-label", text: "置顶文件" });
      pinRow.createEl("div", { cls: "db-sec-hint", text: "拖拽排序 · 双击重命名" });
      await this.buildPinnedList(root, allFiles);
    }

    // ── Recent / filtered file list
    const listRow = root.createDiv("db-sec-row");
    const listLabel = listRow.createEl("div", { cls: "db-sec-label" });
    const hasFilter = this.activeCat || this.activeTag || this.searchQuery;
    listLabel.textContent = this.activeCat
      ? `${this.activeCat} · 筛选中`
      : this.activeTag
      ? `#${this.activeTag} · 筛选中`
      : this.searchQuery
      ? `搜索：${this.searchQuery}`
      : "近期文件";

    if (hasFilter) {
      const clearBtn = listRow.createEl("button", { cls: "db-clear-btn", text: "清除筛选" });
      clearBtn.onclick = () => {
        this.activeCat = null;
        this.activeTag = null;
        this.searchQuery = "";
        this.render();
      };
    }

    await this.buildFileList(root, sorted, allFiles);
  }

  // ── Header ──────────────────────────────────────────────────────────────────

  private buildHeader(parent: HTMLElement, total: number, catCount: number) {
    const hdr = parent.createDiv("db-header");
    const left = hdr.createDiv();
    left.createEl("div", { cls: "db-vault-name", text: this.app.vault.getName() });
    left.createEl("div", { cls: "db-vault-sub", text: `共 ${total} 个文件 · ${catCount} 个分类` });
    const btn = hdr.createEl("button", { cls: "db-btn-new", text: "＋ 新建文件" });
    btn.onclick = () => new NewFileModal(this.app, this.plugin, () => this.render()).open();
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  private buildSearch(parent: HTMLElement) {
    const wrap = parent.createDiv("db-search-wrap");
    setIcon(wrap.createEl("span", { cls: "db-search-icon" }), "search");
    const input = wrap.createEl("input", {
      cls: "db-search-input",
      type: "text",
      placeholder: "搜索文件名、内容或标签…",
    }) as HTMLInputElement;
    input.value = this.searchQuery;
    input.oninput = () => { this.searchQuery = input.value.trim(); this.render(); };
    if (this.searchQuery) setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  }

  // ── Stat cards (Dataview-style) ──────────────────────────────────────────────

  private buildStatCards(parent: HTMLElement, allFiles: TFile[], categories: string[]) {
    const grid = parent.createDiv("db-stat-grid");

    // Total files
    this.statCard(grid, String(allFiles.length), "总文件数", this.recentCount(allFiles, 7) + " 件近 7 天新增");

    // Pinned
    this.statCard(grid, String(this.plugin.getPins().length), "置顶文件", "拖拽可排序");

    // Word count estimate (chars / 2 as rough CJK proxy)
    const totalChars = allFiles.reduce((s, f) => s + (f.stat.size ?? 0), 0);
    this.statCard(grid, this.fmtNum(Math.round(totalChars / 2)), "总字数估算", "基于文件大小");

    // Active tags
    const tagCount = Object.keys(this.collectTags(allFiles)).length;
    this.statCard(grid, String(tagCount), "标签总数", "全 Vault 去重");

    // Most active category
    const topCat = categories.reduce((best, c) => {
      const n = allFiles.filter((f) => getCategory(this.app, f, categories) === c).length;
      return n > (best[1] ?? 0) ? [c, n] : best;
    }, ["", 0] as [string, number]);
    this.statCard(grid, topCat[0] || "—", "最大分类", `${topCat[1]} 个文件`);

    // Avg file age days
    const avgAge = allFiles.length
      ? Math.round(
          allFiles.reduce((s, f) => s + (Date.now() - f.stat.mtime) / 86400000, 0) /
            allFiles.length
        )
      : 0;
    this.statCard(grid, String(avgAge) + "天", "平均修改间隔", "基于 mtime");
  }

  private statCard(parent: HTMLElement, val: string, label: string, sub: string) {
    const card = parent.createDiv("db-stat-card");
    card.createEl("div", { cls: "db-stat-val", text: val });
    card.createEl("div", { cls: "db-stat-label", text: label });
    card.createEl("div", { cls: "db-stat-sub", text: sub });
  }

  private recentCount(files: TFile[], days: number): number {
    const cutoff = Date.now() - days * 86400000;
    return files.filter((f) => f.stat.mtime >= cutoff).length;
  }

  private fmtNum(n: number): string {
    return n >= 10000 ? (n / 10000).toFixed(1) + "w" : n.toLocaleString();
  }

  // ── Categories ──────────────────────────────────────────────────────────────

  private buildCategories(parent: HTMLElement, allFiles: TFile[], categories: string[]) {
    const grid = parent.createDiv("db-cat-grid");
    categories.forEach((cat) => {
      const count = allFiles.filter((f) => getCategory(this.app, f, categories) === cat).length;
      const card = grid.createDiv("db-cat-card");
      if (this.activeCat === cat) card.addClass("active");
      card.createEl("div", { cls: "db-cat-icon", text: CAT_EMOJI[cat] ?? "📁" });
      card.createEl("div", { cls: "db-cat-count", text: String(count) });
      card.createEl("div", { cls: "db-cat-label", text: cat });
      card.onclick = () => { this.activeCat = this.activeCat === cat ? null : cat; this.render(); };
    });
  }

  // ── Tag cloud ────────────────────────────────────────────────────────────────

  private buildTagCloud(parent: HTMLElement, allFiles: TFile[]) {
    const tagMap = this.collectTags(allFiles);
    const cloud = parent.createDiv("db-tag-cloud");
    if (Object.keys(tagMap).length === 0) {
      cloud.createEl("span", { cls: "db-tag-empty", text: "暂无标签，在 frontmatter 中添加 tags: [] 即可" });
      return;
    }
    Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .forEach(([tag, count]) => {
        const pill = cloud.createEl("span", {
          cls: "db-tag-pill" + (this.activeTag === tag ? " active" : ""),
          text: `${tag} ${count}`,
        });
        pill.onclick = () => { this.activeTag = this.activeTag === tag ? null : tag; this.render(); };
      });
  }

  private collectTags(allFiles: TFile[]): Record<string, number> {
    const map: Record<string, number> = {};
    allFiles.forEach((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      const tags: string[] = [
        ...(cache?.frontmatter?.tags ?? []),
        ...(cache?.tags?.map((t) => t.tag.replace(/^#/, "")) ?? []),
      ];
      tags.forEach((t) => { map[t] = (map[t] ?? 0) + 1; });
    });
    return map;
  }

  // ── Pinned list (drag-sort + double-click rename) ────────────────────────────

  private async buildPinnedList(parent: HTMLElement, allFiles: TFile[]) {
    const pins = this.plugin.getPins();
    const pinFiles = pins
      .map((p) => allFiles.find((f) => f.path === p))
      .filter(Boolean) as TFile[];

    if (pinFiles.length === 0) return;

    const list = parent.createDiv("db-pin-list");

    pinFiles.forEach((file, visualIndex) => {
      const row = list.createDiv("db-pin-row");
      row.setAttribute("draggable", "true");
      row.dataset.path = file.path;

      // Drag handle
      const handle = row.createEl("span", { cls: "db-drag-handle" });
      setIcon(handle, "grip-vertical");

      // Name label (double-click → inline rename)
      const nameEl = row.createEl("span", { cls: "db-pin-name", text: file.basename });
      nameEl.addEventListener("dblclick", () => this.startInlineRename(nameEl, file));

      // Category badge
      const cat = getCategory(this.app, file, this.plugin.settings.categories);
      if (cat) {
        row.createEl("span", {
          cls: `db-file-tag db-tag-${catColorKey(cat, this.plugin.settings.categories)}`,
          text: cat,
        });
      }

      // Time
      row.createEl("span", { cls: "db-pin-time", text: formatTime(new Date(file.stat.mtime)) });

      // Unpin button
      const unpinBtn = row.createEl("button", { cls: "db-unpin-btn", title: "取消置顶" });
      setIcon(unpinBtn, "x");
      unpinBtn.onclick = async (e) => {
        e.stopPropagation();
        await this.plugin.unpin(file.path);
      };

      // Open on click (but not on handle/unpin)
      row.onclick = (e) => {
        if ((e.target as HTMLElement).closest(".db-drag-handle, .db-unpin-btn, .db-pin-name-input")) return;
        this.app.workspace.getLeaf(false).openFile(file);
      };

      // ── Drag events
      row.addEventListener("dragstart", (e) => {
        this.dragSrcPath = file.path;
        row.addClass("db-dragging");
        e.dataTransfer!.effectAllowed = "move";
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        list.querySelectorAll(".db-pin-row").forEach((r) => r.removeClass("db-drag-over"));
        row.addClass("db-drag-over");
      });
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        if (!this.dragSrcPath || this.dragSrcPath === file.path) return;
        const pins = [...this.plugin.getPins()];
        const fromIdx = pins.indexOf(this.dragSrcPath);
        const toIdx = pins.indexOf(file.path);
        if (fromIdx === -1 || toIdx === -1) return;
        const [item] = pins.splice(fromIdx, 1);
        pins.splice(toIdx, 0, item);
        await this.plugin.reorderPins(pins);
        new Notice("已调整置顶顺序");
      });
      row.addEventListener("dragend", () => {
        this.dragSrcPath = null;
        list.querySelectorAll(".db-pin-row").forEach((r) =>
          r.removeClass("db-dragging", "db-drag-over")
        );
      });
    });
  }

  // ── Inline rename ────────────────────────────────────────────────────────────

  private startInlineRename(nameEl: HTMLElement, file: TFile) {
    const orig = file.basename;
    const input = document.createElement("input");
    input.className = "db-pin-name-input";
    input.value = orig;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (!newName || newName === orig) { this.render(); return; }
      const newPath = file.path.replace(`${orig}.md`, `${newName}.md`);
      try {
        await this.app.fileManager.renameFile(file, newPath);
        new Notice(`已重命名为「${newName}」`);
      } catch (err: any) {
        new Notice(`重命名失败：${err.message}`);
        this.render();
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = orig; input.blur(); }
    });
  }

  // ── File list ────────────────────────────────────────────────────────────────

  private async buildFileList(parent: HTMLElement, sorted: TFile[], allFiles: TFile[]) {
    const { categories } = this.plugin.settings;
    let list = sorted;

    if (this.activeCat)
      list = list.filter((f) => getCategory(this.app, f, categories) === this.activeCat);

    if (this.activeTag) {
      list = list.filter((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        const tags: string[] = [
          ...(cache?.frontmatter?.tags ?? []),
          ...(cache?.tags?.map((t) => t.tag.replace(/^#/, "")) ?? []),
        ];
        return tags.includes(this.activeTag!);
      });
    }

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        const tags: string[] = [
          ...(cache?.frontmatter?.tags ?? []),
          ...(cache?.tags?.map((t) => t.tag.replace(/^#/, "")) ?? []),
        ];
        return f.basename.toLowerCase().includes(q) || tags.some((t) => t.toLowerCase().includes(q));
      });
    }

    if (!this.activeCat && !this.activeTag && !this.searchQuery)
      list = list.slice(0, this.plugin.settings.recentLimit);

    const container = parent.createDiv("db-file-list");
    if (list.length === 0) {
      container.createEl("div", { cls: "db-empty", text: "没有匹配的文件" });
      return;
    }

    for (const file of list) {
      const cat = getCategory(this.app, file, categories);
      const preview = await readPreview(this.app, file);
      const isPinned = this.plugin.isPinned(file.path);

      const row = container.createDiv("db-file-row");
      if (isPinned) row.addClass("pinned");

      if (isPinned) row.createEl("span", { cls: "db-pin-dot", title: "已置顶" });
      else {
        const ic = row.createEl("span", { cls: "db-file-icon" });
        setIcon(ic, "file-text");
      }

      const info = row.createDiv("db-file-info");
      const nameEl = info.createEl("div", { cls: "db-file-name" });
      nameEl.innerHTML = this.highlight(file.basename);
      if (preview) {
        const prev = info.createEl("div", { cls: "db-file-preview" });
        prev.innerHTML = this.highlight(preview) + "…";
      }

      const meta = row.createDiv("db-file-meta");
      if (cat) meta.createEl("span", { cls: `db-file-tag db-tag-${catColorKey(cat, categories)}`, text: cat });
      meta.createEl("span", { cls: "db-file-time", text: formatTime(new Date(file.stat.mtime)) });

      const pinBtn = meta.createEl("button", { cls: "db-pin-btn", title: isPinned ? "取消置顶" : "置顶", text: isPinned ? "⭐" : "☆" });
      pinBtn.onclick = async (e) => {
        e.stopPropagation();
        isPinned ? await this.plugin.unpin(file.path) : await this.plugin.pin(file.path);
      };

      row.onclick = () => this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private highlight(text: string): string {
    if (!this.searchQuery) return text;
    const esc = this.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(esc, "gi"), (m) => `<mark class="db-highlight">${m}</mark>`);
  }
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────
// Compact navigator: tabs (Dashboard / Stats), category list, tag list

class SideDashboardView extends ItemView {
  plugin: DashboardPlugin;
  private activeTab: "nav" | "stats" = "nav";
  private activeCat: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_SIDE; }
  getDisplayText() { return "仪表盘导航"; }
  getIcon() { return "layout-dashboard"; }

  async onOpen() {
    await this.render();
    const r = () => this.render();
    this.registerEvent(this.app.vault.on("create", r));
    this.registerEvent(this.app.vault.on("delete", r));
    this.registerEvent(this.app.vault.on("rename", r));
  }

  async onClose() {}

  async render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("db-side-root");

    const allFiles = this.app.vault.getMarkdownFiles();
    const { categories } = this.plugin.settings;

    // ── Tab bar
    const tabBar = root.createDiv("db-side-tabs");
    const navTab = tabBar.createEl("button", { cls: "db-side-tab" + (this.activeTab === "nav" ? " active" : ""), text: "导航" });
    const statsTab = tabBar.createEl("button", { cls: "db-side-tab" + (this.activeTab === "stats" ? " active" : ""), text: "统计" });
    navTab.onclick = () => { this.activeTab = "nav"; this.render(); };
    statsTab.onclick = () => { this.activeTab = "stats"; this.render(); };

    // ── Content
    if (this.activeTab === "nav") {
      this.buildNav(root, allFiles, categories);
    } else {
      this.buildStats(root, allFiles, categories);
    }
  }

  // ── Nav tab ──────────────────────────────────────────────────────────────────

  private buildNav(root: HTMLElement, allFiles: TFile[], categories: string[]) {
    // Open main dashboard button
    const openBtn = root.createEl("button", { cls: "db-side-open-btn", text: "打开完整仪表盘" });
    openBtn.onclick = () => this.plugin.activateMain();

    // Categories
    root.createEl("div", { cls: "db-side-sec", text: "分类" });
    const allItem = root.createDiv("db-side-item" + (!this.activeCat ? " active" : ""));
    const allIcon = allItem.createEl("span", { cls: "db-side-icon" });
    setIcon(allIcon, "layout-grid");
    allItem.createEl("span", { text: "全部" });
    allItem.createEl("span", { cls: "db-side-count", text: String(allFiles.length) });
    allItem.onclick = () => { this.activeCat = null; this.render(); this.plugin.activateMain(); };

    categories.forEach((cat) => {
      const count = allFiles.filter((f) => getCategory(this.app, f, categories) === cat).length;
      const item = root.createDiv("db-side-item" + (this.activeCat === cat ? " active" : ""));
      const icon = item.createEl("span", { cls: "db-side-icon" });
      setIcon(icon, "folder");
      item.createEl("span", { text: cat });
      item.createEl("span", { cls: "db-side-count", text: String(count) });
      item.onclick = () => { this.activeCat = cat; this.render(); };
    });

    // Pinned files
    const pins = this.plugin.getPins();
    if (pins.length > 0) {
      root.createEl("div", { cls: "db-side-sec", text: "置顶文件" });
      pins.forEach((path) => {
        const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
        if (!file) return;
        const item = root.createDiv("db-side-item");
        const icon = item.createEl("span", { cls: "db-side-icon" });
        setIcon(icon, "star");
        item.createEl("span", { cls: "db-side-pin-name", text: file.basename });
        item.onclick = () => this.app.workspace.getLeaf(false).openFile(file);
      });
    }

    // Tags
    root.createEl("div", { cls: "db-side-sec", text: "标签" });
    const tagMap: Record<string, number> = {};
    allFiles.forEach((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      const tags: string[] = [
        ...(cache?.frontmatter?.tags ?? []),
        ...(cache?.tags?.map((t) => t.tag.replace(/^#/, "")) ?? []),
      ];
      tags.forEach((t) => { tagMap[t] = (tagMap[t] ?? 0) + 1; });
    });
    Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([tag, count]) => {
        const item = root.createDiv("db-side-item");
        const icon = item.createEl("span", { cls: "db-side-icon" });
        setIcon(icon, "hash");
        item.createEl("span", { text: tag });
        item.createEl("span", { cls: "db-side-count", text: String(count) });
      });
  }

  // ── Stats tab (Dataview-style) ────────────────────────────────────────────────

  private buildStats(root: HTMLElement, allFiles: TFile[], categories: string[]) {
    root.createEl("div", { cls: "db-side-sec", text: "各分类文件数" });

    categories.forEach((cat) => {
      const count = allFiles.filter((f) => getCategory(this.app, f, categories) === cat).length;
      const pct = allFiles.length > 0 ? Math.round((count / allFiles.length) * 100) : 0;
      const row = root.createDiv("db-stats-row");
      row.createEl("span", { cls: "db-stats-cat", text: cat });
      row.createEl("span", { cls: "db-stats-num", text: String(count) });
      const barWrap = row.createDiv("db-stats-bar-wrap");
      const bar = barWrap.createDiv("db-stats-bar");
      bar.createDiv("db-stats-bar-fill").style.width = `${pct}%`;
      row.createEl("span", { cls: "db-stats-pct", text: `${pct}%` });
    });

    // Word count per category
    root.createEl("div", { cls: "db-side-sec", text: "文件大小分布 (KB)" });
    categories.forEach((cat) => {
      const files = allFiles.filter((f) => getCategory(this.app, f, categories) === cat);
      const totalKB = files.reduce((s, f) => s + (f.stat.size ?? 0) / 1024, 0);
      const row = root.createDiv("db-stats-row");
      row.createEl("span", { cls: "db-stats-cat", text: cat });
      row.createEl("span", { cls: "db-stats-num", text: totalKB.toFixed(1) + "k" });
    });

    // Recent activity
    root.createEl("div", { cls: "db-side-sec", text: "近期活跃" });
    const cutoff7 = Date.now() - 7 * 86400000;
    const recent7 = allFiles.filter((f) => f.stat.mtime >= cutoff7).length;
    const cutoff30 = Date.now() - 30 * 86400000;
    const recent30 = allFiles.filter((f) => f.stat.mtime >= cutoff30).length;
    const a7 = root.createDiv("db-stats-row");
    a7.createEl("span", { cls: "db-stats-cat", text: "近7天修改" });
    a7.createEl("span", { cls: "db-stats-num", text: String(recent7) + " 件" });
    const a30 = root.createDiv("db-stats-row");
    a30.createEl("span", { cls: "db-stats-cat", text: "近30天修改" });
    a30.createEl("span", { cls: "db-stats-num", text: String(recent30) + " 件" });

    // Top 8 tags
    const tagMap: Record<string, number> = {};
    allFiles.forEach((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      const tags: string[] = [
        ...(cache?.frontmatter?.tags ?? []),
        ...(cache?.tags?.map((t) => t.tag.replace(/^#/, "")) ?? []),
      ];
      tags.forEach((t) => { tagMap[t] = (tagMap[t] ?? 0) + 1; });
    });

    root.createEl("div", { cls: "db-side-sec", text: "高频标签 Top 8" });
    const maxTagCount = Math.max(...Object.values(tagMap), 1);
    Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([tag, count]) => {
        const pct = Math.round((count / maxTagCount) * 100);
        const row = root.createDiv("db-stats-row");
        row.createEl("span", { cls: "db-stats-cat", text: `#${tag}` });
        row.createEl("span", { cls: "db-stats-num", text: String(count) });
        const barWrap = row.createDiv("db-stats-bar-wrap");
        barWrap.createDiv("db-stats-bar").createDiv("db-stats-bar-fill").style.width = `${pct}%`;
      });
  }
}

// ─── New File Modal ───────────────────────────────────────────────────────────

class NewFileModal extends Modal {
  plugin: DashboardPlugin;
  onCreated: () => void;

  constructor(app: App, plugin: DashboardPlugin, onCreated: () => void) {
    super(app);
    this.plugin = plugin;
    this.onCreated = onCreated;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("db-modal");
    contentEl.createEl("h2", { cls: "db-modal-title", text: "新建文件" });

    let fileName = "";
    let category = this.plugin.settings.defaultCategory;
    let tags = "";

    new Setting(contentEl).setName("文件名称").addText((t) => {
      t.setPlaceholder("如：暗区突围版本上线 SOP");
      t.onChange((v) => (fileName = v.trim()));
      t.inputEl.focus();
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") create.call(this); });
    });

    new Setting(contentEl).setName("分类（文件夹）").addDropdown((dd) => {
      for (const cat of this.plugin.settings.categories) dd.addOption(cat, cat);
      dd.setValue(category);
      dd.onChange((v) => (category = v));
    });

    new Setting(contentEl).setName("标签").setDesc("逗号分隔，会写入 frontmatter").addText((t) => {
      t.setPlaceholder("如：运营, SOP, 版本");
      t.onChange((v) => (tags = v.trim()));
    });

    const btnRow = contentEl.createDiv("db-modal-actions");
    btnRow.createEl("button", { text: "取消" }).onclick = () => this.close();
    const confirm = btnRow.createEl("button", { cls: "db-modal-confirm", text: "创建" });
    confirm.onclick = () => create.call(this);

    const self = this;
    async function create(this: NewFileModal) {
      if (!fileName) { new Notice("请输入文件名称"); return; }
      const path = `${category}/${fileName}.md`;
      try {
        if (!self.app.vault.getAbstractFileByPath(category))
          await self.app.vault.createFolder(category);
        const tagList = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
        const fm = tagList.length ? `---\ntags: [${tagList.join(", ")}]\n---\n\n` : "";
        await self.app.vault.create(path, `${fm}# ${fileName}\n\n`);
        const f = self.app.vault.getAbstractFileByPath(path) as TFile;
        if (f) await self.app.workspace.getLeaf(false).openFile(f);
        new Notice(`已创建：${fileName}`);
        self.onCreated();
        self.close();
      } catch (err: any) {
        new Notice(`创建失败：${err.message}`);
      }
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class DashboardSettingTab extends PluginSettingTab {
  plugin: DashboardPlugin;
  constructor(app: App, plugin: DashboardPlugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "仪表盘设置" });

    new Setting(containerEl)
      .setName("分类文件夹")
      .setDesc("逗号分隔，与 Vault 根目录文件夹名一致")
      .addText((t) => {
        t.setValue(this.plugin.settings.categories.join(", "));
        t.onChange(async (v) => {
          this.plugin.settings.categories = v.split(",").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("近期文件数量")
      .setDesc("无筛选时显示的最大条数（5–30）")
      .addSlider((sl) => {
        sl.setLimits(5, 30, 1).setValue(this.plugin.settings.recentLimit).setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.recentLimit = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("默认分类")
      .addDropdown((dd) => {
        for (const cat of this.plugin.settings.categories) dd.addOption(cat, cat);
        dd.setValue(this.plugin.settings.defaultCategory);
        dd.onChange(async (v) => { this.plugin.settings.defaultCategory = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("清除所有置顶")
      .addButton((btn) => {
        btn.setButtonText("清除").setWarning().onClick(async () => {
          this.plugin.settings.pinnedFiles = [];
          await this.plugin.saveSettings();
          new Notice("已清除所有置顶");
        });
      });
  }
}
