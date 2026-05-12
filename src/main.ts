import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  WorkspaceLeaf
} from "obsidian";

const VIEW_TYPE_FOUNDRY_LINT = "foundry-lint-view";
const DEFAULT_BASE_URL = "https://app.foundry.example";

interface FoundrySettings {
  baseUrl: string;
  apiToken: string;
  defaultTenantId: string;
  tenants: Tenant[];
}

interface Tenant {
  id: string;
  name: string;
}

interface FoundryFrontmatter {
  pitchId?: string;
  tenantId?: string;
  publishedAt?: string;
  briefs?: BriefFrontmatter[];
}

interface BriefFrontmatter {
  id: string;
  title: string;
}

interface Pitch {
  id: string;
  title?: string;
  status?: string;
  publishedAt?: string;
}

interface Brief {
  id: string;
  title: string;
  bodyMd?: string;
  body?: string;
  url?: string;
}

interface LintCheck {
  id: string;
  label: string;
  passed: boolean;
  severity: string;
  message: string;
  hint: string;
}

interface LintReport {
  checks: LintCheck[];
}

const DEFAULT_SETTINGS: FoundrySettings = {
  baseUrl: DEFAULT_BASE_URL,
  apiToken: "",
  defaultTenantId: "",
  tenants: []
};

export default class FoundryPlugin extends Plugin {
  settings: FoundrySettings = DEFAULT_SETTINGS;
  private statusBarItem: HTMLElement | null = null;
  private activePitchId: string | null = null;
  private statusRequestId = 0;
  private pitchStatusCache = new Map<string, string>();

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new FoundrySettingTab(this.app, this));
    this.registerView(VIEW_TYPE_FOUNDRY_LINT, (leaf) => new FoundryLintView(leaf));

    this.addCommand({
      id: "publish-current-note",
      name: "Publish current note to Foundry as pitch",
      callback: () => void this.publishCurrentNote()
    });

    this.addCommand({
      id: "run-foundry-checks",
      name: "Run Foundry checks",
      checkCallback: (checking) => {
        const enabled = this.isActiveNoteLinked();
        if (!checking && enabled) void this.runFoundryChecks();
        return enabled;
      }
    });

    this.addCommand({
      id: "split-pitch-into-briefs",
      name: "Split pitch into briefs",
      checkCallback: (checking) => {
        const enabled = this.isActiveNoteLinked();
        if (!checking && enabled) void this.splitPitchIntoBriefs();
        return enabled;
      }
    });

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.hide();
    this.statusBarItem.addEventListener("click", () => {
      if (this.activePitchId) {
        window.open(`${trimTrailingSlash(this.settings.baseUrl)}/pitches/${this.activePitchId}`);
      }
    });

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.updateStatusBar()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      const activeFile = this.getActiveMarkdownFile();
      if (activeFile?.path === file.path) {
        void this.updateStatusBar();
      }
    }));

    void this.updateStatusBar();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_FOUNDRY_LINT);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async validateSettings(baseUrl: string, apiToken: string): Promise<Tenant[]> {
    const previous = this.settings;
    this.settings = {
      ...this.settings,
      baseUrl,
      apiToken
    };

    try {
      const me = await this.apiRequest<unknown>("GET", "/me");
      return normalizeTenants(me);
    } finally {
      this.settings = previous;
    }
  }

  private async publishCurrentNote() {
    const file = this.requireActiveMarkdownFile();
    if (!file) return;

    if (!this.requireAuthConfigured()) return;
    if (!this.requireTenantsConfigured()) return;

    const foundry = this.getFoundryFrontmatter(file);
    if (foundry?.pitchId) {
      new Notice("This note is already linked. Use the future Update command to push edits.");
      return;
    }

    const tenant = await this.pickTenant();
    if (!tenant) return;

    const content = await this.app.vault.read(file);
    const title = getFirstHeading(content) ?? file.basename;
    const bodyMd = removeFoundryFrontmatterBlock(content);

    try {
      const pitch = await this.apiRequest<Pitch>("POST", "/pitches", {
        tenantId: tenant.id,
        title,
        bodyMd,
        vaultExportPath: file.path
      });

      const pitchId = pitch.id;
      if (!pitchId) {
        new Notice("Foundry did not return a pitch ID.");
        return;
      }

      await this.writeFoundryFrontmatter(file, {
        pitchId,
        tenantId: tenant.id,
        publishedAt: pitch.publishedAt ?? new Date().toISOString()
      });

      if (pitch.status) {
        this.pitchStatusCache.set(pitchId, pitch.status);
      }

      new Notice("Published current note to Foundry.");
      await this.updateStatusBar();
    } catch (error) {
      this.showApiError(error, "Publish failed");
    }
  }

  private async runFoundryChecks() {
    const linked = this.requireLinkedActiveNote();
    if (!linked) return;

    if (!this.requireAuthConfigured()) return;

    try {
      const response = await this.apiRequest<unknown>("POST", `/pitches/${linked.foundry.pitchId}/lint`);
      const report = normalizeLintReport(response);
      await this.openLintView(report);
    } catch (error) {
      this.showApiError(error, "Foundry checks failed");
    }
  }

  private async splitPitchIntoBriefs() {
    const linked = this.requireLinkedActiveNote();
    if (!linked) return;

    if (!this.requireAuthConfigured()) return;

    const pitchId = linked.foundry.pitchId;
    const status = await this.getPitchStatus(pitchId);
    if (status !== "ready") {
      new Notice("This pitch is not ready for splitting yet.");
      return;
    }

    try {
      const response = await this.apiRequest<unknown>("POST", `/pitches/${pitchId}/split`);
      const briefs = normalizeBriefs(response);

      await this.writeFoundryFrontmatter(linked.file, {
        ...linked.foundry,
        briefs: briefs.map((brief) => ({
          id: brief.id,
          title: brief.title
        }))
      });

      new BriefsModal(this.app, this.settings.baseUrl, pitchId, briefs).open();
      new Notice("Split pitch into briefs.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 501 && error.code === "splitting-not-available") {
        new Notice("Splitting isn't available yet - try again later");
        return;
      }

      this.showApiError(error, "Pitch splitting failed");
    }
  }

  private async getPitchStatus(pitchId: string): Promise<string | null> {
    const cached = this.pitchStatusCache.get(pitchId);
    if (cached) return cached;

    try {
      const pitch = await this.apiRequest<Pitch>("GET", `/pitches/${pitchId}`);
      if (pitch.status) {
        this.pitchStatusCache.set(pitchId, pitch.status);
        return pitch.status;
      }
    } catch (error) {
      this.showApiError(error, "Could not load pitch status");
    }

    return null;
  }

  private async updateStatusBar() {
    const item = this.statusBarItem;
    if (!item) return;

    const requestId = ++this.statusRequestId;
    const file = this.getActiveMarkdownFile();
    const foundry = file ? this.getFoundryFrontmatter(file) : null;

    if (!foundry?.pitchId || !this.settings.apiToken) {
      this.activePitchId = null;
      item.hide();
      return;
    }

    this.activePitchId = foundry.pitchId;
    const cached = this.pitchStatusCache.get(foundry.pitchId);
    item.setText(cached ? `Foundry: ${cached}` : "Foundry: ...");
    item.show();

    try {
      const pitch = await this.apiRequest<Pitch>("GET", `/pitches/${foundry.pitchId}`);
      if (requestId !== this.statusRequestId) return;
      const status = pitch.status ?? "unknown";
      this.pitchStatusCache.set(foundry.pitchId, status);
      item.setText(`Foundry: ${status}`);
    } catch {
      if (requestId === this.statusRequestId) {
        item.setText("Foundry: unavailable");
      }
    }
  }

  private async openLintView(report: LintReport) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null | undefined = workspace.getLeavesOfType(VIEW_TYPE_FOUNDRY_LINT)[0];

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Could not open Foundry checks view.");
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_FOUNDRY_LINT, active: true });
    }

    await workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof FoundryLintView) {
      view.setReport(report);
    }
  }

  private async pickTenant(): Promise<Tenant | null> {
    if (this.settings.tenants.length === 0) {
      new Notice("Configure Foundry settings before publishing.");
      return null;
    }

    const sorted = [...this.settings.tenants].sort((a, b) => {
      if (a.id === this.settings.defaultTenantId) return -1;
      if (b.id === this.settings.defaultTenantId) return 1;
      return a.name.localeCompare(b.name);
    });

    return new Promise((resolve) => {
      const modal = new TenantSuggestModal(this.app, sorted, this.settings.defaultTenantId, resolve);
      modal.open();
    });
  }

  private getActiveMarkdownFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file ?? null;
  }

  private isActiveNoteLinked(): boolean {
    const file = this.getActiveMarkdownFile();
    if (!file) return false;
    return Boolean(this.getFoundryFrontmatter(file)?.pitchId);
  }

  private requireActiveMarkdownFile(): TFile | null {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Open a Markdown note first.");
      return null;
    }
    return file;
  }

  private requireLinkedActiveNote(): { file: TFile; foundry: Required<Pick<FoundryFrontmatter, "pitchId">> & FoundryFrontmatter } | null {
    const file = this.requireActiveMarkdownFile();
    if (!file) return null;

    const foundry = this.getFoundryFrontmatter(file);
    if (!foundry?.pitchId) {
      new Notice("This note is not linked to a Foundry pitch.");
      return null;
    }

    return {
      file,
      foundry: {
        ...foundry,
        pitchId: foundry.pitchId
      }
    };
  }

  private requireAuthConfigured(): boolean {
    if (!this.settings.baseUrl || !this.settings.apiToken) {
      new Notice("Configure Foundry base URL and API token first.");
      return false;
    }

    return true;
  }

  private requireTenantsConfigured(): boolean {
    if (!this.settings.defaultTenantId && this.settings.tenants.length === 0) {
      new Notice("Save Foundry settings to load tenants before publishing.");
      return false;
    }

    return true;
  }

  private getFoundryFrontmatter(file: TFile): FoundryFrontmatter | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const foundry = frontmatter?.foundry;
    if (!foundry || typeof foundry !== "object") return null;
    return foundry as FoundryFrontmatter;
  }

  private async writeFoundryFrontmatter(file: TFile, foundry: FoundryFrontmatter) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.foundry = foundry;
    });
  }

  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${trimTrailingSlash(this.settings.baseUrl)}/api/plugin/v1${path}`;
    const response = await requestUrl({
      url,
      method,
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false
    });

    const payload = parseJson(response.text);
    if (response.status < 200 || response.status >= 300) {
      throw ApiError.fromResponse(response.status, payload, response.text);
    }

    return payload as T;
  }

  private showApiError(error: unknown, fallback: string) {
    if (error instanceof ApiError) {
      new Notice(`${fallback}: ${error.message}`);
      return;
    }

    new Notice(fallback);
    console.error(error);
  }
}

class FoundrySettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: FoundryPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Foundry" });

    let baseUrl = this.plugin.settings.baseUrl;
    let apiToken = this.plugin.settings.apiToken;
    const errorEl = containerEl.createDiv({ cls: "foundry-setting-error" });

    new Setting(containerEl)
      .setName("Foundry base URL")
      .setDesc("The Foundry web app URL.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_BASE_URL)
          .setValue(baseUrl)
          .onChange((value) => {
            baseUrl = value.trim();
          });
      });

    new Setting(containerEl)
      .setName("API token")
      .setDesc("Personal API token from Foundry Settings.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(apiToken)
          .onChange((value) => {
            apiToken = value.trim();
          });
      });

    new Setting(containerEl)
      .setName("Save and validate")
      .setDesc("Calls GET /me and refreshes the tenant list.")
      .addButton((button) => {
        button
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            errorEl.empty();
            button.setDisabled(true);
            button.setButtonText("Validating...");

            try {
              const tenants = await this.plugin.validateSettings(baseUrl, apiToken);
              const existingDefault = this.plugin.settings.defaultTenantId;

              this.plugin.settings = {
                ...this.plugin.settings,
                baseUrl: baseUrl || DEFAULT_BASE_URL,
                apiToken,
                tenants,
                defaultTenantId: tenants.some((tenant) => tenant.id === existingDefault)
                  ? existingDefault
                  : tenants[0]?.id ?? ""
              };

              await this.plugin.saveSettings();
              new Notice("Foundry settings saved.");
              this.display();
            } catch (error) {
              const message = error instanceof ApiError && error.status === 401
                ? "Token rejected by Foundry."
                : error instanceof Error
                  ? error.message
                  : "Could not validate Foundry settings.";
              errorEl.setText(message);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Save");
            }
          });
      });

    new Setting(containerEl)
      .setName("Default tenant")
      .setDesc("Publish uses this tenant by default; you can override it when publishing.")
      .addDropdown((dropdown) => {
        for (const tenant of this.plugin.settings.tenants) {
          dropdown.addOption(tenant.id, tenant.name);
        }

        dropdown
          .setValue(this.plugin.settings.defaultTenantId)
          .onChange(async (value) => {
            this.plugin.settings.defaultTenantId = value;
            await this.plugin.saveSettings();
          });

        dropdown.setDisabled(this.plugin.settings.tenants.length === 0);
      });
  }
}

class FoundryLintView extends ItemView {
  private report: LintReport = { checks: [] };

  getViewType(): string {
    return VIEW_TYPE_FOUNDRY_LINT;
  }

  getDisplayText(): string {
    return "Foundry checks";
  }

  setReport(report: LintReport) {
    this.report = report;
    this.render();
  }

  async onOpen() {
    this.render();
  }

  private render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("foundry-lint-view");

    const passed = this.report.checks.filter((check) => check.passed).length;
    const failed = this.report.checks.length - passed;

    container.createEl("h2", { text: "Foundry checks" });
    container.createDiv({
      cls: "foundry-lint-summary",
      text: `${passed} passed · ${failed} failed`
    });

    const table = container.createEl("table", { cls: "foundry-lint-table" });
    const headRow = table.createEl("thead").createEl("tr");
    headRow.createEl("th", { text: "Check" });
    headRow.createEl("th", { text: "Severity" });
    headRow.createEl("th", { text: "Message" });
    headRow.createEl("th", { text: "Hint" });

    const body = table.createEl("tbody");
    for (const check of this.report.checks) {
      const row = body.createEl("tr");
      row.createEl("td", { text: check.label });

      const severityCell = row.createEl("td");
      severityCell.createSpan({
        cls: `foundry-badge foundry-badge-${check.passed ? "pass" : check.severity.toLowerCase()}`,
        text: check.passed ? "pass" : check.severity
      });

      row.createEl("td", { text: check.message });
      row.createEl("td", { text: check.passed ? "" : check.hint });
    }
  }
}

class TenantSuggestModal extends FuzzySuggestModal<Tenant> {
  private didChoose = false;

  constructor(
    app: App,
    private tenants: Tenant[],
    private defaultTenantId: string,
    private onChoose: (tenant: Tenant | null) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a Foundry tenant");
  }

  getItems(): Tenant[] {
    return this.tenants;
  }

  getItemText(tenant: Tenant): string {
    return tenant.id === this.defaultTenantId ? `${tenant.name} (default)` : tenant.name;
  }

  onChooseItem(tenant: Tenant): void {
    this.didChoose = true;
    this.onChoose(tenant);
  }

  onClose(): void {
    if (this.didChoose) return;
    const chooser = this.onChoose;
    this.onChoose = () => undefined;
    chooser(null);
  }
}

class BriefsModal extends FuzzySuggestModal<Brief> {
  constructor(
    app: App,
    private baseUrl: string,
    private pitchId: string,
    private briefs: Brief[]
  ) {
    super(app);
    this.setPlaceholder("Created briefs");
  }

  getItems(): Brief[] {
    return this.briefs;
  }

  getItemText(brief: Brief): string {
    const firstLine = getFirstContentLine(brief.bodyMd ?? brief.body ?? "");
    return firstLine ? `${brief.title} - ${firstLine}` : brief.title;
  }

  onChooseItem(brief: Brief): void {
    window.open(brief.url ?? `${trimTrailingSlash(this.baseUrl)}/pitches/${this.pitchId}/briefs/${brief.id}`);
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }

  static fromResponse(status: number, payload: unknown, rawText: string): ApiError {
    if (isRecord(payload)) {
      const code = asString(payload.code) ?? asString(payload.error);
      const message = asString(payload.message) ?? asString(payload.error_description) ?? rawText;
      return new ApiError(message || `HTTP ${status}`, status, code);
    }

    return new ApiError(rawText || `HTTP ${status}`, status);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseJson(text: string): unknown {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeTenants(payload: unknown): Tenant[] {
  if (!isRecord(payload)) return [];
  const rawTenants = Array.isArray(payload.tenants) ? payload.tenants : [];
  return rawTenants.flatMap((tenant) => {
    if (!isRecord(tenant)) return [];
    const id = asString(tenant.id);
    if (!id) return [];
    const name = asString(tenant.name) ?? id;
    return [{ id, name }];
  });
}

function normalizeLintReport(payload: unknown): LintReport {
  const rawChecks = isRecord(payload) && Array.isArray(payload.checks)
    ? payload.checks
    : isRecord(payload) && Array.isArray(payload.rules)
      ? payload.rules
      : [];

  return {
    checks: rawChecks.flatMap((raw, index) => {
      if (!isRecord(raw)) return [];
      const passed = Boolean(raw.passed ?? raw.pass ?? raw.ok);
      const id = asString(raw.id) ?? asString(raw.key) ?? `check-${index + 1}`;
      const label = asString(raw.label) ?? asString(raw.name) ?? id;
      const severity = asString(raw.severity) ?? "info";
      const message = asString(raw.message) ?? (passed ? "Passed" : "Failed");
      const hint = asString(raw.hint) ?? asString(raw.remediation) ?? "";
      return [{ id, label, passed, severity, message, hint }];
    })
  };
}

function normalizeBriefs(payload: unknown): Brief[] {
  const rawBriefs = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.briefs)
      ? payload.briefs
      : [];

  return rawBriefs.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = asString(raw.id);
    const title = asString(raw.title);
    if (!id || !title) return [];
    return [{
      id,
      title,
      bodyMd: asString(raw.bodyMd),
      body: asString(raw.body),
      url: asString(raw.url)
    }];
  });
}

function getFirstHeading(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function getFirstContentLine(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#")) ?? "";
}

function removeFoundryFrontmatterBlock(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return content;

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return content;

  const yaml = lines.slice(1, end);
  const rest = lines.slice(end + 1);
  const filtered: string[] = [];

  for (let index = 0; index < yaml.length; index += 1) {
    const line = yaml[index];
    if (!/^foundry\s*:/.test(line)) {
      filtered.push(line);
      continue;
    }

    index += 1;
    while (index < yaml.length && (/^\s/.test(yaml[index]) || yaml[index].trim() === "")) {
      index += 1;
    }
    index -= 1;
  }

  const meaningfulYaml = filtered.some((line) => line.trim().length > 0);
  if (!meaningfulYaml) {
    return rest.join("\n").replace(/^\n+/, "");
  }

  return ["---", ...filtered, "---", ...rest].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
