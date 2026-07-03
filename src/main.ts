import {
	App,
	MarkdownPostProcessorContext,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";
import { promises as fs } from "fs";
import { posix as pathPosix } from "path";

interface UpdateProgressSettings {
	courseFolders: string[];
	tocPath: string;
	homePath: string;
	layersPath: string;
	prerequisitesPath: string;
	queueSize: number;
	completionHistory: Record<string, string>;
	quizBlocksPluginId: string;
	uncheckIncomplete: boolean;
	includeLegacyLessonPaths: boolean;
}

type QuizSavedState =
	| { type: "radio"; selectedId: string | null; frozen: boolean }
	| { type: "checkbox"; selectedIds: string[]; frozen: boolean }
	| { type: "select"; answers: string[]; frozen: boolean }
	| { type: "multi-select"; answers: string[]; frozen: boolean }
	| { type: "noodle"; pairs: Array<{ left: string; right: string }>; frozen: boolean }
	| { type: "free"; answer: string; frozen: boolean }
	| { type: "blank"; answers: string[]; checked: boolean };

type QuizStates = Record<string, QuizSavedState>;

interface QuizBlockInfo {
	source: string;
	type: string;
	id: string | null;
	lineStart: number;
	lineEnd: number;
}

interface LessonProgress {
	path: string;
	basename: string;
	total: number;
	completed: number;
	complete: boolean;
}

interface TocUpdateResult {
	changed: number;
	checked: number;
	unchecked: number;
	missingRows: string[];
}

interface QueueLesson {
	lessonId: string;
	topicId: string;
	topicNumber: string;
	path: string;
	name: string;
	layer: number;
	courseIndex: number;
	coordinate: number;
}

interface HomeRefreshResult {
	changed: boolean;
	completed: number;
	eligible: number;
	historyAdded: number;
	selected: number;
	total: number;
}

const DEFAULT_SETTINGS: UpdateProgressSettings = {
	courseFolders: ["Continuous-Time-Signal-Processing"],
	tocPath: "Continuous-Time-Signal-Processing/0. Table of Contents/TOC.md",
	homePath: "Continuous-Time-Signal-Processing/Home.md",
	layersPath: "/home/jake/Developer/MA/PIPELINE/Electrical-and-Computer-Engineering/3-Wire-Graph/1-Prerequisite-Identification/5-Publish-Graph/1-Outputs/Continuous-Time-Signal-Processing/Layers.csv",
	prerequisitesPath: "/home/jake/Developer/MA/COURSES/Electrical-and-Computer-Engineering/Continuous-Time-Signal-Processing/GRAPH-Continuous-Time-Signal-Processing/Prerequisites.csv",
	queueSize: 5,
	completionHistory: {},
	quizBlocksPluginId: "quiz-blocks",
	uncheckIncomplete: true,
	includeLegacyLessonPaths: true,
};

const CHECK_PROGRESS_BLOCK = "check-progress";
const UPDATE_PROGRESS_BLOCK = "update-progress";

export default class UpdateProgressPlugin extends Plugin {
	settings: UpdateProgressSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor(CHECK_PROGRESS_BLOCK, (source, el, ctx) => {
			this.renderProgressButton({
				source,
				el,
				ctx,
				defaultLabel: "Check progress",
				action: () => this.checkProgress(),
			});
		});

		this.registerMarkdownCodeBlockProcessor(UPDATE_PROGRESS_BLOCK, (source, el, ctx) => {
			this.renderProgressButton({
				source,
				el,
				ctx,
				defaultLabel: "Update progress",
				action: () => this.updateProgressForSourcePath(ctx.sourcePath),
			});
		});

		this.addCommand({
			id: "check-progress",
			name: "Check progress in configured folders",
			callback: () => {
				void this.checkProgress();
			},
		});

		this.addCommand({
			id: "update-current-lesson-progress",
			name: "Update progress for current lesson",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!this.isInConfiguredFolder(file.path)) return false;

				if (!checking) {
					void this.updateProgressForFile(file);
				}
				return true;
			},
		});

		this.addSettingTab(new UpdateProgressSettingTab(this.app, this));
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<UpdateProgressSettings> | null;
		const queueSize = typeof data?.queueSize === "number" && Number.isFinite(data.queueSize) && data.queueSize > 0
			? data.queueSize
			: DEFAULT_SETTINGS.queueSize;
		const completionHistory = isStringRecord(data?.completionHistory)
			? data.completionHistory
			: DEFAULT_SETTINGS.completionHistory;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			courseFolders: Array.isArray(data?.courseFolders) && data.courseFolders.length > 0
				? data.courseFolders
				: DEFAULT_SETTINGS.courseFolders,
			queueSize,
			completionHistory,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private renderProgressButton(args: {
		source: string;
		el: HTMLElement;
		ctx: MarkdownPostProcessorContext;
		defaultLabel: string;
		action: () => Promise<string>;
	}) {
		args.el.empty();
		const row = args.el.createDiv({ cls: "update-progress-button-row" });
		const button = row.createEl("button", {
			text: firstNonEmptyLine(args.source) ?? args.defaultLabel,
			cls: "mod-cta",
		});
		const status = row.createSpan({ cls: "update-progress-status" });

		button.addEventListener("click", () => {
			button.disabled = true;
			status.textContent = "Running...";
			void args.action()
				.then((message) => {
					status.textContent = message;
					new Notice(message);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					status.textContent = message;
					new Notice(message, 8000);
				})
				.finally(() => {
					button.disabled = false;
				});
		});
	}

	private async checkProgress(): Promise<string> {
		const quizStates = await this.loadQuizStates();
		const lessonPaths = await this.getConfiguredLessonPaths();
		if (lessonPaths.length === 0) {
			throw new Error("No lesson files found in the configured folders.");
		}

		const progresses: LessonProgress[] = [];
		for (const path of lessonPaths) {
			progresses.push(await this.getLessonProgress(path, quizStates));
		}

		const tocResult = await this.updateToc(progresses);
		const homeResult = await this.refreshHomeQueue();
		const complete = progresses.filter((progress) => progress.complete).length;
		const withNoQuizzes = progresses.filter((progress) => progress.total === 0).length;
		const parts = [
			`Checked ${progresses.length} lessons`,
			`${complete} complete`,
			`${tocResult.changed} TOC rows updated`,
			`${homeResult.selected} queued on Home`,
		];
		if (withNoQuizzes > 0) parts.push(`${withNoQuizzes} without quiz blocks`);
		if (tocResult.missingRows.length > 0) parts.push(`${tocResult.missingRows.length} missing TOC rows`);
		if (homeResult.historyAdded > 0) parts.push(`${homeResult.historyAdded} history entries recorded`);
		return parts.join("; ") + ".";
	}

	private async updateProgressForSourcePath(sourcePath: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			throw new Error("This progress button is not inside a Markdown file.");
		}
		return this.updateProgressForFile(file);
	}

	private async updateProgressForFile(file: TFile): Promise<string> {
		if (!this.isInConfiguredFolder(file.path)) {
			throw new Error("This file is outside the configured progress folders.");
		}

		const quizStates = await this.loadQuizStates();
		const progress = await this.getLessonProgress(file.path, quizStates);
		const tocResult = await this.updateToc([progress]);
		const homeResult = await this.refreshHomeQueue();

		const state = progress.complete ? "complete" : "incomplete";
		const updated = tocResult.changed === 1 ? "updated" : "already current";
		const homeUpdated = homeResult.changed ? "updated" : "already current";
		const historyMessage = homeResult.historyAdded > 0 ? `; ${homeResult.historyAdded} history entries recorded` : "";
		return `${progress.basename}: ${state} (${progress.completed}/${progress.total} quiz blocks); TOC ${updated}; Home queue ${homeUpdated} (${homeResult.selected} shown)${historyMessage}.`;
	}

	private async getConfiguredLessonPaths(): Promise<string[]> {
		const folders = this.getConfiguredFolders();
		const paths = new Set<string>();

		for (const file of this.app.vault.getFiles()
			.filter((file) =>
				file.extension === "md" &&
				folders.some((folder) => isPathInFolder(file.path, folder)) &&
				file.path.includes("/Lessons/"),
			)) {
			paths.add(file.path);
		}

		for (const folder of folders) {
			await this.collectLessonPathsFromAdapter(folder, paths);
		}

		return [...paths].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	}

	private async collectLessonPathsFromAdapter(folder: string, paths: Set<string>): Promise<void> {
		const adapter = this.app.vault.adapter as {
			exists?: (normalizedPath: string) => Promise<boolean>;
			list?: (normalizedPath: string) => Promise<{ files: string[]; folders: string[] }>;
		};
		if (typeof adapter.exists !== "function" || typeof adapter.list !== "function") return;
		if (!(await adapter.exists(folder))) return;

		const stack = [folder];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) continue;

			const listed = await adapter.list(current);
			for (const file of listed.files) {
				if (isLessonMarkdownPath(file)) {
					paths.add(file);
				}
			}
			for (const childFolder of listed.folders) {
				if (shouldTraverseForLessons(childFolder)) {
					stack.push(childFolder);
				}
			}
		}
	}

	private isInConfiguredFolder(path: string): boolean {
		return this.getConfiguredFolders().some((folder) => isPathInFolder(path, folder));
	}

	private getConfiguredFolders(): string[] {
		return this.settings.courseFolders
			.map((folder) => this.toVaultPath(folder))
			.filter((folder): folder is string => folder !== null && folder.length > 0);
	}

	private getConfiguredTocPath(): string {
		const tocPath = this.toVaultPath(this.settings.tocPath);
		if (!tocPath) throw new Error("TOC path is not inside this vault.");
		return tocPath;
	}

	private getConfiguredHomePath(): string {
		const homePath = this.toVaultPath(this.settings.homePath);
		if (!homePath) throw new Error("Home path is not inside this vault.");
		return homePath;
	}

	private toVaultPath(input: string): string | null {
		const raw = input.trim().replace(/\\/g, "/").replace(/\/+$/, "");
		if (!raw) return null;

		const vaultBasePath = this.getVaultBasePath();
		if (vaultBasePath) {
			const base = vaultBasePath.replace(/\\/g, "/").replace(/\/+$/, "");
			if (raw === base) return "";
			if (raw.startsWith(base + "/")) return normalizePath(raw.slice(base.length + 1));
		}

		if (raw.startsWith("/")) return null;
		return normalizePath(raw);
	}

	private getVaultBasePath(): string | null {
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
	}

	private async loadQuizStates(): Promise<QuizStates> {
		const liveStates = this.getLiveQuizStates();
		if (liveStates) return liveStates;

		const dataPath = `.obsidian/plugins/${this.settings.quizBlocksPluginId}/data.json`;
		try {
			const raw = await this.app.vault.adapter.read(dataPath);
			const parsed = JSON.parse(raw) as unknown;
			if (!isRecord(parsed) || !isRecord(parsed.quizStates)) return {};
			return normalizeQuizStates(parsed.quizStates);
		} catch (error) {
			throw new Error(`Could not read quiz-blocks data at ${dataPath}. Is the quiz-blocks plugin installed?`);
		}
	}

	private getLiveQuizStates(): QuizStates | null {
		const appWithPlugins = this.app as unknown as {
			plugins?: { plugins?: Record<string, unknown> };
		};
		const plugin = appWithPlugins.plugins?.plugins?.[this.settings.quizBlocksPluginId];
		if (!isRecord(plugin) || !isRecord(plugin.data) || !isRecord(plugin.data.quizStates)) {
			return null;
		}
		return normalizeQuizStates(plugin.data.quizStates);
	}

	private async getLessonProgress(path: string, quizStates: QuizStates): Promise<LessonProgress> {
		const text = await this.readMarkdownPath(path);
		const blocks = extractQuizBlocks(text);
		const candidatePaths = this.getStateSourcePathCandidates(path);
		let completed = 0;

		for (const block of blocks) {
			if (this.isQuizBlockComplete(block, candidatePaths, quizStates)) completed += 1;
		}

		return {
			path,
			basename: basenameWithoutExtension(path),
			total: blocks.length,
			completed,
			complete: blocks.length > 0 && completed === blocks.length,
		};
	}

	private async readMarkdownPath(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return this.app.vault.cachedRead(file);
		return this.app.vault.adapter.read(path);
	}

	private getStateSourcePathCandidates(currentPath: string): string[] {
		const candidates = [currentPath];
		if (!this.settings.includeLegacyLessonPaths) return candidates;

		const marker = "/Lessons/";
		const markerIndex = currentPath.indexOf(marker);
		if (markerIndex === -1 || !currentPath.endsWith(".md")) return candidates;

		const modulePath = currentPath.slice(0, markerIndex);
		const filename = currentPath.slice(markerIndex + marker.length);
		const lessonName = filename.slice(0, -".md".length);
		candidates.push(`${modulePath}/${lessonName}/${filename}`);
		return candidates;
	}

	private isQuizBlockComplete(block: QuizBlockInfo, sourcePaths: string[], quizStates: QuizStates): boolean {
		for (const sourcePath of sourcePaths) {
			const key = quizStateKey(sourcePath, block);
			const state = quizStates[key];
			if (state && isCompletedState(state, block.type)) return true;
		}
		return false;
	}

	private async updateToc(progresses: LessonProgress[]): Promise<TocUpdateResult> {
		const tocPath = this.getConfiguredTocPath();
		const tocFile = this.app.vault.getAbstractFileByPath(tocPath);
		if (!(tocFile instanceof TFile)) throw new Error(`TOC file not found: ${tocPath}`);

		const progressByTarget = new Map<string, LessonProgress>();
		for (const progress of progresses) {
			for (const target of this.getTocTargetsForLessonPath(progress.path)) {
				progressByTarget.set(target, progress);
			}
		}

		const text = await this.app.vault.cachedRead(tocFile);
		const lines = text.split(/\n/);
		const foundProgressPaths = new Set<string>();
		let changed = 0;
		let checked = 0;
		let unchecked = 0;

		const nextLines = lines.map((line) => {
			const target = getWikiTargetFromLine(line);
			if (!target) return line;

			const progress = progressByTarget.get(target);
			if (!progress) return line;

			foundProgressPaths.add(progress.path);
			const desired = progress.complete ? "x" : " ";
			if (desired === " " && !this.settings.uncheckIncomplete) return line;

			const nextLine = line.replace(/^(\s*-\s+\[)[ xX](\])/, `$1${desired}$2`);
			if (nextLine !== line) {
				changed += 1;
				if (desired === "x") checked += 1;
				else unchecked += 1;
			}
			return nextLine;
		});

		if (changed > 0) {
			await this.app.vault.modify(tocFile, nextLines.join("\n"));
		}

		const missingRows = progresses
			.filter((progress) => !foundProgressPaths.has(progress.path))
			.map((progress) => progress.path);
		return { changed, checked, unchecked, missingRows };
	}

	private getTocTargetsForLessonPath(path: string): string[] {
		const targets = new Set<string>([stripMdExtension(path)]);
		for (const folder of this.getConfiguredFolders()) {
			if (isPathInFolder(path, folder)) {
				targets.add(stripMdExtension(path.slice(folder.length + 1)));
			}
		}
		return [...targets];
	}

	private async refreshHomeQueue(): Promise<HomeRefreshResult> {
		const lessons = await this.buildQueueLessons();
		const prerequisites = await this.loadPrerequisites();
		const completed = await this.loadCompletedLessonIds(lessons);
		const historyAdded = await this.recordCompletedLessons(lessons, completed);
		const eligible = [...lessons.values()].filter((lesson) =>
			!completed.has(lesson.lessonId) &&
			isSubset(prerequisites.get(lesson.lessonId) ?? new Set<string>(), completed),
		);
		const selected = this.selectNextLessons(eligible);
		const homePath = this.getConfiguredHomePath();
		const nextText = this.renderHome(selected, lessons, completed, homePath);
		const existing = await this.readVaultTextIfExists(homePath);
		if (existing !== nextText) {
			await this.writeVaultText(homePath, nextText);
		}
		return {
			changed: existing !== nextText,
			completed: completed.size,
			eligible: eligible.length,
			historyAdded,
			selected: selected.length,
			total: lessons.size,
		};
	}

	private async recordCompletedLessons(lessons: Map<string, QueueLesson>, completed: Set<string>): Promise<number> {
		let added = 0;
		const now = new Date().toISOString();
		for (const lessonId of completed) {
			const lesson = lessons.get(lessonId);
			if (!lesson) continue;
			if (!this.settings.completionHistory[lesson.path]) {
				this.settings.completionHistory[lesson.path] = now;
				added += 1;
			}
		}
		if (added > 0) {
			await this.saveSettings();
		}
		return added;
	}

	private async buildQueueLessons(): Promise<Map<string, QueueLesson>> {
		const layers = await this.loadLayers();
		const lessons = new Map<string, QueueLesson>();
		for (const path of await this.getConfiguredLessonPaths()) {
			const text = await this.readMarkdownPath(path);
			const lessonId = readLessonId(text);
			if (!lessonId) continue;

			const topicId = lessonIdToTopicId(lessonId);
			const layer = layers.get(topicId);
			if (!layer) continue;

			lessons.set(lessonId, {
				lessonId,
				topicId,
				topicNumber: layer["topic-number"],
				path,
				name: normalizedLessonName(path),
				layer: intFromCsv(layer["nearest-integer-layer"], "nearest-integer-layer", topicId),
				courseIndex: intFromCsv(layer["course-map-index"], "course-map-index", topicId),
				coordinate: topicCoordinate(layer["topic-number"]),
			});
		}
		return lessons;
	}

	private async loadLayers(): Promise<Map<string, Record<string, string>>> {
		const rows = await this.readCsvSetting(this.settings.layersPath);
		if (rows.length > 0 && (!("topic-id" in rows[0]) || !("nearest-integer-layer" in rows[0]) || !("course-map-index" in rows[0]))) {
			throw new Error("Layers.csv is missing topic-id, nearest-integer-layer, or course-map-index.");
		}
		const layers = new Map<string, Record<string, string>>();
		for (const row of rows) {
			const topicId = row["topic-id"];
			if (topicId) layers.set(topicId, row);
		}
		return layers;
	}

	private async loadPrerequisites(): Promise<Map<string, Set<string>>> {
		const rows = await this.readCsvSetting(this.settings.prerequisitesPath);
		if (rows.length > 0 && !(("topic" in rows[0] && "requires" in rows[0]) || ("TopicID" in rows[0] && "PrerequisiteID" in rows[0]))) {
			throw new Error("Prerequisites.csv is missing topic/requires or TopicID/PrerequisiteID columns.");
		}
		const prerequisites = new Map<string, Set<string>>();
		for (const row of rows) {
			const topicId = row.topic ?? row.TopicID;
			const requiredTopicId = row.requires ?? row.PrerequisiteID;
			if (!topicId || !requiredTopicId) continue;

			const lessonId = topicIdToLessonId(topicId);
			const requiredLessonId = topicIdToLessonId(requiredTopicId);
			const current = prerequisites.get(lessonId) ?? new Set<string>();
			current.add(requiredLessonId);
			prerequisites.set(lessonId, current);
		}
		return prerequisites;
	}

	private async loadCompletedLessonIds(lessons: Map<string, QueueLesson>): Promise<Set<string>> {
		const tocText = await this.app.vault.adapter.read(this.getConfiguredTocPath());
		const lessonByTarget = new Map<string, string>();
		for (const lesson of lessons.values()) {
			for (const target of this.getTocTargetsForLessonPath(lesson.path)) {
				lessonByTarget.set(target, lesson.lessonId);
			}
		}

		const completed = new Set<string>();
		for (const line of tocText.split(/\r?\n/)) {
			if (!isCheckedTaskLine(line)) continue;
			const target = getWikiTargetFromLine(line);
			if (!target) continue;
			const lessonId = lessonByTarget.get(target);
			if (lessonId) completed.add(lessonId);
		}
		return completed;
	}

	private selectNextLessons(eligible: QueueLesson[]): QueueLesson[] {
		const byLayer = new Map<number, QueueLesson[]>();
		for (const lesson of eligible) {
			const lessons = byLayer.get(lesson.layer) ?? [];
			lessons.push(lesson);
			byLayer.set(lesson.layer, lessons);
		}

		const selected: QueueLesson[] = [];
		const layers = [...byLayer.keys()].sort((a, b) => a - b);
		for (const layer of layers) {
			const slots = this.settings.queueSize - selected.length;
			if (slots <= 0) break;
			selected.push(...selectBroadest(byLayer.get(layer) ?? [], slots, selected));
		}
		return selected.slice(0, this.settings.queueSize);
	}

	private renderHome(
		selected: QueueLesson[],
		lessons: Map<string, QueueLesson>,
		completed: Set<string>,
		homePath: string,
	): string {
		const lines = [
			"# Continuous-Time Signal Processing Home",
			"",
			"## Next Topics",
			"",
		];

		if (selected.length > 0) {
			for (const [index, lesson] of selected.entries()) {
				lines.push(
					`${index + 1}. [${lesson.name}](${markdownLinkTarget(lesson.path, homePath)})`,
				);
			}
		} else {
			lines.push("No eligible next lessons found.");
		}

		lines.push("", "## Progress", "");
		const coursePercent = lessons.size > 0 ? Math.round((completed.size / lessons.size) * 100) : 0;
		lines.push(`- Course: ${coursePercent}% (${completed.size}/${lessons.size})`);
		lines.push("");
		for (const unit of this.unitProgress(lessons, completed)) {
			const percent = unit.total > 0 ? Math.round((unit.completed / unit.total) * 100) : 0;
			lines.push(`- ${unit.name}: ${percent}% (${unit.completed}/${unit.total})`);
		}

		lines.push("", "## History", "");
		const completedLessons = [...completed]
			.map((lessonId) => lessons.get(lessonId))
			.filter((lesson): lesson is QueueLesson => lesson !== undefined)
			.sort((a, b) => {
				const timeDiff = timestampMillis(this.settings.completionHistory[b.path]) -
					timestampMillis(this.settings.completionHistory[a.path]);
				return timeDiff || a.courseIndex - b.courseIndex;
			});
		if (completedLessons.length > 0) {
			for (const lesson of completedLessons) {
				lines.push(
					`- [${lesson.name}](${markdownLinkTarget(lesson.path, homePath)}) - ${formatCompletionTime(this.settings.completionHistory[lesson.path])}`,
				);
			}
		} else {
			lines.push("No completed lessons yet.");
		}

		lines.push(
			"",
			"## Summary",
			"",
			`- Completed lessons: ${completed.size} / ${lessons.size}`,
			`- Queue size: ${selected.length} / ${this.settings.queueSize}`,
			"",
			"<!--",
			"Generated by obsidian-update-progress.",
			"Selection uses checked lesson rows in 0. Table of Contents/TOC.md,",
			"Prerequisites.csv, and Layers.csv nearest-integer-layer values.",
			"Completion history is recorded by obsidian-update-progress.",
			"-->",
			"",
		);
		return lines.join("\n");
	}

	private unitProgress(lessons: Map<string, QueueLesson>, completed: Set<string>): Array<{
		name: string;
		order: number;
		completed: number;
		total: number;
	}> {
		const units = new Map<string, { name: string; order: number; completed: number; total: number }>();
		for (const lesson of lessons.values()) {
			const name = this.unitNameForLessonPath(lesson.path);
			const unit = units.get(name) ?? {
				name,
				order: Number.parseInt(lesson.topicNumber.split(".")[0], 10),
				completed: 0,
				total: 0,
			};
			unit.total += 1;
			if (completed.has(lesson.lessonId)) unit.completed += 1;
			units.set(name, unit);
		}
		return [...units.values()].sort((a, b) => a.order - b.order);
	}

	private unitNameForLessonPath(path: string): string {
		for (const folder of this.getConfiguredFolders()) {
			if (isPathInFolder(path, folder)) {
				return path.slice(folder.length + 1).split("/")[0] ?? path;
			}
		}
		return path.split("/")[0] ?? path;
	}

	private async readCsvSetting(path: string): Promise<Record<string, string>[]> {
		const text = await this.readConfiguredText(path);
		return parseCsv(text);
	}

	private async readConfiguredText(path: string): Promise<string> {
		const target = this.toReadablePath(path);
		if (target.external) {
			return fs.readFile(target.path, "utf8");
		}
		return this.app.vault.adapter.read(target.path);
	}

	private toReadablePath(path: string): { path: string; external: boolean } {
		const vaultPath = this.toVaultPath(path);
		if (vaultPath !== null) return { path: vaultPath, external: false };

		const raw = path.trim().replace(/\\/g, "/");
		if (raw.startsWith("/")) return { path: raw, external: true };
		throw new Error(`Configured path is not readable: ${path}`);
	}

	private async readVaultTextIfExists(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return this.app.vault.cachedRead(file);
		return null;
	}

	private async writeVaultText(path: string, text: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, text);
		} else {
			await this.app.vault.adapter.write(path, text);
		}
	}
}

