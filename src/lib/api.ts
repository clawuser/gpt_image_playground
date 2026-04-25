import type { AppSettings, ImageApiResponse, TaskParams } from '../types'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export { normalizeBaseUrl } from './devProxy'

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  return blobToDataUrl(await response.blob(), fallbackMime)
}

function collectResponseApiImages(payload: unknown, fallbackMime: string): string[] {
  const output =
    payload && typeof payload === 'object' && Array.isArray((payload as { output?: unknown[] }).output)
      ? (payload as { output: unknown[] }).output
      : []

  const images: string[] = []

  for (const item of output) {
    if (!item || typeof item !== 'object') continue

    const record = item as {
      type?: unknown
      result?: unknown
      image_base64?: unknown
      content?: unknown
    }

    if (record.type === 'image_generation_call') {
      if (typeof record.result === 'string' && record.result) {
        images.push(normalizeBase64Image(record.result, fallbackMime))
      } else if (Array.isArray(record.result)) {
        for (const entry of record.result) {
          if (typeof entry === 'string' && entry) {
            images.push(normalizeBase64Image(entry, fallbackMime))
          }
        }
      }

      if (typeof record.image_base64 === 'string' && record.image_base64) {
        images.push(normalizeBase64Image(record.image_base64, fallbackMime))
      }
    }

    if (Array.isArray(record.content)) {
      for (const contentItem of record.content) {
        if (!contentItem || typeof contentItem !== 'object') continue
        const contentRecord = contentItem as {
          type?: unknown
          image_base64?: unknown
          result?: unknown
        }

        if (contentRecord.type === 'output_image' && typeof contentRecord.image_base64 === 'string') {
          images.push(normalizeBase64Image(contentRecord.image_base64, fallbackMime))
        }
        if (contentRecord.type === 'image_generation_call' && typeof contentRecord.result === 'string') {
          images.push(normalizeBase64Image(contentRecord.result, fallbackMime))
        }
      }
    }
  }

  return images
}

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
  notice?: string
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = {
    Authorization: `Bearer ${settings.apiKey}`,
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    let response: Response
    let notice: string | undefined

    if (settings.apiMode === 'responses_api' && !isEdit) {
      response = await fetch(buildApiUrl(settings.baseUrl, 'responses', proxyConfig), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify({
          model: settings.model,
          input: prompt,
          tools: [{ type: 'image_generation' }],
        }),
        signal: controller.signal,
      })
    } else if (isEdit) {
      if (settings.apiMode === 'responses_api') {
        notice = '当前是 Responses API 模式；参考图编辑已自动回落到 Images API。'
      }

      const formData = new FormData()
      formData.append('model', settings.model)
      formData.append('prompt', prompt)
      formData.append('size', params.size)
      formData.append('quality', params.quality)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }

      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const resp = await fetch(dataUrl)
        const blob = await resp.blob()
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      response = await fetch(buildApiUrl(settings.baseUrl, 'images/edits', proxyConfig), {
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      })
    } else {
      const body: Record<string, unknown> = {
        model: settings.model,
        prompt,
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        body.output_compression = params.output_compression
      }
      if (params.n > 1) {
        body.n = params.n
      }

      response = await fetch(buildApiUrl(settings.baseUrl, 'images/generations', proxyConfig), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`
      try {
        const errJson = await response.json() as {
          error?: { message?: string }
          message?: string
        }
        if (errJson.error?.message) errorMsg = errJson.error.message
        else if (errJson.message) errorMsg = errJson.message
      } catch {
        try {
          errorMsg = await response.text()
        } catch {
          /* ignore */
        }
      }
      throw new Error(errorMsg)
    }

    const payload = await response.json()
    let images: string[] = []

    if (settings.apiMode === 'responses_api' && !isEdit) {
      images = collectResponseApiImages(payload, mime)
    } else {
      const data = (payload as ImageApiResponse).data
      if (!Array.isArray(data) || !data.length) {
        throw new Error('接口未返回图片数据')
      }

      for (const item of data) {
        const b64 = item.b64_json
        if (b64) {
          images.push(normalizeBase64Image(b64, mime))
          continue
        }

        if (isHttpUrl(item.url)) {
          images.push(await fetchImageUrlAsDataUrl(item.url, mime, controller.signal))
        }
      }
    }

    if (!images.length) {
      throw new Error('接口未返回可用图片数据')
    }

    return { images, notice }
  } finally {
    clearTimeout(timeoutId)
  }
}
