import * as fetch from "node-fetch";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as unzipper from "unzipper";
import * as url from "url";
import { ExtensionContext, Event } from "vscode";
import { DistributionConfig } from "./config";
import { InvocationRateLimiter, InvocationRateLimiterResultKind, showAndLogErrorMessage } from "./helpers";
import { logger } from "./logging";
import * as helpers from "./helpers";
import { getCodeQlCliVersion, tryParseVersionString, Version } from "./cli-version";

/**
 * distribution.ts
 * ------------
 *
 * Management of CodeQL CLI binaries.
 */

/**
 * Default value for the owner name of the extension-managed distribution on GitHub.
 *
 * We set the default here rather than as a default config value so that this default is invoked
 * upon blanking the setting.
 */
const DEFAULT_DISTRIBUTION_OWNER_NAME = "github";

/**
 * Default value for the repository name of the extension-managed distribution on GitHub.
 *
 * We set the default here rather than as a default config value so that this default is invoked
 * upon blanking the setting.
 */
const DEFAULT_DISTRIBUTION_REPOSITORY_NAME = "codeql-cli-binaries";

/**
 * Version constraint for the CLI.
 *
 * This applies to both extension-managed and CLI distributions.
 */
export const DEFAULT_DISTRIBUTION_VERSION_CONSTRAINT: VersionConstraint = {
  description: "2.*.*",
  isVersionCompatible: (v: Version) => {
    return v.majorVersion === 2 && v.minorVersion >= 0;
  }
};

export interface DistributionProvider {
  getCodeQlPathWithoutVersionCheck(): Promise<string | undefined>;
  onDidChangeDistribution?: Event<void>;
}

export class DistributionManager implements DistributionProvider {
  constructor(extensionContext: ExtensionContext, config: DistributionConfig, versionConstraint: VersionConstraint) {
    this._config = config;
    this._extensionSpecificDistributionManager = new ExtensionSpecificDistributionManager(extensionContext, config, versionConstraint);
    this._onDidChangeDistribution = config.onDidChangeDistributionConfiguration;
    this._updateCheckRateLimiter = new InvocationRateLimiter(
      extensionContext,
      "extensionSpecificDistributionUpdateCheck",
      () => this._extensionSpecificDistributionManager.checkForUpdatesToDistribution()
    );
    this._versionConstraint = versionConstraint;
  }

  /**
   * Look up a CodeQL launcher binary.
   */
  public async getDistribution(): Promise<FindDistributionResult> {
    const codeQlPath = await this.getCodeQlPathWithoutVersionCheck();
    if (codeQlPath === undefined) {
      return {
        kind: FindDistributionResultKind.NoDistribution,
      };
    }
    const version = await getCodeQlCliVersion(codeQlPath, logger);
    if (version !== undefined && !this._versionConstraint.isVersionCompatible(version)) {
      return {
        codeQlPath,
        kind: FindDistributionResultKind.IncompatibleDistribution,
        version,
      };
    }
    if (version === undefined) {
      return {
        codeQlPath,
        kind: FindDistributionResultKind.UnknownCompatibilityDistribution,
      };
    }
    return {
      codeQlPath,
      kind: FindDistributionResultKind.CompatibleDistribution,
      version
    };
  }

  public async hasDistribution(): Promise<boolean> {
    const result = await this.getDistribution();
    return result.kind !== FindDistributionResultKind.NoDistribution;
  }

  /**
   * Returns the path to a possibly-compatible CodeQL launcher binary, or undefined if a binary not be found.
   */
  public async getCodeQlPathWithoutVersionCheck(): Promise<string | undefined> {
    // Check config setting, then extension specific distribution, then PATH.
    if (this._config.customCodeQlPath) {
      if (!await fs.pathExists(this._config.customCodeQlPath)) {
        showAndLogErrorMessage(`The CodeQL executable path is specified as "${this._config.customCodeQlPath}" ` +
          "by a configuration setting, but a CodeQL executable could not be found at that path. Please check " +
          "that a CodeQL executable exists at the specified path or remove the setting.");
        return undefined;
      }

      // emit a warning if using a deprecated launcher and a non-deprecated launcher exists
      if (
        deprecatedCodeQlLauncherName() &&
        this._config.customCodeQlPath.endsWith(deprecatedCodeQlLauncherName()!) &&
        await this.hasNewLauncherName()
      ) {
        warnDeprecatedLauncher();
      }
      return this._config.customCodeQlPath;
    }

    const extensionSpecificCodeQlPath = await this._extensionSpecificDistributionManager.getCodeQlPathWithoutVersionCheck();
    if (extensionSpecificCodeQlPath !== undefined) {
      return extensionSpecificCodeQlPath;
    }

    if (process.env.PATH) {
      for (const searchDirectory of process.env.PATH.split(path.delimiter)) {
        const expectedLauncherPath = await getExecutableFromDirectory(searchDirectory);
        if (expectedLauncherPath) {
          return expectedLauncherPath;
        }
      }
      logger.log("INFO: Could not find CodeQL on path.");
    }

    return undefined;
  }

