/**
 * Unit tests for the graceful-upgrade helpers (updater.ts).
 * Network calls are not covered here — only pure logic (version compare +
 * vsix URL building), keeping the suite offline-deterministic.
 */

import { describe, expect, it } from 'vitest'
import { compareVersions, vsixDownloadUrl } from './updater.ts'

describe('compareVersions', () => {
  it('compares numeric segments', () => {
    expect(compareVersions('0.8.2', '0.8.2')).toBe(0)
    expect(compareVersions('0.8.1', '0.8.2')).toBe(-1)
    expect(compareVersions('0.8.2', '0.8.1')).toBe(1)
    expect(compareVersions('0.9.0', '0.8.99')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
  })

  it('ignores leading v and prerelease / build metadata', () => {
    expect(compareVersions('v0.8.2', '0.8.2')).toBe(0)
    expect(compareVersions('0.8.2-alpha.1', '0.8.2')).toBe(0)
    expect(compareVersions('0.8.2+build.7', '0.8.2')).toBe(0)
    expect(compareVersions('0.8.2-rc.1', '0.8.2')).toBe(0)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('0.8', '0.8.0')).toBe(0)
    expect(compareVersions('1', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.1', '1')).toBe(1)
  })
})

describe('vsixDownloadUrl', () => {
  it('builds an open-vsx direct file url', () => {
    expect(vsixDownloadUrl('0.9.0')).toBe(
      'https://open-vsx.org/api/kuaizhongqiang.dsh-vscode/0.9.0/file/kuaizhongqiang.dsh-vscode-0.9.0.vsix',
    )
  })

  it('URL-encodes unusual version strings', () => {
    expect(vsixDownloadUrl('0.9.0+beta')).toContain('/0.9.0%2Bbeta/file/')
  })
})
