/**
 * Single source of truth for the package version at runtime.
 *
 * Reads `package.json` relative to the built module. Falls back to `0.0.0`
 * when the metadata is unavailable (e.g. an inlined dev bundle), keeping the
 * CLI and MCP server usable rather than crashing on a missing file.
 */
import * as fs from 'fs'

export function packageVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown }
    if (typeof packageJson.version === 'string') return packageJson.version
  } catch {
    // Keep callers usable if package metadata is unavailable in a dev bundle.
  }
  return '0.0.0'
}