  /**
   * Check for updates to the extension-managed distribution.  If one has not already been installed,
   * this will return an update available result with the latest available release.
   *
   * Returns a failed promise if an unexpected error occurs during installation.
   */
  public async checkForUpdatesToExtensionManagedDistribution(
    minSecondsSinceLastUpdateCheck: number): Promise<DistributionUpdateCheckResult> {
    const codeQlPath = await this.getCodeQlPathWithoutVersionCheck();
    const extensionManagedCodeQlPath = await this._extensionSpecificDistributionManager.getCodeQlPathWithoutVersionCheck();
    if (codeQlPath !== undefined && codeQlPath !== extensionManagedCodeQlPath) {
      // A distribution is present but it isn't managed by the extension.
      return createInvalidLocationResult();
    }
    const updateCheckResult = await this._updateCheckRateLimiter.invokeFunctionIfIntervalElapsed(minSecondsSinceLastUpdateCheck);
    switch (updateCheckResult.kind) {
      case InvocationRateLimiterResultKind.Invoked:
        return updateCheckResult.result;
      case InvocationRateLimiterResultKind.RateLimited:
        return createAlreadyCheckedRecentlyResult();
    }
  }

  /**
   * Installs a release of the extension-managed distribution.
   *
   * Returns a failed promise if an unexpected error occurs during installation.
   */
  public installExtensionManagedDistributionRelease(release: Release,
    progressCallback?: helpers.ProgressCallback): Promise<void> {
    return this._extensionSpecificDistributionManager.installDistributionRelease(release, progressCallback);
  }

  public get onDidChangeDistribution(): Event<void> | undefined {
    return this._onDidChangeDistribution;
  }

  /**
   * @return true if the non-deprecated launcher name exists on the file system
   * in the same directory as the specified launcher only if using an external
   * installation. False otherwise.
   */
  private async hasNewLauncherName(): Promise<boolean> {
    if (!this._config.customCodeQlPath) {
      // not managed externally
      return false;
    }
    const dir = path.dirname(this._config.customCodeQlPath);
    const newLaunderPath = path.join(dir, codeQlLauncherName());
    return await fs.pathExists(newLaunderPath);
  }

  private readonly _config: DistributionConfig;
  private readonly _extensionSpecificDistributionManager: ExtensionSpecificDistributionManager;
  private readonly _updateCheckRateLimiter: InvocationRateLimiter<DistributionUpdateCheckResult>;
  private readonly _onDidChangeDistribution: Event<void> | undefined;
  private readonly _versionConstraint: VersionConstraint;
}

class ExtensionSpecificDistributionManager {
  constructor(extensionContext: ExtensionContext, config: DistributionConfig, versionConstraint: VersionConstraint) {
    this._extensionContext = extensionContext;
    this._config = config;
    this._versionConstraint = versionConstraint;
  }

  public async getCodeQlPathWithoutVersionCheck(): Promise<string | undefined> {
    if (this.getInstalledRelease() !== undefined) {
      // An extension specific distribution has been installed.
      const expectedLauncherPath = await getExecutableFromDirectory(this.getDistributionRootPath(), true);
      if (expectedLauncherPath) {
        return expectedLauncherPath;
      }

      try {
        await this.removeDistribution();
      } catch (e) {
        logger.log("WARNING: Tried to remove corrupted CodeQL CLI at " +
          `${this.getDistributionStoragePath()} but encountered an error: ${e}.`);
      }
    }
    return undefined;
  }

