export type RunStatus = 'QUEUED' | 'PLANNING' | 'EXECUTING' | 'WAITING_FOR_TOOL' | 'WAITING_FOR_HUMAN' | 'REVIEW' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'RETRYING' | 'BLOCKED'

export type ExecutionEvent = {
  type: 'status' | 'token' | 'tool' | 'result' | 'error'
  status?: RunStatus
  text?: string
  tool?: string
  timestamp: number
}

export type ExecutionRequest = {
  apiKey: string
  model: string
  system: string
  prompt: string
  context: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  onEvent?: (event: ExecutionEvent) => void
}

export type ExecutionResult = {
  output: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  model: string
  durationMs: number
  attempts: number
}

const transientStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const emit = (request: ExecutionRequest, event: Omit<ExecutionEvent, 'timestamp'>) => request.onEvent?.({ ...event, timestamp: Date.now() })
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { window.clearTimeout(timer); reject(new DOMException('Run canceled', 'AbortError')) }, { once: true })
})

export class OpenRouterProvider {
  async validate(apiKey: string, signal?: AbortSignal) {
    const response = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${apiKey}` }, signal })
    if (!response.ok) throw new Error(response.status === 401 ? 'The OpenRouter key is invalid.' : `OpenRouter validation failed (${response.status}).`)
    return true
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!request.apiKey.trim()) throw new Error('Connect an OpenRouter key before starting a run.')
    if (!request.model.trim()) throw new Error('Choose a model before starting a run.')
    const started = Date.now()
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        emit(request, { type: 'status', status: attempt === 1 ? 'PLANNING' : 'RETRYING', text: attempt === 1 ? 'Preparing authorized context' : `Retrying provider request (${attempt}/3)` })
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          signal: request.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.apiKey}`, 'HTTP-Referer': location.origin, 'X-Title': 'SELTERN' },
          body: JSON.stringify({ model: request.model, stream: true, temperature: request.temperature ?? .2, max_tokens: request.maxTokens ?? 1400, messages: [{ role: 'system', content: request.system }, { role: 'user', content: `${request.prompt}\n\nAUTHORIZED WORKSPACE CONTEXT:\n${request.context}` }] })
        })
        if (!response.ok) {
          const raw = await response.text()
          const message = (() => { try { return JSON.parse(raw).error?.message } catch { return undefined } })() || `OpenRouter request failed (${response.status})`
          if (!transientStatuses.has(response.status) || attempt === 3) throw new Error(message)
          lastError = new Error(message); await wait(500 * 2 ** (attempt - 1), request.signal); continue
        }
        if (!response.body) throw new Error('OpenRouter returned no stream.')
        emit(request, { type: 'status', status: 'EXECUTING', text: 'Agent is executing' })
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let output = ''; let usage: ExecutionResult['usage']
        while (true) {
          const { value, done } = await reader.read(); if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n'); buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim(); if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim(); if (payload === '[DONE]') continue
            try {
              const chunk = JSON.parse(payload); const delta = chunk.choices?.[0]?.delta?.content || ''
              if (delta) { output += delta; emit(request, { type: 'token', text: delta }) }
              if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens, totalTokens: chunk.usage.total_tokens }
            } catch { /* ignore incomplete provider frames */ }
          }
        }
        if (!output.trim()) throw new Error('The model returned an empty result.')
        emit(request, { type: 'status', status: 'REVIEW', text: 'Output is ready for human review' })
        return { output, usage, model: request.model, durationMs: Date.now() - started, attempts: attempt }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') { emit(request, { type: 'status', status: 'CANCELED', text: 'Run canceled by a collaborator' }); throw error }
        lastError = error
        if (attempt < 3) { emit(request, { type: 'error', text: error instanceof Error ? error.message : 'Provider error' }); await wait(500 * 2 ** (attempt - 1), request.signal) }
      }
    }
    emit(request, { type: 'status', status: 'FAILED', text: lastError instanceof Error ? lastError.message : 'Run failed' })
    throw lastError instanceof Error ? lastError : new Error('Run failed')
  }
}

export type LocalTool = { name: 'search_workspace' | 'read_task'; description: string; risk: 'read-only'; run: (input: Record<string, unknown>) => string }
export function createWorkspaceTools(tasks: Array<{ id: string; title: string; status: string; output?: string }>): LocalTool[] {
  return [
    { name: 'search_workspace', description: 'Search authorized task titles and outputs.', risk: 'read-only', run: ({ query }) => tasks.filter(t => `${t.title} ${t.output || ''}`.toLowerCase().includes(String(query || '').toLowerCase())).map(t => `${t.id}: ${t.title} [${t.status}]`).join('\n') || 'No matching authorized workspace records.' },
    { name: 'read_task', description: 'Read one authorized task record.', risk: 'read-only', run: ({ id }) => { const task = tasks.find(t => t.id === id); return task ? JSON.stringify(task) : 'Task not found in the authorized workspace.' } }
  ]
}
