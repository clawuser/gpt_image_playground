import type { AppSettings, ImageApiResponse, TaskParams } from '../types'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const BASE64_IMAGE_PREFIXES = ['data:image/', 'iVBOR', '/9j/', 'UklGR', 'R0lGOD', 'Qk']
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const RETRY_DELAYS_MS = [800, 1600]

export { normalizeBaseUrl } from './devProxy'

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function isLikelyImageUrl(value: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i.test(value)
}

function looksLikeJsonString(value: string): boolean {
  const trimmed = value.trim()
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  )
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('data:')) return trimmed
  return `data:${fallbackMime};base64,${trimmed.replace(/\s+/g, '')}`
}

function looksLikeBase64Image(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  if (BASE64_IMAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true
  }

  const compact = trimmed.replace(/\s+/g, '')
  return compact.length > 512 && /^[A-Za-z0-9+/]+=*$/.test(compact)
}

function maybeNormalizeImageString(value: string, fallbackMime: string): string | null {
  if (!value) return null
  if (value.startsWith('data:image/')) return value.trim()
  if (looksLikeBase64Image(value)) return normalizeBase64Image(value, fallbackMime)
  return null
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shouldRetryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return message === 'failed to fetch' || message.includes('networkerror') || message.includes('load failed')
}

function shouldRetryResponse(response: Response): boolean {
  return RETRYABLE_STATUS_CODES.has(response.status)
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    try {
      const response = await fetch(input, {
        ...init,
        signal,
      })

      if (!shouldRetryResponse(response) || attempt === RETRY_DELAYS_MS.length) {
        return response
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      lastError = error
      if (!shouldRetryError(error) || attempt === RETRY_DELAYS_MS.length) {
        throw error
      }
    }

    await sleep(RETRY_DELAYS_MS[attempt])
  }

  throw lastError instanceof Error ? lastError : new Error('请求失败')
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal: AbortSignal): Promise<string> {
  const response = await fetchWithRetry(
    url,
    {
      cache: 'no-store',
    },
    signal,
  )

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  return blobToDataUrl(await response.blob(), fallbackMime)
}

function parseLooseTextPayload(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null

  if (looksLikeJsonString(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      /* ignore */
    }
  }

  const sseEvents: unknown[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.+)$/)
    if (!match) continue

    const data = match[1].trim()
    if (!data || data === '[DONE]') continue

    try {
      sseEvents.push(JSON.parse(data))
    } catch {
      /* ignore */
    }
  }

  if (sseEvents.length === 1) return sseEvents[0]
  if (sseEvents.length > 1) return { output: sseEvents }

  return trimmed
}

async function readResponsePayload(response: Response, fallbackMime = 'image/png'): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  if (contentType.startsWith('image/')) {
    return {
      data: [{
        b64_json: (await blobToDataUrl(await response.blob(), fallbackMime)).split(',', 2)[1] || '',
      }],
    }
  }

  return parseLooseTextPayload(await response.text())
}

async function collectImagesFromPayload(payload: unknown, fallbackMime: string, signal: AbortSignal): Promise<string[]> {
  const dataUrls: string[] = []
  const remoteUrls: string[] = []
  const seenStrings = new Set<string>()
  const seenNodes = new WeakSet<object>()

  const pushImageString = (value: string) => {
    if (seenStrings.has(value)) return
    seenStrings.add(value)
    dataUrls.push(value)
  }

  const pushRemoteUrl = (value: string) => {
    if (seenStrings.has(value)) return
    seenStrings.add(value)
    remoteUrls.push(value)
  }

  const visit = (node: unknown, keyHint = ''): void => {
    if (typeof node === 'string') {
      const normalized = maybeNormalizeImageString(node, fallbackMime)
      if (normalized) {
        pushImageString(normalized)
        return
      }

      if (looksLikeJsonString(node)) {
        try {
          visit(JSON.parse(node), keyHint)
          return
        } catch {
          /* ignore */
        }
      }

      const lowerKey = keyHint.toLowerCase()
      if (
        isHttpUrl(node) &&
        (isLikelyImageUrl(node) || /(^|_)(url|imageurl|image_url|resulturl|result_url)$/.test(lowerKey) || lowerKey.includes('image'))
      ) {
        pushRemoteUrl(node)
      }
      return
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, keyHint)
      }
      return
    }

    if (!node || typeof node !== 'object') return
    if (seenNodes.has(node)) return
    seenNodes.add(node)

    for (const [key, value] of Object.entries(node)) {
      visit(value, key)
    }
  }

  visit(payload)

  for (const url of remoteUrls) {
    dataUrls.push(await fetchImageUrlAsDataUrl(url, fallbackMime, signal))
  }

  return dataUrls
}