  /**
   * Check for updates to the extension-managed distribution.  If one has not already been installed,
   * this will return an update available result with the latest available release.
   *
   * Returns a failed promise if an unexpected error occurs during installation.
   */
  public async checkForUpdatesToDistribution(): Promise<DistributionUpdateCheckResult> {
    const codeQlPath = await this.getCodeQlPathWithoutVersionCheck();
    const extensionSpecificRelease = this.getInstalledRelease();
    const latestRelease = await this.getLatestRelease();

    if (
      extensionSpecificRelease !== undefined &&
      codeQlPath !== undefined &&
      latestRelease.id === extensionSpecificRelease.id
    ) {
      return createAlreadyUpToDateResult();
    }
    return createUpdateAvailableResult(latestRelease);
  }

  /**
   * Installs a release of the extension-managed distribution.
   *
   * Returns a failed promise if an unexpected error occurs during installation.
   */
  public async installDistributionRelease(release: Release,
    progressCallback?: helpers.ProgressCallback): Promise<void> {
    await this.downloadDistribution(release, progressCallback);
    // Store the installed release within the global extension state.
    this.storeInstalledRelease(release);
  }

  private async downloadDistribution(release: Release,
    progressCallback?: helpers.ProgressCallback): Promise<void> {
    try {
      await this.removeDistribution();
    } catch (e) {
      logger.log(`Tried to clean up old version of CLI at ${this.getDistributionStoragePath()} ` +
        `but encountered an error: ${e}.`);
    }

    const assetStream = await this.createReleasesApiConsumer().streamBinaryContentOfAsset(release.assets[0]);
    const tmpDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-codeql"));

    try {
      const archivePath = path.join(tmpDirectory, "distributionDownload.zip");
      const archiveFile = fs.createWriteStream(archivePath);

      const contentLength = assetStream.headers.get("content-length");
      let numBytesDownloaded = 0;

      if (progressCallback && contentLength !== null) {
        const totalNumBytes = parseInt(contentLength, 10);
        const bytesToDisplayMB = (numBytes: number): string => `${(numBytes / (1024 * 1024)).toFixed(1)} MB`;
        const updateProgress = (): void => {
          progressCallback({
            step: numBytesDownloaded,
            maxStep: totalNumBytes,
            message: `Downloading CodeQL CLI… [${bytesToDisplayMB(numBytesDownloaded)} of ${bytesToDisplayMB(totalNumBytes)}]`,
          });
        };

        // Display the progress straight away rather than waiting for the first chunk.
        updateProgress();

        assetStream.body.on("data", data => {
          numBytesDownloaded += data.length;
          updateProgress();
        });
      }

      await new Promise((resolve, reject) =>
        assetStream.body.pipe(archiveFile)
          .on("finish", resolve)
          .on("error", reject)
      );

      await this.bumpDistributionFolderIndex();

      logger.log(`Extracting CodeQL CLI to ${this.getDistributionStoragePath()}`);
      await extractZipArchive(archivePath, this.getDistributionStoragePath());
    } finally {
      await fs.remove(tmpDirectory);
    }
  }

  /**
   * Remove the extension-managed distribution.
   *
   * This should not be called for a distribution that is currently in use, as remove may fail.
   */
  private async removeDistribution(): Promise<void> {
    this.storeInstalledRelease(undefined);
    if (await fs.pathExists(this.getDistributionStoragePath())) {
      await fs.remove(this.getDistributionStoragePath());
    }
  }

  private async getLatestRelease(): Promise<Release> {
    const release = await this.createReleasesApiConsumer().getLatestRelease(this._versionConstraint, this._config.includePrerelease);
    if (release.assets.length !== 1) {
      throw new Error("Release had an unexpected number of assets");
    }
    return release;
  }

  private createReleasesApiConsumer(): ReleasesApiConsumer {
    const ownerName = this._config.ownerName ? this._config.ownerName : DEFAULT_DISTRIBUTION_OWNER_NAME;
    const repositoryName = this._config.repositoryName ? this._config.repositoryName : DEFAULT_DISTRIBUTION_REPOSITORY_NAME;
    return new ReleasesApiConsumer(ownerName, repositoryName, this._config.personalAccessToken);
  }

  private async bumpDistributionFolderIndex(): Promise<void> {
    const index = this._extensionContext.globalState.get(
      ExtensionSpecificDistributionManager._currentDistributionFolderIndexStateKey, 0);
    await this._extensionContext.globalState.update(
      ExtensionSpecificDistributionManager._currentDistributionFolderIndexStateKey, index + 1);
  }

