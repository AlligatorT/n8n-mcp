/**
 * NPM Version Checker Utility
 *
 * Checks if the current n8n-mcp version is outdated by comparing
 * against the latest version published on npm.
 */

import { logger } from './logger';

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  isOutdated: boolean;
  updateAvailable: boolean;
  error: string | null;
  checkedAt: Date;
  updateCommand?: string;
}

// Cache for version check to avoid excessive npm requests
let versionCheckCache: VersionCheckResult | null = null;
let lastCheckTime: number = 0;
const CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour cache

/**
 * Check if current version is outdated compared to npm registry
 * Uses caching to avoid excessive npm API calls
 *
 * @param forceRefresh - Force a fresh check, bypassing cache
 * @returns Version check result
 */
export async function checkNpmVersion(forceRefresh: boolean = false): Promise<VersionCheckResult> {
  const now = Date.now();

  // Return cached result if available and not expired
  if (!forceRefresh && versionCheckCache && (now - lastCheckTime) < CACHE_TTL_MS) {
    logger.debug('Returning cached npm version check result');
    return versionCheckCache;
  }

  // Get current version from package.json
  const packageJson = require('../../package.json');
  const currentVersion = packageJson.version;

  try {
    // Fetch latest version from npm registry
    const response = await fetch('https://registry.npmjs.org/n8n-mcp/latest', {
      headers: {
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    if (!response.ok) {
      logger.warn('Failed to fetch npm version info', {
        status: response.status,
        statusText: response.statusText
      });

      const result: VersionCheckResult = {
        currentVersion,
        latestVersion: null,
        isOutdated: false,
        updateAvailable: false,
        error: `npm registry returned ${response.status}`,
        checkedAt: new Date()
      };

      versionCheckCache = result;
      lastCheckTime = now;
      return result;
    }

    const data: any = await response.json();
    const latestVersion = data.version as string;

    // Compare versions
    const isOutdated = compareVersions(currentVersion, latestVersion) < 0;

    const result: VersionCheckResult = {
      currentVersion,
      latestVersion,
      isOutdated,
      updateAvailable: isOutdated,
      error: null,
      checkedAt: new Date(),
      updateCommand: isOutdated ? `npm install -g n8n-mcp@${latestVersion}` : undefined
    };

    // Cache the result
    versionCheckCache = result;
    lastCheckTime = now;

    logger.debug('npm version check completed', {
      current: currentVersion,
      latest: latestVersion,
      outdated: isOutdated
    });

    return result;

  } catch (error) {
    logger.warn('Error checking npm version', {
      error: error instanceof Error ? error.message : String(error)
    });

    const result: VersionCheckResult = {
      currentVersion,
      latestVersion: null,
      isOutdated: false,
      updateAvailable: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      checkedAt: new Date()
    };

    // Cache error result to avoid rapid retry
    versionCheckCache = result;
    lastCheckTime = now;

    return result;
  }
}

/**
 * Compare two semantic version strings
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 *
 * @param v1 - First version (e.g., "1.2.3")
 * @param v2 - Second version (e.g., "1.3.0")
 * @returns Comparison result
 */
export function compareVersions(v1: string, v2: string): number {
  // Remove 'v' prefix if present
  const clean1 = v1.replace(/^v/, '');
  const clean2 = v2.replace(/^v/, '');

  // Split into parts and convert to numbers
  const parts1 = clean1.split('.').map(n => parseInt(n, 10) || 0);
  const parts2 = clean2.split('.').map(n => parseInt(n, 10) || 0);

  // Compare each part
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }

  return 0; // Versions are equal
}

/**
 * Clear the version check cache (useful for testing)
 */
export function clearVersionCheckCache(): void {
  versionCheckCache = null;
  lastCheckTime = 0;
}

/**
 * Format version check result as a user-friendly message
 *
 * @param result - Version check result
 * @returns Formatted message
 */
export function formatVersionMessage(result: VersionCheckResult): string {
  if (result.error) {
    return `Version check failed: ${result.error}. Current version: ${result.currentVersion}`;
  }

  if (!result.latestVersion) {
    return `Current version: ${result.currentVersion} (latest version unknown)`;
  }

  if (result.isOutdated) {
    return `⚠️ Update available! Current: ${result.currentVersion} → Latest: ${result.latestVersion}`;
  }

  return `✓ You're up to date! Current version: ${result.currentVersion}`;
}
