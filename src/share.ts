import type { ModelPreference } from './types'

export interface SharedProject {
  code: string
  input: string
  model: ModelPreference
}

export function shareUrl(project: SharedProject, base: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(project))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const url = `${base.split('#')[0].split('?')[0]}#share=${payload}`
  if (url.length > 12_000) throw new Error('代码或输入过长，无法生成可靠的分享链接。')
  return url
}

export function readShareHash(hash: string): SharedProject | null {
  if (!hash.startsWith('#share=')) return null
  try {
    const data = hash.slice(7)
    if (!data || data.length > 16_000 || !/^[A-Za-z0-9_-]+$/.test(data)) return null
    const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.code !== 'string' || typeof record.input !== 'string' ||
      record.code.length > 30_000 || record.input.length > 20_000 ||
      !['auto', 'array', 'dp', 'segment-tree', 'graph'].includes(String(record.model))) return null
    return { code: record.code, input: record.input, model: record.model as ModelPreference }
  } catch { return null }
}