  private getDistributionStoragePath(): string {
    // Use an empty string for the initial distribution for backwards compatibility.
    const distributionFolderIndex = this._extensionContext.globalState.get(
      ExtensionSpecificDistributionManager._currentDistributionFolderIndexStateKey, 0) || "";
    return path.join(this._extensionContext.globalStoragePath,
      ExtensionSpecificDistributionManager._currentDistributionFolderBaseName + distributionFolderIndex);
  }

  private getDistributionRootPath(): string {
    return path.join(this.getDistributionStoragePath(),
      ExtensionSpecificDistributionManager._codeQlExtractedFolderName);
  }

  private getInstalledRelease(): Release | undefined {
    return this._extensionContext.globalState.get(ExtensionSpecificDistributionManager._installedReleaseStateKey);
  }

  private async storeInstalledRelease(release: Release | undefined): Promise<void> {
    await this._extensionContext.globalState.update(ExtensionSpecificDistributionManager._installedReleaseStateKey, release);
  }

  private readonly _config: DistributionConfig;
  private readonly _extensionContext: ExtensionContext;
  private readonly _versionConstraint: VersionConstraint;

  private static readonly _currentDistributionFolderBaseName = "distribution";
  private static readonly _currentDistributionFolderIndexStateKey = "distributionFolderIndex";
  private static readonly _installedReleaseStateKey = "distributionRelease";
  private static readonly _codeQlExtractedFolderName = "codeql";
}

export class ReleasesApiConsumer {
  constructor(ownerName: string, repoName: string, personalAccessToken?: string) {
    // Specify version of the GitHub API
    this._defaultHeaders["accept"] = "application/vnd.github.v3+json";

    if (personalAccessToken) {
      this._defaultHeaders["authorization"] = `token ${personalAccessToken}`;
    }

    this._ownerName = ownerName;
    this._repoName = repoName;
  }

  public async getLatestRelease(versionConstraint: VersionConstraint, includePrerelease = false): Promise<Release> {
    const apiPath = `/repos/${this._ownerName}/${this._repoName}/releases`;
    const allReleases: GithubRelease[] = await (await this.makeApiCall(apiPath)).json();
    const compatibleReleases = allReleases.filter(release => {
      if (release.prerelease && !includePrerelease) {
        return false;
      }

      const version = tryParseVersionString(release.tag_name);
      if (version === undefined || !versionConstraint.isVersionCompatible(version)) {
        return false;
      }

      return true;
    });
    // tryParseVersionString must succeed due to the previous filtering step
    const latestRelease = compatibleReleases.sort((a, b) => {
      const versionComparison = versionCompare(tryParseVersionString(b.tag_name)!, tryParseVersionString(a.tag_name)!);
      if (versionComparison === 0) {
        return b.created_at.localeCompare(a.created_at);
      }
      return versionComparison;
    })[0];
    if (latestRelease === undefined) {
      throw new Error("No compatible CodeQL CLI releases were found. " +
        "Please check that the CodeQL extension is up to date.");
    }
    const assets: ReleaseAsset[] = latestRelease.assets.map(asset => {
      return {
        id: asset.id,
        name: asset.name,
        size: asset.size
      };
    });

    return {
      assets,
      createdAt: latestRelease.created_at,
      id: latestRelease.id,
      name: latestRelease.name
    };
  }

  public async streamBinaryContentOfAsset(asset: ReleaseAsset): Promise<fetch.Response> {
    const apiPath = `/repos/${this._ownerName}/${this._repoName}/releases/assets/${asset.id}`;

    return await this.makeApiCall(apiPath, {
      "accept": "application/octet-stream"
    });
  }

  protected async makeApiCall(apiPath: string, additionalHeaders: { [key: string]: string } = {}): Promise<fetch.Response> {
    const response = await this.makeRawRequest(ReleasesApiConsumer._apiBase + apiPath,
      Object.assign({}, this._defaultHeaders, additionalHeaders));

    if (!response.ok) {
      // Check for rate limiting
      const rateLimitResetValue = response.headers.get("X-RateLimit-Reset");
      if (response.status === 403 && rateLimitResetValue) {
        const secondsToMillisecondsFactor = 1000;
        const rateLimitResetDate = new Date(parseInt(rateLimitResetValue, 10) * secondsToMillisecondsFactor);
        throw new GithubRateLimitedError(response.status, await response.text(), rateLimitResetDate);
      }
      throw new GithubApiError(response.status, await response.text());
    }
    return response;
  }

