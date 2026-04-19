import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	normalizePath,
	MarkdownRenderer,
} from "obsidian";

export type MomentsOrder = "asc" | "desc";

export interface MomentsSettings {
	sourceFolders: string[];      // 新增：多个来源文件夹
	attachmentsPath: string;
	order: MomentsOrder;
	// 移除 momentsPath，通过迁移兼容旧配置
}

interface MomentItem {
	file: TFile;
	title: string;
	location: string;
	createdAt: string;
	comments: string[];
	body: string;
	images: string[];
	imagesMarkdown: string;
}

export const DEFAULT_SETTINGS: MomentsSettings = {
	sourceFolders: [],
	attachmentsPath: "Moments/Attachments/",
	order: "desc",
};

export default class ObsidianMomentsPlugin extends Plugin {
	settings!: MomentsSettings;

	async onload() {
		await this.loadSettings();
		// 迁移旧配置：如果存在旧的 momentsPath 且 sourceFolders 为空，则自动添加
		const oldMomentsPath = (this.settings as any).momentsPath;
		if (oldMomentsPath && this.settings.sourceFolders.length === 0) {
			this.settings.sourceFolders = [oldMomentsPath];
			await this.saveSettings();
		}
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

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async renderMomentsFeed(containerEl: HTMLElement, currentSourcePath?: string) {
		containerEl.empty();
		const feedEl = containerEl.createDiv({ cls: "moments-feed" });

		if (!this.settings.sourceFolders.length) {
			feedEl.createDiv({ text: "请先在插件设置中添加至少一个 Moments 来源文件夹。" });
			return;
		}

		// 收集所有来源文件夹中的文件
		const allFiles: TFile[] = [];
		for (const rawFolder of this.settings.sourceFolders) {
			const folderPath = this.cleanFolderPath(rawFolder);
			if (!folderPath) continue;
			const prefix = `${folderPath}/`;
			const files = this.app.vault.getFiles().filter((file) => {
				if (file.extension !== "md") return false;
				if (!file.path.startsWith(prefix)) return false;
				if (currentSourcePath && file.path === currentSourcePath) return false;
				return true;
			});
			allFiles.push(...files);
		}

		// 去重（同一个文件可能因多个父目录被重复添加，但实际不会，因为每个文件只有一个路径）
		const uniqueFiles = Array.from(new Map(allFiles.map(f => [f.path, f])).values());

		const items: MomentItem[] = [];
		for (const file of uniqueFiles) {
			const item = await this.readMomentItem(file);
			if (item) items.push(item);
		}

		items.sort((a, b) => {
			const timeA = this.parseDateTime(a.createdAt);
			const timeB = this.parseDateTime(b.createdAt);
			return this.settings.order === "asc" ? timeA - timeB : timeB - timeA;
		});

		const renderPromises = items.map(item => this.renderMomentCardAsync(feedEl, item));
		await Promise.all(renderPromises);
	}

	private async readMomentItem(file: TFile): Promise<MomentItem | null> {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter ?? {};

		// 检查 tags 是否包含 "moments"
		let hasMomentsTag = false;
		const tags = frontmatter["tags"];
		if (Array.isArray(tags)) {
			hasMomentsTag = tags.includes("moments");
		} else if (typeof tags === "string") {
			hasMomentsTag = tags === "moments" || tags.split(/\s*,\s*/).includes("moments");
		}
		if (!hasMomentsTag) return null;

		const title = typeof frontmatter["标题"] === "string" ? frontmatter["标题"] : file.basename;
		const location = typeof frontmatter["地点"] === "string" ? frontmatter["地点"] : "";
		const createdAt = typeof frontmatter["created"] === "string" ? frontmatter["created"] : "";

		const raw = await this.app.vault.read(file);
		const markdownBody = this.stripYamlFrontmatter(raw).trim();
		const body = this.extractContentSection(markdownBody);
		const imagesMarkdown = this.extractImagesSection(markdownBody);
		const images = this.extractImageLinks(markdownBody);
		const comments = this.extractCommentsFromMarkdown(markdownBody);

		return { file, title, location, createdAt, comments, body, images, imagesMarkdown };
	}

	private stripYamlFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
	}

