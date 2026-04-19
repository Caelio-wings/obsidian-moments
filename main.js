"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MomentsSettingTab = exports.CreateMomentModal = exports.DEFAULT_SETTINGS = void 0;
const obsidian_1 = require("obsidian");
exports.DEFAULT_SETTINGS = {
    momentsPath: "Moments/记录/",
    attachmentsPath: "Moments/Attachments/",
    order: "desc",
};
class ObsidianMomentsPlugin extends obsidian_1.Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new MomentsSettingTab(this.app, this));
        this.addCommand({
            id: "create-moments",
            name: "创建 Moments",
            callback: () => {
                new CreateMomentModal(this.app, this).open();
            },
        });
        this.registerMarkdownCodeBlockProcessor("moments", async (_source, el, ctx) => {
            await this.renderMomentsFeed(el, ctx.sourcePath);
        });
    }
    onunload() {
        // 预留：后续如果注册视图、事件或命令，在此处释放。
    }
    async loadSettings() {
        this.settings = Object.assign({}, exports.DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    async renderMomentsFeed(containerEl, currentSourcePath) {
        containerEl.empty();
        const feedEl = containerEl.createDiv({ cls: "moments-feed" });
        const folderPath = this.cleanFolderPath(this.settings.momentsPath);
        if (!folderPath) {
            feedEl.createDiv({ text: "请先在插件设置中配置 Moments 存储路径。" });
            return;
        }
        const files = this.getMomentMarkdownFiles(folderPath, currentSourcePath);
        if (files.length === 0) {
            feedEl.createDiv({ text: "暂无 Moments 记录。" });
            return;
        }
        const items = [];
        for (const file of files) {
            const item = await this.readMomentItem(file);
            if (item)
                items.push(item);
        }
        items.sort((a, b) => {
            const timeA = this.parseDateTime(a.createdAt);
            const timeB = this.parseDateTime(b.createdAt);
            return this.settings.order === "asc" ? timeA - timeB : timeB - timeA;
        });
        // 异步渲染每个卡片，等待所有完成
        const renderPromises = items.map(item => this.renderMomentCardAsync(feedEl, item));
        await Promise.all(renderPromises);
    }
    getMomentMarkdownFiles(folderPath, currentSourcePath) {
        const prefix = `${folderPath}/`;
        return this.app.vault.getFiles().filter((file) => {
            if (file.extension !== "md")
                return false;
            if (!file.path.startsWith(prefix))
                return false;
            if (currentSourcePath && file.path === currentSourcePath)
                return false;
            return file.name.startsWith("Moments-");
        });
    }
    async readMomentItem(file) {
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter ?? {};
        if (!file.name.startsWith("Moments-")) {
            return null;
        }
        const title = typeof frontmatter["标题"] === "string" ? frontmatter["标题"] : file.basename;
        const location = typeof frontmatter["地点"] === "string" ? frontmatter["地点"] : "";
        const createdAt = typeof frontmatter["创建时间"] === "string" ? frontmatter["创建时间"] : "";
        const raw = await this.app.vault.read(file);
        const markdownBody = this.stripYamlFrontmatter(raw).trim();
        const body = this.extractContentSection(markdownBody);
        const imagesMarkdown = this.extractImagesSection(markdownBody); // 新增
        const images = this.extractImageLinks(markdownBody);
        const comments = this.extractCommentsFromMarkdown(markdownBody);
        return { file, title, location, createdAt, comments, body, images, imagesMarkdown };
    }
    stripYamlFrontmatter(content) {
        return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    }
    extractImageLinks(content) {
        const imageSection = this.extractTopLevelSection(content, "图片");
        const scope = imageSection ?? content;
        const result = [];
        this.forEachNonCodeSegment(scope, (segment) => {
            // 提取 Obsidian 格式
            const obsidianRegex = /!\[\[([^\]]+?)\]\]/g;
            let obsidianMatch = null;
            while ((obsidianMatch = obsidianRegex.exec(segment)) !== null) {
                const raw = obsidianMatch[1].split("|")[0].trim();
                if (raw)
                    result.push(raw);
            }
            // 提取 Markdown 格式
            const markdownRegex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
            let markdownMatch = null;
            while ((markdownMatch = markdownRegex.exec(segment)) !== null) {
                const raw = markdownMatch[1].split("|")[0].trim();
                if (raw)
                    result.push(raw);
            }
        });
        return result;
    }
    // 新增：提取图片节的原始 Markdown 文本
    extractImagesSection(content) {
        const normalized = content.replace(/\r\n/g, "\n");
        const lines = normalized.split("\n");
        let inImages = false;
        let resultLines = [];
        for (const line of lines) {
            const headingMatch = line.match(/^##\s*(.+?)\s*$/);
            if (headingMatch) {
                if (inImages)
                    break;
                if (headingMatch[1].trim() === "图片") {
                    inImages = true;
                    continue;
                }
            }
            if (inImages) {
                resultLines.push(line);
            }
        }
        return resultLines.join("\n").trim();
    }
    extractContentSection(content) {
        const normalized = content.replace(/\r\n/g, "\n");
        const section = this.extractTopLevelSection(normalized, "正文");
        if (section !== null) {
            return section.trim();
        }
        return this.removeImageLinksFromBody(normalized).trim();
    }
    extractTopLevelSection(content, headingName) {
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        const collected = [];
        let inFence = false;
        let collecting = false;
        let fenceToken = "";
        for (const line of lines) {
            const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
            if (fenceMatch) {
                const token = fenceMatch[2].charAt(0);
                if (!inFence) {
                    inFence = true;
                    fenceToken = token;
                }
                else if (token === fenceToken) {
                    inFence = false;
                    fenceToken = "";
                }
            }
            if (!inFence) {
                const headingMatch = line.match(/^##\s*(.+?)\s*$/);
                if (headingMatch) {
                    const currentHeading = headingMatch[1].trim();
                    if (collecting)
                        break;
                    collecting = currentHeading === headingName;
                    continue;
                }
            }
            if (collecting) {
                collected.push(line);
            }
        }
        if (!collecting && collected.length === 0) {
            return null;
        }
        return collected.join("\n");
    }
    forEachNonCodeSegment(content, handler) {
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        let inFence = false;
        let fenceToken = "";
        let chunk = [];
        const flush = () => {
            if (chunk.length === 0)
                return;
            handler(chunk.join("\n"));
            chunk = [];
        };
        for (const line of lines) {
            const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
            if (fenceMatch) {
                flush();
                const token = fenceMatch[2].charAt(0);
                if (!inFence) {
                    inFence = true;
                    fenceToken = token;
                }
                else if (token === fenceToken) {
                    inFence = false;
                    fenceToken = "";
                }
                continue;
            }
            if (!inFence) {
                chunk.push(line);
            }
        }
        flush();
    }
    // 修改为异步方法，并使用 MarkdownRenderer 渲染图片
    async renderMomentCardAsync(parentEl, item) {
        const cardEl = parentEl.createDiv({ cls: "moments-card" });
        const headerEl = cardEl.createDiv({ cls: "moments-card-header" });
        headerEl.createDiv({ cls: "moments-title", text: item.title || "未命名" });
        const bodyEl = cardEl.createDiv({ cls: "moments-body" });
        bodyEl.setText(this.removeImageLinksFromBody(item.body));
        // 图片部分：使用 MarkdownRenderer 渲染，然后重新组织为网格布局
        if (item.imagesMarkdown && item.imagesMarkdown.trim()) {
            const tempDiv = document.createElement("div");
            await obsidian_1.MarkdownRenderer.render(this.app, item.imagesMarkdown, tempDiv, item.file.path, this);
            // 提取所有图片元素
            const images = Array.from(tempDiv.querySelectorAll("img"));
            if (images.length > 0) {
                const gridEl = cardEl.createDiv({ cls: "moments-grid" });
                const imgCount = images.length;
                gridEl.addClass(`grid-${imgCount}`);
                if (imgCount === 1)
                    gridEl.addClass("moments-grid--1");
                else if (imgCount <= 4)
                    gridEl.addClass("moments-grid--2");
                else
                    gridEl.addClass("moments-grid--3");
                this.applyGridLayoutStyle(gridEl, imgCount);
                for (const img of images) {
                    // 移除原有样式，让网格控制
                    img.style.width = "100%";
                    img.style.display = "block";
                    img.style.objectFit = imgCount === 1 ? "contain" : "cover";
                    img.style.aspectRatio = imgCount === 1 ? "auto" : "1 / 1";
                    img.style.borderRadius = "4px";
                    gridEl.appendChild(img);
                }
            }
        }
        const commentsSectionEl = cardEl.createDiv({ cls: "moments-comments-section" });
        const commentsDetailsEl = commentsSectionEl.createEl("details", { cls: "moments-comments-details" });
        const commentsSummaryEl = commentsDetailsEl.createEl("summary", { cls: "moments-comments-summary" });
        commentsSummaryEl.setText(this.formatCommentsSummaryText(item.comments.length));
        const commentsBubbleEl = commentsDetailsEl.createDiv({ cls: "moments-comments-bubble" });
        const commentsInlineListEl = commentsBubbleEl.createDiv({ cls: "moments-comments-inline-list" });
        this.renderCommentsList(commentsInlineListEl, item.comments);
        const composerEl = commentsBubbleEl.createDiv({ cls: "moments-comment-composer is-hidden" });
        const commentInput = composerEl.createEl("input", {
            type: "text",
            cls: "moments-comment-input",
            placeholder: "写评论...",
        });
        const submitCommentBtn = composerEl.createEl("button", { text: "发送", cls: "moments-comment-submit" });
        if (item.comments.length === 0) {
            commentsSectionEl.addClass("is-hidden");
        }
        const metaRowEl = cardEl.createDiv({ cls: "moments-meta-row" });
        const metaLeftEl = metaRowEl.createDiv({ cls: "moments-meta-left" });
        metaLeftEl.createDiv({ cls: "moments-time", text: item.createdAt || "未知时间" });
        const locationEl = metaLeftEl.createDiv({ cls: "moments-location" });
        locationEl.createSpan({ cls: "moments-location-icon", text: "📍" });
        locationEl.appendText(item.location || "未填写地点");
        const actionsEl = metaRowEl.createDiv({ cls: "moments-actions" });
        const detailBtn = actionsEl.createEl("button", { text: "详情" });
        const commentBtn = actionsEl.createEl("button", { text: "评论" });
        detailBtn.addEventListener("click", async () => {
            await this.app.workspace.getLeaf(false).openFile(item.file);
        });
        commentBtn.addEventListener("click", () => {
            commentsSectionEl.removeClass("is-hidden");
            commentsDetailsEl.open = true;
            composerEl.removeClass("is-hidden");
            commentInput.focus();
        });
        submitCommentBtn.addEventListener("click", async () => {
            const commentText = commentInput.value.trim();
            if (!commentText) {
                new obsidian_1.Notice("评论内容不能为空");
                return;
            }
            const now = new Date();
            const commentLine = `${this.formatCommentTime(now)} - ${commentText}`;
            try {
                await this.app.vault.process(item.file, (data) => {
                    const normalized = data.replace(/\r\n/g, "\n").trimEnd();
                    const commentItem = `- ${commentLine}`;
                    if (!/^\s*##\s*评论区\s*$/m.test(normalized)) {
                        return `${normalized}\n\n## 评论区\n${commentItem}\n`;
                    }
                    const commentSectionRegex = /(^##\s*评论区\s*$)([\s\S]*?)$/m;
                    return normalized.replace(commentSectionRegex, (_m, heading, body) => {
                        const sectionBody = body.trimEnd();
                        if (!sectionBody) {
                            return `${heading}\n${commentItem}`;
                        }
                        return `${heading}\n${sectionBody}\n${commentItem}`;
                    }) + "\n";
                });
                item.comments.push(commentLine);
                this.renderCommentsList(commentsInlineListEl, item.comments);
                commentsSummaryEl.setText(this.formatCommentsSummaryText(item.comments.length));
                commentsSectionEl.removeClass("is-hidden");
                commentsDetailsEl.open = true;
                commentInput.value = "";
                new obsidian_1.Notice("评论已添加");
            }
            catch (error) {
                console.error(error);
                new obsidian_1.Notice("评论提交失败");
            }
        });
    }
    // 新增：对渲染后的图片应用网格样式
    applyGridToRenderedImages(container, imgCount) {
        const imgs = container.querySelectorAll("img");
        if (imgs.length === 0)
            return;
        container.classList.add("moments-images-render-grid");
        container.style.display = "grid";
        container.style.gap = "5px";
        if (imgCount === 1) {
            container.style.gridTemplateColumns = "1fr";
            container.style.maxWidth = "220px";
        }
        else if (imgCount <= 4) {
            container.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
            container.style.maxWidth = "220px";
        }
        else {
            container.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
            container.style.maxWidth = "330px";
        }
        imgs.forEach(img => {
            img.style.width = "100%";
            img.style.display = "block";
            img.style.objectFit = imgCount === 1 ? "contain" : "cover";
            img.style.aspectRatio = imgCount === 1 ? "auto" : "1 / 1";
            img.style.borderRadius = "4px";
        });
    }
    renderCommentsList(containerEl, comments) {
        containerEl.empty();
        if (comments.length === 0) {
            containerEl.createDiv({ cls: "moments-comment-empty", text: "暂无评论" });
            return;
        }
        for (const comment of comments) {
            containerEl.createDiv({ cls: "moments-comment-item", text: comment });
        }
    }
    extractCommentsFromMarkdown(content) {
        const commentsSection = this.extractTopLevelSection(content, "评论区");
        if (!commentsSection)
            return [];
        const comments = [];
        this.forEachNonCodeSegment(commentsSection, (segment) => {
            for (const line of segment.split("\n")) {
                const match = line.match(/^\s*-\s+(.+?)\s*$/);
                if (match)
                    comments.push(match[1]);
            }
        });
        return comments;
    }
    formatCommentsSummaryText(count) {
        return `💬 ${count} 条评论`;
    }
    removeImageLinksFromBody(content) {
        const parts = [];
        this.forEachNonCodeSegment(content, (segment) => {
            segment = segment.replace(/!\[\[[^\]]+?\]\]/g, "");
            segment = segment.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
            parts.push(segment);
        });
        return parts.join("\n").trim();
    }
    resolveImageResourcePath(link, fromFile) {
        // 判断是否是网络URL（以 http://, https://, // 开头）
        if (link.match(/^(https?:\/\/|\/\/)/)) {
            return link;
        }
        // 处理本地文件
        const target = this.app.metadataCache.getFirstLinkpathDest(link, fromFile.path);
        if (!target)
            return null;
        return this.app.vault.adapter.getResourcePath(target.path);
    }
    applyGridLayoutStyle(gridEl, imgCount) {
        gridEl.style.display = "grid";
        gridEl.style.gap = "5px";
        if (imgCount === 1) {
            gridEl.style.gridTemplateColumns = "1fr";
            gridEl.style.maxWidth = "220px";
        }
        else if (imgCount <= 4) {
            gridEl.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
            gridEl.style.maxWidth = "220px";
        }
        else {
            gridEl.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
            gridEl.style.maxWidth = "330px";
        }
    }
    parseDateTime(value) {
        if (!value)
            return 0;
        const parsed = Date.parse(value.replace(" ", "T"));
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    formatCommentTime(date) {
        const yyyy = date.getFullYear();
        const mm = this.pad(date.getMonth() + 1);
        const dd = this.pad(date.getDate());
        const hh = this.pad(date.getHours());
        const mi = this.pad(date.getMinutes());
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    }
    formatDateTime(date) {
        const yyyy = date.getFullYear();
        const mm = this.pad(date.getMonth() + 1);
        const dd = this.pad(date.getDate());
        const hh = this.pad(date.getHours());
        const mi = this.pad(date.getMinutes());
        const ss = this.pad(date.getSeconds());
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    }
    pad(value) {
        return value.toString().padStart(2, "0");
    }
    cleanFolderPath(path) {
        const trimmed = path
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");
        return trimmed ? (0, obsidian_1.normalizePath)(trimmed) : "";
    }
}
exports.default = ObsidianMomentsPlugin;
class CreateMomentModal extends obsidian_1.Modal {
    constructor(app, plugin) {
        super(app);
        this.titleValue = "";
        this.locationValue = "";
        this.contentValue = "";
        this.selectedFiles = [];
        this.plugin = plugin;
    }
    onOpen() {
        this.modalEl.addClass("moments-create-modal");
        const { contentEl } = this;
        contentEl.empty();
        const modalContent = contentEl.closest(".modal-content");
        if (modalContent) {
            modalContent.style.maxHeight = "75vh";
            modalContent.style.overflowY = "auto";
        }
        contentEl.createEl("h2", { text: "创建 Moments" });
        new obsidian_1.Setting(contentEl)
            .setName("标题")
            .addText((text) => text.setPlaceholder("输入标题").onChange((value) => {
            this.titleValue = value.trim();
        }));
        new obsidian_1.Setting(contentEl)
            .setName("地点")
            .addText((text) => text.setPlaceholder("输入地点").onChange((value) => {
            this.locationValue = value.trim();
        }));
        const contentSetting = new obsidian_1.Setting(contentEl).setName("内容");
        const textarea = contentSetting.controlEl.createEl("textarea");
        textarea.rows = 5;
        textarea.placeholder = "输入正文内容";
        textarea.style.width = "100%";
        textarea.style.resize = "vertical";
        textarea.style.overflowY = "auto";
        textarea.addEventListener("input", () => {
            textarea.style.height = "auto";
            textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
            this.contentValue = textarea.value;
        });
        const imageSetting = new obsidian_1.Setting(contentEl).setName("图片");
        const fileInput = imageSetting.controlEl.createEl("input", { type: "file" });
        fileInput.multiple = true;
        fileInput.accept = "image/*";
        fileInput.addEventListener("change", () => {
            this.selectedFiles = Array.from(fileInput.files ?? []);
        });
        new obsidian_1.Setting(contentEl).addButton((button) => button.setButtonText("发布").setCta().onClick(async () => {
            await this.handleSubmit();
        }));
    }
    onClose() {
        this.modalEl.removeClass("moments-create-modal");
        this.contentEl.empty();
    }
    async handleSubmit() {
        try {
            const now = new Date();
            const createdAt = this.formatDateTime(now);
            const mdTime = this.formatMarkdownFileTime(now);
            const imageTime = this.formatImageFileTime(now);
            const titleForFilename = this.sanitizeFileName(this.titleValue || "未命名");
            const attachmentsFolder = this.cleanFolderPath(this.plugin.settings.attachmentsPath);
            const momentsFolder = this.cleanFolderPath(this.plugin.settings.momentsPath);
            if (!attachmentsFolder) {
                throw new Error("Attachments path is empty");
            }
            if (!momentsFolder) {
                throw new Error("Moments path is empty");
            }
            await this.ensureFolderExists(attachmentsFolder);
            await this.ensureFolderExists(momentsFolder);
            const imageLinks = [];
            for (const file of this.selectedFiles) {
                const buffer = await file.arrayBuffer();
                const ext = this.getFileExtension(file.name);
                const imageName = `IMG-${imageTime}-${this.randomDigits(4)}${ext}`;
                const imagePath = (0, obsidian_1.normalizePath)(`${attachmentsFolder}/${imageName}`);
                await this.app.vault.createBinary(imagePath, buffer);
                imageLinks.push(`![[${imagePath}]]`);
            }
            const frontmatter = [
                "---",
                `标题: ${this.titleValue || ""}`,
                `地点: ${this.locationValue || ""}`,
                `创建时间: ${createdAt}`,
                `更新时间: ${createdAt}`,
                "---",
            ].join("\n");
            const body = this.contentValue.trimEnd();
            const imagesBlock = imageLinks.join("\n");
            const contentSection = `## 正文\n${body || "（无正文）"}`;
            const imageSection = `## 图片\n${imagesBlock || "（无图片）"}`;
            const commentsSection = "## 评论区";
            const markdown = `${frontmatter}\n\n${contentSection}\n\n${imageSection}\n\n${commentsSection}\n`;
            const mdFileName = `Moments-${mdTime}-${titleForFilename}.md`;
            const mdFilePath = (0, obsidian_1.normalizePath)(`${momentsFolder}/${mdFileName}`);
            await this.app.vault.create(mdFilePath, markdown);
            new obsidian_1.Notice("Moments 发布成功");
            this.close();
        }
        catch (error) {
            console.error(error);
            new obsidian_1.Notice("发布失败，请检查路径配置或文件名是否冲突");
        }
    }
    cleanFolderPath(path) {
        return this.plugin.cleanFolderPath(path);
    }
    async ensureFolderExists(folderPath) {
        if (!folderPath)
            return;
        const parts = folderPath.split("/");
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current);
            }
        }
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (folder && !(folder instanceof obsidian_1.TFolder)) {
            throw new Error(`Path is not a folder: ${folderPath}`);
        }
    }
    sanitizeFileName(value) {
        return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "未命名";
    }
    getFileExtension(fileName) {
        const idx = fileName.lastIndexOf(".");
        return idx >= 0 ? fileName.slice(idx) : ".png";
    }
    randomDigits(length) {
        const min = Math.pow(10, Math.max(1, length) - 1);
        const max = Math.pow(10, Math.max(1, length)) - 1;
        return `${Math.floor(Math.random() * (max - min + 1)) + min}`;
    }
    pad(value) {
        return value.toString().padStart(2, "0");
    }
    formatDateTime(date) {
        const yyyy = date.getFullYear();
        const mm = this.pad(date.getMonth() + 1);
        const dd = this.pad(date.getDate());
        const hh = this.pad(date.getHours());
        const mi = this.pad(date.getMinutes());
        const ss = this.pad(date.getSeconds());
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    }
    formatMarkdownFileTime(date) {
        const yyyy = date.getFullYear();
        const mm = this.pad(date.getMonth() + 1);
        const dd = this.pad(date.getDate());
        const hh = this.pad(date.getHours());
        const mi = this.pad(date.getMinutes());
        const ss = this.pad(date.getSeconds());
        return `${yyyy}-${mm}-${dd}-${hh}${mi}${ss}`;
    }
    formatImageFileTime(date) {
        const yyyy = date.getFullYear();
        const mm = this.pad(date.getMonth() + 1);
        const dd = this.pad(date.getDate());
        const hh = this.pad(date.getHours());
        const mi = this.pad(date.getMinutes());
        const ss = this.pad(date.getSeconds());
        return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
    }
}
exports.CreateMomentModal = CreateMomentModal;
class MomentsSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "obsidian-moments 设置" });
        new obsidian_1.Setting(containerEl)
            .setName("Moments 存储路径")
            .setDesc("用于保存每条 Moments 记录的 .md 文件目录")
            .addText((text) => text
            .setPlaceholder("例如：Moments/记录/")
            .setValue(this.plugin.settings.momentsPath)
            .onChange(async (value) => {
            this.plugin.settings.momentsPath = value.trim() || exports.DEFAULT_SETTINGS.momentsPath;
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName("图片附件存储路径")
            .setDesc("用于保存通过插件上传的图片文件")
            .addText((text) => text
            .setPlaceholder("例如：Moments/Attachments/")
            .setValue(this.plugin.settings.attachmentsPath)
            .onChange(async (value) => {
            this.plugin.settings.attachmentsPath = value.trim() || exports.DEFAULT_SETTINGS.attachmentsPath;
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName("展示顺序")
            .setDesc("按创建时间排序：正序或倒序")
            .addDropdown((dropdown) => dropdown
            .addOption("desc", "倒序（最新在前）")
            .addOption("asc", "正序（最早在前）")
            .setValue(this.plugin.settings.order)
            .onChange(async (value) => {
            this.plugin.settings.order = value === "asc" ? "asc" : "desc";
            await this.plugin.saveSettings();
        }));
    }
}
exports.MomentsSettingTab = MomentsSettingTab;