  private async makeRawRequest(
    requestUrl: string,
    headers: { [key: string]: string },
    redirectCount = 0): Promise<fetch.Response> {
    const response = await fetch.default(requestUrl, {
      headers,
      redirect: "manual"
    });

    const redirectUrl = response.headers.get("location");
    if (isRedirectStatusCode(response.status) && redirectUrl && redirectCount < ReleasesApiConsumer._maxRedirects) {
      const parsedRedirectUrl = url.parse(redirectUrl);
      if (parsedRedirectUrl.protocol != "https:") {
        throw new Error("Encountered a non-https redirect, rejecting");
      }
      if (parsedRedirectUrl.host != "api.github.com") {
        // Remove authorization header if we are redirected outside of the GitHub API.
        //
        // This is necessary to stream release assets since AWS fails if more than one auth
        // mechanism is provided.
        delete headers["authorization"];
      }
      return await this.makeRawRequest(redirectUrl, headers, redirectCount + 1);
    }

    return response;
  }

  private readonly _defaultHeaders: { [key: string]: string } = {};
  private readonly _ownerName: string;
  private readonly _repoName: string;

  private static readonly _apiBase = "https://api.github.com";
  private static readonly _maxRedirects = 20;
}

export async function extractZipArchive(archivePath: string, outPath: string): Promise<void> {
  const archive = await unzipper.Open.file(archivePath);
  await archive.extract({
    concurrency: 4,
    path: outPath
  });
  // Set file permissions for extracted files
  await Promise.all(archive.files.map(async file => {
    // Only change file permissions if within outPath (path.join normalises the path)
    const extractedPath = path.join(outPath, file.path);
    if (extractedPath.indexOf(outPath) !== 0 || !(await fs.pathExists(extractedPath))) {
      return Promise.resolve();
    }
    return fs.chmod(extractedPath, file.externalFileAttributes >>> 16);
  }));
}

/**
 * Comparison of semantic versions.
 *
 * Returns a positive number if a is greater than b.
 * Returns 0 if a equals b.
 * Returns a negative number if a is less than b.
 */
export function versionCompare(a: Version, b: Version): number {
  if (a.majorVersion !== b.majorVersion) {
    return a.majorVersion - b.majorVersion;
  }
  if (a.minorVersion !== b.minorVersion) {
    return a.minorVersion - b.minorVersion;
  }
  if (a.patchVersion !== b.patchVersion) {
    return a.patchVersion - b.patchVersion;
  }
  if (a.prereleaseVersion !== undefined && b.prereleaseVersion !== undefined) {
    return a.prereleaseVersion.localeCompare(b.prereleaseVersion);
  }
  return 0;
}

function codeQlLauncherName(): string {
  return (os.platform() === "win32") ? "codeql.exe" : "codeql";
}

function deprecatedCodeQlLauncherName(): string | undefined {
  return (os.platform() === "win32") ? "codeql.cmd" : undefined;
}