	private extractImageLinks(content: string): string[] {
		const imageSection = this.extractTopLevelSection(content, "图片");
		const scope = imageSection ?? content;
		const result: string[] = [];
		this.forEachNonCodeSegment(scope, (segment) => {
			const obsidianRegex = /!\[\[([^\]]+?)\]\]/g;
			let obsidianMatch: RegExpExecArray | null = null;
			while ((obsidianMatch = obsidianRegex.exec(segment)) !== null) {
				const raw = obsidianMatch[1].split("|")[0].trim();
				if (raw) result.push(raw);
			}
			const markdownRegex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
			let markdownMatch: RegExpExecArray | null = null;
			while ((markdownMatch = markdownRegex.exec(segment)) !== null) {
				const raw = markdownMatch[1].split("|")[0].trim();
				if (raw) result.push(raw);
			}
		});
		return result;
	}

	private extractImagesSection(content: string): string {
		const normalized = content.replace(/\r\n/g, "\n");
		const lines = normalized.split("\n");
		let inImages = false;
		let resultLines: string[] = [];
		for (const line of lines) {
			const headingMatch = line.match(/^##\s*(.+?)\s*$/);
			if (headingMatch) {
				if (inImages) break;
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

	private extractContentSection(content: string): string {
		const normalized = content.replace(/\r\n/g, "\n");
		const section = this.extractTopLevelSection(normalized, "正文");
		if (section !== null) {
			return section.trim();
		}
		return this.removeImageLinksFromBody(normalized).trim();
	}

	private extractTopLevelSection(content: string, headingName: string): string | null {
		const lines = content.replace(/\r\n/g, "\n").split("\n");
		const collected: string[] = [];
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
				} else if (token === fenceToken) {
					inFence = false;
					fenceToken = "";
				}
			}
			if (!inFence) {
				const headingMatch = line.match(/^##\s*(.+?)\s*$/);
				if (headingMatch) {
					const currentHeading = headingMatch[1].trim();
					if (collecting) break;
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

	private forEachNonCodeSegment(content: string, handler: (segment: string) => void) {
		const lines = content.replace(/\r\n/g, "\n").split("\n");
		let inFence = false;
		let fenceToken = "";
		let chunk: string[] = [];
		const flush = () => {
			if (chunk.length === 0) return;
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
				} else if (token === fenceToken) {
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

	private async renderMomentCardAsync(parentEl: HTMLElement, item: MomentItem) {
		const cardEl = parentEl.createDiv({ cls: "moments-card" });

		const headerEl = cardEl.createDiv({ cls: "moments-card-header" });
		headerEl.createDiv({ cls: "moments-title", text: item.title || "未命名" });

		const bodyEl = cardEl.createDiv({ cls: "moments-body" });
		bodyEl.setText(this.removeImageLinksFromBody(item.body));

		if (item.imagesMarkdown && item.imagesMarkdown.trim()) {
			const tempDiv = document.createElement("div");
			await MarkdownRenderer.render(
				this.app,
				item.imagesMarkdown,
				tempDiv,
				item.file.path,
				this
			);
			const images = Array.from(tempDiv.querySelectorAll("img"));
			if (images.length > 0) {
				const gridEl = cardEl.createDiv({ cls: "moments-grid" });
				const imgCount = images.length;
				gridEl.addClass(`grid-${imgCount}`);
				if (imgCount === 1) gridEl.addClass("moments-grid--1");
				else if (imgCount <= 4) gridEl.addClass("moments-grid--2");
				else gridEl.addClass("moments-grid--3");
				this.applyGridLayoutStyle(gridEl, imgCount);

				for (const img of images) {
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
				new Notice("评论内容不能为空");
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
					return normalized.replace(commentSectionRegex, (_m, heading: string, body: string) => {
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
				new Notice("评论已添加");
			} catch (error) {
				console.error(error);
				new Notice("评论提交失败");
			}
		});
	}

	private renderCommentsList(containerEl: HTMLElement, comments: string[]) {
		containerEl.empty();
		if (comments.length === 0) {
			containerEl.createDiv({ cls: "moments-comment-empty", text: "暂无评论" });
			return;
		}
		for (const comment of comments) {
			containerEl.createDiv({ cls: "moments-comment-item", text: comment });
		}
	}

	private extractCommentsFromMarkdown(content: string): string[] {
		const commentsSection = this.extractTopLevelSection(content, "评论区");
		if (!commentsSection) return [];
		const comments: string[] = [];
		this.forEachNonCodeSegment(commentsSection, (segment) => {
			for (const line of segment.split("\n")) {
				const match = line.match(/^\s*-\s+(.+?)\s*$/);
				if (match) comments.push(match[1]);
			}
		});
		return comments;
	}

	private formatCommentsSummaryText(count: number): string {
		return `💬 ${count} 条评论`;
	}

	private removeImageLinksFromBody(content: string): string {
		const parts: string[] = [];
		this.forEachNonCodeSegment(content, (segment) => {
			segment = segment.replace(/!\[\[[^\]]+?\]\]/g, "");
			segment = segment.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
			parts.push(segment);
		});
		return parts.join("\n").trim();
	}

	private applyGridLayoutStyle(gridEl: HTMLElement, imgCount: number) {
		gridEl.style.display = "grid";
		gridEl.style.gap = "5px";
		if (imgCount === 1) {
			gridEl.style.gridTemplateColumns = "1fr";
			gridEl.style.maxWidth = "220px";
		} else if (imgCount <= 4) {
			gridEl.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
			gridEl.style.maxWidth = "220px";
		} else {
			gridEl.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
			gridEl.style.maxWidth = "330px";
		}
	}

	private parseDateTime(value: string): number {
		if (!value) return 0;
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	private formatCommentTime(date: Date): string {
		const yyyy = date.getFullYear();
		const mm = this.pad(date.getMonth() + 1);
		const dd = this.pad(date.getDate());
		const hh = this.pad(date.getHours());
		const mi = this.pad(date.getMinutes());
		return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
	}

	private pad(value: number): string {
		return value.toString().padStart(2, "0");
	}

	cleanFolderPath(path: string): string {
		const trimmed = path
			.trim()
			.replace(/\\/g, "/")
			.replace(/^\/+/, "")
			.replace(/\/+$/, "");
		return trimmed ? normalizePath(trimmed) : "";
	}
}

export class CreateMomentModal extends Modal {
	plugin: ObsidianMomentsPlugin;
	titleValue = "";
	locationValue = "";
	contentValue = "";
	selectedFiles: File[] = [];

	constructor(app: App, plugin: ObsidianMomentsPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.modalEl.addClass("moments-create-modal");
		const { contentEl } = this;
		contentEl.empty();
		const modalContent = contentEl.closest(".modal-content") as HTMLElement | null;
		if (modalContent) {
			modalContent.style.maxHeight = "75vh";
			modalContent.style.overflowY = "auto";
		}

		contentEl.createEl("h2", { text: "创建 Moments" });

		new Setting(contentEl)
			.setName("标题")
			.addText((text) =>
				text.setPlaceholder("输入标题").onChange((value) => {
					this.titleValue = value.trim();
				}),
			);

		new Setting(contentEl)
			.setName("地点")
			.addText((text) =>
				text.setPlaceholder("输入地点").onChange((value) => {
					this.locationValue = value.trim();
				}),
			);

		const contentSetting = new Setting(contentEl).setName("内容");
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

		const imageSetting = new Setting(contentEl).setName("图片");
		const fileInput = imageSetting.controlEl.createEl("input", { type: "file" });
		fileInput.multiple = true;
		fileInput.accept = "image/*";
		fileInput.addEventListener("change", () => {
			this.selectedFiles = Array.from(fileInput.files ?? []);
		});

		new Setting(contentEl).addButton((button) =>
			button.setButtonText("发布").setCta().onClick(async () => {
				await this.handleSubmit();
			}),
		);
	}

	onClose() {
		this.modalEl.removeClass("moments-create-modal");
		this.contentEl.empty();
	}

	private async handleSubmit() {
		try {
			const now = new Date();
			const createdAt = this.formatDateTimeISO(now);
			const imageTime = this.formatImageFileTime(now);
			const titleForFilename = this.sanitizeFileName(this.titleValue || "未命名");

			const attachmentsFolder = this.cleanFolderPath(this.plugin.settings.attachmentsPath);
			const momentsFolder = this.cleanFolderPath(this.plugin.settings.sourceFolders[0] || "Moments/记录/"); // 默认第一个文件夹
			if (!attachmentsFolder) {
				throw new Error("Attachments path is empty");
			}
			if (!momentsFolder) {
				throw new Error("Moments source folder is empty, please add at least one source folder in settings");
			}

			await this.ensureFolderExists(attachmentsFolder);
			await this.ensureFolderExists(momentsFolder);

			const imageLinks: string[] = [];
			for (const file of this.selectedFiles) {
				const buffer = await file.arrayBuffer();
				const ext = this.getFileExtension(file.name);
				const imageName = `IMG-${imageTime}-${this.randomDigits(4)}${ext}`;
				const imagePath = normalizePath(`${attachmentsFolder}/${imageName}`);
				await this.app.vault.createBinary(imagePath, buffer);
				imageLinks.push(`![[${imagePath}]]`);
			}

			// tags 字段添加 "moments"
			const frontmatter = [
				"---",
				`标题: ${this.titleValue || ""}`,
				`地点: ${this.locationValue || ""}`,
				`created: ${createdAt}`,
				`updated: ${createdAt}`,
				`tags: [moments]`,
				"---",
			].join("\n");

			const body = this.contentValue.trimEnd();
			const imagesBlock = imageLinks.join("\n");
			const contentSection = `## 正文\n${body || "（无正文）"}`;
			const imageSection = `## 图片\n${imagesBlock || "（无图片）"}`;
			const commentsSection = "## 评论区";
			const markdown = `${frontmatter}\n\n${contentSection}\n\n${imageSection}\n\n${commentsSection}\n`;

			// 文件名格式：YYYY-MM-DD 标题.md
			const dateStr = this.formatFileDate(now);
			const mdFileName = `${dateStr} ${titleForFilename}.md`;
			const mdFilePath = normalizePath(`${momentsFolder}/${mdFileName}`);
			await this.app.vault.create(mdFilePath, markdown);

			new Notice("Moments 发布成功");
			this.close();
		} catch (error) {
			console.error(error);
			new Notice("发布失败，请检查路径配置或文件名是否冲突");
		}
	}

	private cleanFolderPath(path: string): string {
		return this.plugin.cleanFolderPath(path);
	}

	private async ensureFolderExists(folderPath: string) {
		if (!folderPath) return;
		const parts = folderPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (folder && !(folder instanceof TFolder)) {
			throw new Error(`Path is not a folder: ${folderPath}`);
		}
	}

	private sanitizeFileName(value: string): string {
		return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "未命名";
	}

	private getFileExtension(fileName: string): string {
		const idx = fileName.lastIndexOf(".");
		return idx >= 0 ? fileName.slice(idx) : ".png";
	}

	private randomDigits(length: number): string {
		const min = Math.pow(10, Math.max(1, length) - 1);
		const max = Math.pow(10, Math.max(1, length)) - 1;
		return `${Math.floor(Math.random() * (max - min + 1)) + min}`;
	}

	private pad(value: number): string {
		return value.toString().padStart(2, "0");
	}

	private formatDateTimeISO(date: Date): string {
		const yyyy = date.getFullYear();
		const mm = this.pad(date.getMonth() + 1);
		const dd = this.pad(date.getDate());
		const hh = this.pad(date.getHours());
		const mi = this.pad(date.getMinutes());
		const ss = this.pad(date.getSeconds());
		return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
	}

	private formatFileDate(date: Date): string {
		const yyyy = date.getFullYear();
		const mm = this.pad(date.getMonth() + 1);
		const dd = this.pad(date.getDate());
		return `${yyyy}-${mm}-${dd}`;
	}

	private formatImageFileTime(date: Date): string {
		const yyyy = date.getFullYear();
		const mm = this.pad(date.getMonth() + 1);
		const dd = this.pad(date.getDate());
		const hh = this.pad(date.getHours());
		const mi = this.pad(date.getMinutes());
		const ss = this.pad(date.getSeconds());
		return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
	}
}

export class MomentsSettingTab extends PluginSettingTab {
	plugin: ObsidianMomentsPlugin;

	constructor(app: App, plugin: ObsidianMomentsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "obsidian-moments 设置" });

		// 多目录配置
		new Setting(containerEl)
			.setName("Moments 来源文件夹")
			.setDesc("Markdown 文件存放的文件夹，只有 frontmatter 中包含 tags: moments 的文件才会被展示")
			.addButton(btn => btn.setButtonText("添加文件夹").onClick(async () => {
				// 弹出输入框让用户输入路径
				const inputContainer = containerEl.createDiv({ cls: "moments-add-folder-input" });
				const input = inputContainer.createEl("input", { type: "text", placeholder: "例如: Moments/记录/" });
				const confirmBtn = inputContainer.createEl("button", { text: "确认" });
				confirmBtn.onclick = async () => {
					const folder = input.value.trim();
					if (folder && !this.plugin.settings.sourceFolders.includes(folder)) {
						this.plugin.settings.sourceFolders.push(folder);
						await this.plugin.saveSettings();
						this.display(); // 刷新界面
					} else if (folder) {
						new Notice("文件夹已存在");
					}
				};
				input.focus();
				const onBlur = () => {
					inputContainer.remove();
					window.removeEventListener("click", outsideClick);
				};
				const outsideClick = (e: MouseEvent) => {
					if (!inputContainer.contains(e.target as Node)) {
						onBlur();
					}
				};
				setTimeout(() => window.addEventListener("click", outsideClick), 0);
			}));

		// 显示已有文件夹列表
		for (const folder of this.plugin.settings.sourceFolders) {
			const setting = new Setting(containerEl)
				.setName(folder)
				.addButton(btn => btn.setButtonText("删除").setWarning().onClick(async () => {
					const idx = this.plugin.settings.sourceFolders.indexOf(folder);
					if (idx !== -1) {
						this.plugin.settings.sourceFolders.splice(idx, 1);
						await this.plugin.saveSettings();
						this.display();
					}
				}));
			setting.descEl.createSpan({ text: "📁 来源目录", cls: "moments-folder-desc" });
		}

		new Setting(containerEl)
			.setName("图片附件存储路径")
			.setDesc("用于保存通过插件上传的图片文件")
			.addText((text) =>
				text
					.setPlaceholder("例如：Moments/Attachments/")
					.setValue(this.plugin.settings.attachmentsPath)
					.onChange(async (value) => {
						this.plugin.settings.attachmentsPath = value.trim() || DEFAULT_SETTINGS.attachmentsPath;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("展示顺序")
			.setDesc("按创建时间排序：正序或倒序")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("desc", "倒序（最新在前）")
					.addOption("asc", "正序（最早在前）")
					.setValue(this.plugin.settings.order)
					.onChange(async (value) => {
						this.plugin.settings.order = value === "asc" ? "asc" : "desc";
						await this.plugin.saveSettings();
					}),
			);
	}
}