class UpdateProgressSettingTab extends PluginSettingTab {
	plugin: UpdateProgressPlugin;

	constructor(app: App, plugin: UpdateProgressPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Update Progress" });

		new Setting(containerEl)
			.setName("Course folders")
			.setDesc("One folder per line. Absolute paths inside this vault are converted to vault-relative paths.")
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text
					.setPlaceholder("Continuous-Time-Signal-Processing")
					.setValue(this.plugin.settings.courseFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.courseFolders = value
							.split(/\r?\n/)
							.map((line) => line.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("TOC path")
			.setDesc("The Markdown file whose lesson checkboxes should be updated.")
			.addText((text) => {
				text
					.setPlaceholder("Continuous-Time-Signal-Processing/0. Table of Contents/TOC.md")
					.setValue(this.plugin.settings.tocPath)
					.onChange(async (value) => {
						this.plugin.settings.tocPath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Home path")
			.setDesc("The Markdown file whose next-topic queue should be refreshed after progress updates.")
			.addText((text) => {
				text
					.setPlaceholder("Continuous-Time-Signal-Processing/Home.md")
					.setValue(this.plugin.settings.homePath)
					.onChange(async (value) => {
						this.plugin.settings.homePath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Layers CSV path")
			.setDesc("Absolute or vault-relative path to Layers.csv.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SETTINGS.layersPath)
					.setValue(this.plugin.settings.layersPath)
					.onChange(async (value) => {
						this.plugin.settings.layersPath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Prerequisites CSV path")
			.setDesc("Absolute or vault-relative path to Prerequisites.csv.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SETTINGS.prerequisitesPath)
					.setValue(this.plugin.settings.prerequisitesPath)
					.onChange(async (value) => {
						this.plugin.settings.prerequisitesPath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Home queue size")
			.setDesc("Maximum number of eligible next lessons to show on the home page.")
			.addText((text) => {
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.queueSize))
					.setValue(String(this.plugin.settings.queueSize))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value.trim(), 10);
						this.plugin.settings.queueSize = Number.isFinite(parsed) && parsed > 0
							? parsed
							: DEFAULT_SETTINGS.queueSize;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Quiz Blocks plugin ID")
			.setDesc("Used to read the quiz-blocks data.json file.")
			.addText((text) => {
				text
					.setPlaceholder("quiz-blocks")
					.setValue(this.plugin.settings.quizBlocksPluginId)
					.onChange(async (value) => {
						this.plugin.settings.quizBlocksPluginId = value.trim() || "quiz-blocks";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Uncheck incomplete lessons")
			.setDesc("When enabled, progress scans also clear lesson checkboxes whose quiz blocks are not all complete.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uncheckIncomplete)
					.onChange(async (value) => {
						this.plugin.settings.uncheckIncomplete = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Use legacy lesson paths")
			.setDesc("Also checks quiz state keys from the old per-lesson folder layout, useful after reorganizing lesson files.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includeLegacyLessonPaths)
					.onChange(async (value) => {
						this.plugin.settings.includeLegacyLessonPaths = value;
						await this.plugin.saveSettings();
					});
			});
	}
}

function parseCsv(text: string): Record<string, string>[] {
	const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));
	if (records.length === 0) return [];
	const headers = records[0].map((header) => header.trim());
	return records
		.slice(1)
		.filter((record) => record.some((value) => value.trim().length > 0))
		.map((record) => {
			const row: Record<string, string> = {};
			for (let index = 0; index < headers.length; index += 1) {
				row[headers[index]] = record[index] ?? "";
			}
			return row;
		});
}

function parseCsvRecords(text: string): string[][] {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let inQuotes = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inQuotes) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			record.push(field);
			field = "";
		} else if (char === "\n") {
			record.push(field);
			records.push(record);
			record = [];
			field = "";
		} else if (char !== "\r") {
			field += char;
		}
	}

	if (field.length > 0 || record.length > 0) {
		record.push(field);
		records.push(record);
	}
	return records;
}

function readLessonId(markdown: string): string | null {
	const match = markdown.match(/lesson-id:\s*(EE01-M\d{2}-\d{2}-L\d{2})/);
	return match?.[1] ?? null;
}

function topicIdToLessonId(topicId: string): string {
	const match = /^EE01-T(\d{2})-(\d{2})-(\d{2})$/.exec(topicId.trim());
	if (!match) throw new Error(`Unexpected topic id: ${topicId}`);
	return `EE01-M${match[1]}-${match[2]}-L${match[3]}`;
}

function lessonIdToTopicId(lessonId: string): string {
	const match = /^EE01-M(\d{2})-(\d{2})-L(\d{2})$/.exec(lessonId.trim());
	if (!match) throw new Error(`Unexpected lesson id: ${lessonId}`);
	return `EE01-T${match[1]}-${match[2]}-${match[3]}`;
}

function topicCoordinate(topicNumber: string): number {
	const parts = topicNumber.split(".").map((part) => Number.parseInt(part, 10));
	while (parts.length < 3) parts.push(0);
	return (parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0);
}

function normalizedLessonName(path: string): string {
	const stem = basenameWithoutExtension(path);
	return stem.replace(/^\d+(?:\.\d+)*\.\s*/, "").trim();
}

function intFromCsv(value: string | undefined, column: string, topicId: string): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid ${column} for ${topicId}: ${value ?? ""}`);
	return parsed;
}

function isCheckedTaskLine(line: string): boolean {
	return /^\s*-\s+\[[xX]\]\s+/.test(line);
}

function isSubset(values: Set<string>, allowed: Set<string>): boolean {
	for (const value of values) {
		if (!allowed.has(value)) return false;
	}
	return true;
}

function selectBroadest(candidates: QueueLesson[], count: number, anchors: QueueLesson[]): QueueLesson[] {
	if (count <= 0) return [];
	const ordered = [...candidates].sort(compareQueueLessons);
	if (ordered.length <= count) return ordered;

	const selected: QueueLesson[] = [];
	if (anchors.length === 0) {
		selected.push(ordered[0], ordered[ordered.length - 1]);
	}
	while (selected.length > count) selected.pop();

	while (selected.length < count) {
		const selectedIds = new Set(selected.map((lesson) => lesson.lessonId));
		const reference = [...anchors, ...selected];
		const remaining = ordered.filter((lesson) => !selectedIds.has(lesson.lessonId));
		if (reference.length === 0) {
			selected.push(remaining[0]);
			continue;
		}
		selected.push(maxBy(remaining, (lesson) => {
			const nearestGap = Math.min(...reference.map((other) => Math.abs(lesson.coordinate - other.coordinate)));
			const edgeGap = Math.max(...reference.map((other) => Math.abs(lesson.coordinate - other.coordinate)));
			return [nearestGap, edgeGap, -lesson.courseIndex];
		}));
	}

	return selected.sort(compareQueueLessons);
}

function compareQueueLessons(a: QueueLesson, b: QueueLesson): number {
	return a.coordinate - b.coordinate || a.courseIndex - b.courseIndex;
}

function maxBy<T>(items: T[], score: (item: T) => number[]): T {
	let best = items[0];
	let bestScore = score(best);
	for (const item of items.slice(1)) {
		const itemScore = score(item);
		if (compareNumberTuples(itemScore, bestScore) > 0) {
			best = item;
			bestScore = itemScore;
		}
	}
	return best;
}

function compareNumberTuples(a: number[], b: number[]): number {
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function markdownLinkTarget(targetPath: string, sourcePath: string): string {
	const sourceDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : ".";
	const relative = pathPosix.relative(sourceDir, targetPath);
	return /[ ()\[\]]/.test(relative) ? `<${relative}>` : relative;
}

function extractQuizBlocks(markdown: string): QuizBlockInfo[] {
	const lines = markdown.split(/\r?\n/);
	const blocks: QuizBlockInfo[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		if (!/^\s*```quiz\s*$/.test(lines[index])) continue;

		const start = index;
		const bodyStart = index + 1;
		let end = bodyStart;
		while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) {
			end += 1;
		}
		if (end >= lines.length) break;

		const source = lines.slice(bodyStart, end).join("\n");
		const type = readTopLevelScalar(source, "type");
		const id = readTopLevelScalar(source, "id");
		if (type) {
			blocks.push({
				source,
				type,
				id,
				lineStart: start,
				lineEnd: end,
			});
		}

		index = end;
	}

	return blocks;
}

function readTopLevelScalar(source: string, key: string): string | null {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = source.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "m"));
	if (!match) return null;
	return stripYamlQuote(match[1].trim());
}

function stripYamlQuote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function quizStateKey(sourcePath: string, block: QuizBlockInfo): string {
	const blockId = block.id
		? `id:${block.id}`
		: `block:${block.lineStart}:${block.lineEnd}:${hash(block.source)}`;
	return `quiz-${hash([sourcePath, block.type, blockId].join())}`;
}

function isCompletedState(state: QuizSavedState, expectedType: string): boolean {
	if (state.type !== expectedType) return false;
	switch (state.type) {
		case "blank":
			return state.checked;
		case "radio":
		case "checkbox":
		case "select":
		case "multi-select":
		case "noodle":
		case "free":
			return state.frozen;
	}
}

function normalizeQuizStates(value: Record<string, unknown>): QuizStates {
	const states: QuizStates = {};
	for (const [key, state] of Object.entries(value)) {
		const normalized = normalizeQuizSavedState(state);
		if (normalized) states[key] = normalized;
	}
	return states;
}

function normalizeQuizSavedState(value: unknown): QuizSavedState | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	const frozen = value.frozen === true;

	switch (value.type) {
		case "radio":
			return { type: "radio", selectedId: typeof value.selectedId === "string" ? value.selectedId : null, frozen };
		case "checkbox":
			return { type: "checkbox", selectedIds: strings(value.selectedIds), frozen };
		case "select":
		case "multi-select":
			return { type: value.type, answers: strings(value.answers), frozen };
		case "noodle":
			return { type: "noodle", pairs: pairs(value.pairs), frozen };
		case "free":
			return { type: "free", answer: typeof value.answer === "string" ? value.answer : "", frozen };
		case "blank":
			return { type: "blank", answers: strings(value.answers), checked: value.checked === true };
		default:
			return null;
	}
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pairs(value: unknown): Array<{ left: string; right: string }> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.left !== "string" || typeof item.right !== "string") return [];
		return [{ left: item.left, right: item.right }];
	});
}

function getWikiTargetFromLine(line: string): string | null {
	const start = line.indexOf("[[");
	if (start === -1) return null;
	const end = line.indexOf("]]", start + 2);
	if (end === -1) return null;

	const content = line.slice(start + 2, end);
	const target = splitUnescapedPipe(content)[0];
	return unescapeWikiPath(target);
}

function splitUnescapedPipe(value: string): [string, string | null] {
	let escaped = false;
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "|") {
			return [value.slice(0, i), value.slice(i + 1)];
		}
	}
	return [value, null];
}

function unescapeWikiPath(path: string): string {
	return path.replace(/\\([\\|])/g, "$1");
}

function stripMdExtension(path: string): string {
	return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function isLessonMarkdownPath(path: string): boolean {
	return path.endsWith(".md") && path.includes("/Lessons/");
}

function shouldTraverseForLessons(path: string): boolean {
	const segments = path.split("/");
	if (segments.includes("Source")) return false;
	return !segments.includes("Lessons") || path.endsWith("/Lessons");
}

function basenameWithoutExtension(path: string): string {
	const name = path.split("/").pop() ?? path;
	return stripMdExtension(name);
}

function isPathInFolder(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder + "/");
}

function firstNonEmptyLine(source: string): string | null {
	const line = source.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
	return line ?? null;
}

function formatCompletionTime(value: string | undefined): string {
	if (!value) return "Unknown";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;
	return [
		date.getFullYear(),
		pad2(date.getMonth() + 1),
		pad2(date.getDate()),
	].join("-") + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function timestampMillis(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	for (const key of Object.keys(value)) {
		if (typeof value[key] !== "string") return false;
	}
	return true;
}

function hash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i += 1) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
}