function isRedirectStatusCode(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

/*
 * Types and helper functions relating to those types.
 */

export enum FindDistributionResultKind {
  CompatibleDistribution,
  UnknownCompatibilityDistribution,
  IncompatibleDistribution,
  NoDistribution
}

export type FindDistributionResult =
  | CompatibleDistributionResult
  | UnknownCompatibilityDistributionResult
  | IncompatibleDistributionResult
  | NoDistributionResult;

interface CompatibleDistributionResult {
  codeQlPath: string;
  kind: FindDistributionResultKind.CompatibleDistribution;
  version: Version;
}

interface UnknownCompatibilityDistributionResult {
  codeQlPath: string;
  kind: FindDistributionResultKind.UnknownCompatibilityDistribution;
}

interface IncompatibleDistributionResult {
  codeQlPath: string;
  kind: FindDistributionResultKind.IncompatibleDistribution;
  version: Version;
}

interface NoDistributionResult {
  kind: FindDistributionResultKind.NoDistribution;
}

export enum DistributionUpdateCheckResultKind {
  AlreadyCheckedRecentlyResult,
  AlreadyUpToDate,
  InvalidLocation,
  UpdateAvailable
}

type DistributionUpdateCheckResult =
  | AlreadyCheckedRecentlyResult
  | AlreadyUpToDateResult
  | InvalidLocationResult
  | UpdateAvailableResult;

export interface AlreadyCheckedRecentlyResult {
  kind: DistributionUpdateCheckResultKind.AlreadyCheckedRecentlyResult;
}

export interface AlreadyUpToDateResult {
  kind: DistributionUpdateCheckResultKind.AlreadyUpToDate;
}

/**
 * The distribution could not be installed or updated because it is not managed by the extension.
 */
export interface InvalidLocationResult {
  kind: DistributionUpdateCheckResultKind.InvalidLocation;
}

export interface UpdateAvailableResult {
  kind: DistributionUpdateCheckResultKind.UpdateAvailable;
  updatedRelease: Release;
}

function createAlreadyCheckedRecentlyResult(): AlreadyCheckedRecentlyResult {
  return {
    kind: DistributionUpdateCheckResultKind.AlreadyCheckedRecentlyResult
  };
}

function createAlreadyUpToDateResult(): AlreadyUpToDateResult {
  return {
    kind: DistributionUpdateCheckResultKind.AlreadyUpToDate
  };
}

function createInvalidLocationResult(): InvalidLocationResult {
  return {
    kind: DistributionUpdateCheckResultKind.InvalidLocation
  };
}

function createUpdateAvailableResult(updatedRelease: Release): UpdateAvailableResult {
  return {
    kind: DistributionUpdateCheckResultKind.UpdateAvailable,
    updatedRelease
  };
}

// Exported for testing
export async function getExecutableFromDirectory(directory: string, warnWhenNotFound = false): Promise<string | undefined> {
  const expectedLauncherPath = path.join(directory, codeQlLauncherName());
  const deprecatedLauncherName = deprecatedCodeQlLauncherName();
  const alternateExpectedLauncherPath = deprecatedLauncherName ? path.join(directory, deprecatedLauncherName) : undefined;
  if (await fs.pathExists(expectedLauncherPath)) {
    return expectedLauncherPath;
  } else if (alternateExpectedLauncherPath && (await fs.pathExists(alternateExpectedLauncherPath))) {
    warnDeprecatedLauncher();
    return alternateExpectedLauncherPath;
  }
  if (warnWhenNotFound) {
    logger.log(`WARNING: Expected to find a CodeQL CLI executable at ${expectedLauncherPath} but one was not found. ` +
      "Will try PATH.");
  }
  return undefined;
}

function warnDeprecatedLauncher() {
  helpers.showAndLogWarningMessage(
    `The "${deprecatedCodeQlLauncherName()!}" launcher has been deprecated and will be removed in a future version. ` +
    `Please use "${codeQlLauncherName()}" instead. It is recommended to update to the latest CodeQL binaries.`
  );
}

/**
 * A release on GitHub.
 */
export interface Release {
  assets: ReleaseAsset[];

  /**
   * The creation date of the release on GitHub.
   */
  createdAt: string;

  /**
   * The id associated with the release on GitHub.
   */
  id: number;

  /**
   * The name associated with the release on GitHub.
   */
  name: string;
}

/**
 * An asset corresponding to a release on GitHub.
 */
export interface ReleaseAsset {
  /**
   * The id associated with the asset on GitHub.
   */
  id: number;

  /**
   * The name associated with the asset on GitHub.
   */
  name: string;

  /**
   * The size of the asset in bytes.
   */
  size: number;
}


/**
 * The json returned from github for a release.
 */
export interface GithubRelease {
  assets: GithubReleaseAsset[];

  /**
   * The creation date of the release on GitHub.
   */
  created_at: string;

  /**
   * The id associated with the release on GitHub.
   */
  id: number;

  /**
   * The name associated with the release on GitHub.
   */
  name: string;

  /**
   * Whether the release is a prerelease.
   */
  prerelease: boolean;

  /**
   * The tag name.  This should be the version.
   */
  tag_name: string;
}

/**
 * The json returned by github for an asset in a release.
 */
export interface GithubReleaseAsset {
  /**
   * The id associated with the asset on GitHub.
   */
  id: number;

  /**
   * The name associated with the asset on GitHub.
   */
  name: string;

  /**
   * The size of the asset in bytes.
   */
  size: number;
}

interface VersionConstraint {
  description: string;
  isVersionCompatible(version: Version): boolean;
}

export class GithubApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API call failed with status code ${status}, body: ${body}`);
  }
}

export class GithubRateLimitedError extends GithubApiError {
  constructor(public status: number, public body: string, public rateLimitResetDate: Date) {
    super(status, body);
  }
}