function buildResponsesInput(prompt: string, inputImageDataUrls: string[]) {
  if (!inputImageDataUrls.length) {
    return [{ role: 'user', content: prompt.trim() }]
  }

  const editPrompt = `请根据以下要求，对我提供的这张图片进行编辑修改，直接生成修改后的新图片。要求：${prompt.trim() || '请基于原图进行自然、清晰的编辑。'}`

  const content: Array<Record<string, string>> = []

  for (const dataUrl of inputImageDataUrls) {
    content.push({
      type: 'input_image',
      image_url: dataUrl,
    })
  }

  content.push({
    type: 'input_text',
    text: editPrompt,
  })

  return [{ role: 'user', content }]
}

function buildResponsesBody(
  settings: AppSettings,
  prompt: string,
  params: TaskParams,
  inputImageDataUrls: string[],
): Record<string, unknown> {
  return {
    model: settings.model,
    input: buildResponsesInput(prompt, inputImageDataUrls),
    tools: [{
      type: 'image_generation',
      output_format: params.output_format,
      action: inputImageDataUrls.length ? 'auto' : 'generate',
    }],
    stream: false,
  }
}

function shouldFallbackResponsesEdit(response: Response): boolean {
  return response.status >= 500 || [400, 404, 405, 415, 422, 501].includes(response.status)
}

async function buildImageEditFormData(
  settings: AppSettings,
  prompt: string,
  params: TaskParams,
  inputImageDataUrls: string[],
): Promise<FormData> {
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

    if (i === 0) {
      formData.append('image', blob, `input-${i + 1}.${ext}`)
    }
    formData.append('image[]', blob, `input-${i + 1}.${ext}`)
  }

  return formData
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
    let responsePath: 'responses' | 'images' = 'images'

    if (settings.apiMode === 'responses_api') {
      responsePath = 'responses'
      response = await fetchWithRetry(
        buildApiUrl(settings.baseUrl, 'responses', proxyConfig),
        {
          method: 'POST',
          headers: {
            ...requestHeaders,
            Accept: 'application/json, text/event-stream, image/*',
            'Content-Type': 'application/json',
          },
          cache: 'no-store',
          body: JSON.stringify(buildResponsesBody(settings, prompt, params, inputImageDataUrls)),
        },
        controller.signal,
      )

      if (isEdit && !response.ok && shouldFallbackResponsesEdit(response)) {
        responsePath = 'images'
        notice = 'Responses API 图生图失败，已自动回落到 Images API。'
        const formData = await buildImageEditFormData(settings, prompt, params, inputImageDataUrls)
        response = await fetchWithRetry(
          buildApiUrl(settings.baseUrl, 'images/edits', proxyConfig),
          {
            method: 'POST',
            headers: requestHeaders,
            cache: 'no-store',
            body: formData,
          },
          controller.signal,
        )
      }
    } else if (isEdit) {
      const formData = await buildImageEditFormData(settings, prompt, params, inputImageDataUrls)
      response = await fetchWithRetry(
        buildApiUrl(settings.baseUrl, 'images/edits', proxyConfig),
        {
          method: 'POST',
          headers: requestHeaders,
          cache: 'no-store',
          body: formData,
        },
        controller.signal,
      )
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

      response = await fetchWithRetry(
        buildApiUrl(settings.baseUrl, 'images/generations', proxyConfig),
        {
          method: 'POST',
          headers: {
            ...requestHeaders,
            Accept: 'application/json, image/*',
            'Content-Type': 'application/json',
          },
          cache: 'no-store',
          body: JSON.stringify(body),
        },
        controller.signal,
      )
    }

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`
      try {
        const errPayload = await readResponsePayload(response, mime)
        if (errPayload && typeof errPayload === 'object') {
          const errJson = errPayload as {
            error?: { message?: string; type?: string; code?: string }
            message?: string
          }
          if (errJson.error?.message) errorMsg = errJson.error.message
          else if (errJson.message) errorMsg = errJson.message
          else errorMsg = JSON.stringify(errJson)

          if (errJson.error?.type || errJson.error?.code) {
            errorMsg += ` (${[errJson.error.type, errJson.error.code].filter(Boolean).join(' / ')})`
          }
        } else if (typeof errPayload === 'string' && errPayload.trim()) {
          errorMsg = errPayload
        }
      } catch {
        /* ignore */
      }
      throw new Error(errorMsg)
    }

    const payload = await readResponsePayload(response, mime)
    let images: string[] = []

    if (responsePath === 'responses') {
      images = await collectImagesFromPayload(payload, mime, controller.signal)
    } else {
      const data = (payload as ImageApiResponse | null)?.data
      if (Array.isArray(data) && data.length) {
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
        images = await collectImagesFromPayload(payload, mime, controller.signal)
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
