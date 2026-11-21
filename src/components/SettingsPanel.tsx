import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppMotion } from '../hooks/useAppMotion'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  CircleAlert,
  CloudCog,
  Eye,
  EyeOff,
  Gauge,
  Keyboard,
  KeyRound,
  Moon,
  Network,
  RotateCcw,
  ScanText,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  Type,
  UserRound,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import type { RenderQuality } from '../types/pdf'
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_ACTIONS,
  assignShortcutBinding,
  formatShortcut,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutBindings,
} from '../lib/shortcuts'

export interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  fontScale: number
  onFontScale: (scale: number) => void
  dark: boolean
  onDark: (dark: boolean) => void
  animations: boolean
  onAnimations: (enabled: boolean) => void
  renderQuality: RenderQuality
  onRenderQuality: (quality: RenderQuality) => void
  currentAuthor: string
  onCurrentAuthor: (author: string) => void
  shortcutBindings: ShortcutBindings
  onShortcutBindings: (bindings: ShortcutBindings) => void
  /** OCR preferences are optional so older hosts can adopt the panel incrementally. */
  ocrSettings?: OcrSettings
  onOcrSettings?: (settings: OcrSettings) => void
  ocrCapabilities?: OcrCapabilities
  ocrConnections?: Partial<Record<OcrProvider, OcrConnectionStatus>>
  onTestOcrConnection?: (provider: OcrProvider) => void | Promise<void>
  passwordHistory?: PdfPasswordHistoryEntry[]
  onRemovePasswordHistory?: (id: string) => void | Promise<void>
  onClearPasswordHistory?: () => void | Promise<void>
}

export type OcrProvider = 'local' | 'tencent' | 'custom'
export type OcrRoutingMode = 'automatic' | 'printed' | 'handwriting' | 'complex'

export interface OcrConnectionStatus {
  state: 'unchecked' | 'checking' | 'connected' | 'error'
  message?: string
}

export interface OcrSettings {
  routingMode: OcrRoutingMode
  preprocess: boolean
  handwritingProvider: OcrProvider
  lowConfidenceProvider: OcrProvider
  lowConfidenceThreshold: number
  contextualCorrection: boolean
  tencent: {
    secretId: string
    secretKey: string
    region: string
  }
  custom: {
    endpoint: string
    apiKey: string
  }
}

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  routingMode: 'automatic',
  preprocess: true,
  handwritingProvider: 'local',
  lowConfidenceProvider: 'local',
  lowConfidenceThreshold: 0.72,
  contextualCorrection: true,
  tencent: { secretId: '', secretKey: '', region: 'ap-guangzhou' },
  custom: { endpoint: '', apiKey: '' },
}

const FONT_PRESETS = [0.9, 1, 1.1, 1.2, 1.3] as const
const SHORTCUT_LABELS: Record<ShortcutAction, { label: string; description: string }> = {
  rotatePageLeft: { label: '当前页左转', description: '仅旋转正在查看的页面' },
  rotatePageRight: { label: '当前页右转', description: '仅旋转正在查看的页面' },
  rotateDocumentLeft: { label: '当前 PDF 左转', description: '旋转当前标签中的全部页面' },
  rotateDocumentRight: { label: '当前 PDF 右转', description: '旋转当前标签中的全部页面' },
  previousPage: { label: '上一页', description: '跳到当前 PDF 的上一页' },
  nextPage: { label: '下一页', description: '跳到当前 PDF 的下一页' },
  save: { label: '保存', description: '保存当前 PDF；按住 Shift 另存为' },
  search: { label: '搜索', description: '打开文档文字搜索' },
  zoomIn: { label: '放大', description: '提高页面缩放比例' },
  zoomOut: { label: '缩小', description: '降低页面缩放比例' },
  ocrCurrentPage: { label: 'OCR 当前页', description: '强制重建当前页文字层' },
}
const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 应用级常用设置。所有选项即时生效，持久化由调用方负责。
 */
export function SettingsPanel({
  open,
  onClose,
  fontScale,
  onFontScale,
  dark,
  onDark,
  animations,
  onAnimations,
  renderQuality,
  onRenderQuality,
  currentAuthor,
  onCurrentAuthor,
  shortcutBindings,
  onShortcutBindings,
  ocrSettings: controlledOcrSettings,
  onOcrSettings,
  ocrCapabilities,
  ocrConnections,
  onTestOcrConnection,
  passwordHistory = [],
  onRemovePasswordHistory,
  onClearPasswordHistory,
}: SettingsPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const motionEnabled = useContext(AppMotion)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    // Arm the entrance only on open; disabling motion disarms this opening for good.
    if (!wasOpen.current || !motionEnabled) {
      panelRef.current?.parentElement?.toggleAttribute('data-entering', open && motionEnabled)
    }
    wasOpen.current = open
  }, [open, motionEnabled])
  const [localOcrSettings, setLocalOcrSettings] = useState<OcrSettings>(DEFAULT_OCR_SETTINGS)
  const [revealedPasswords, setRevealedPasswords] = useState<Set<string>>(() => new Set())
  const [capturingShortcut, setCapturingShortcut] = useState<ShortcutAction>()
  const [shortcutError, setShortcutError] = useState('')
  const ocrSettings = controlledOcrSettings ?? localOcrSettings
  const windowsOcr = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const ocrModels = ocrCapabilities?.models ?? []
  const smallAvailable = ocrModels.find((model) => model.id === 'pp-ocr-v6-small')?.available === true
  const mediumAvailable = ocrModels.find((model) => model.id === 'pp-ocr-v6-medium')?.available === true
  const handwritingAvailable = ocrModels.find((model) => model.id === 'pp-ocr-v5-server-rec')?.available === true
  const vlBundled = ocrModels.find((model) => model.id === 'paddleocr-vl-1.6')?.available === true
  const vlEndpointIsLocal = isLoopbackEndpoint(ocrSettings.custom.endpoint)

  const updateOcrSettings = (patch: Partial<OcrSettings>) => {
    const next = { ...ocrSettings, ...patch }
    setLocalOcrSettings(next)
    onOcrSettings?.(next)
  }

  useEffect(() => {
    if (!open) return
    setRevealedPasswords(new Set())
    setCapturingShortcut(undefined)
    setShortcutError('')

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return

      const controls = Array.from(panelRef.current.querySelectorAll<HTMLElement>(focusableSelector))
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) {
        event.preventDefault()
        panelRef.current.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const fontPercent = Math.round(fontScale * 100)
  const restoreDefaults = () => {
    onFontScale(1.2)
    onDark(false)
    onAnimations(true)
    onRenderQuality('sharp')
    onCurrentAuthor('当前用户')
    onShortcutBindings({ ...DEFAULT_SHORTCUT_BINDINGS })
    updateOcrSettings(DEFAULT_OCR_SETTINGS)
  }

  return createPortal(
    <div
      className="settings-panel__backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        className="settings-panel__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        aria-describedby="settings-panel-description"
        tabIndex={-1}
      >
        <header className="settings-panel__header">
          <span className="settings-panel__header-icon" aria-hidden="true">
            <Settings2 size={19} />
          </span>
          <div className="settings-panel__heading">
            <span className="settings-panel__eyebrow">PREFERENCES</span>
            <h2 id="settings-panel-title">常用设置</h2>
            <p id="settings-panel-description">调整会立即应用，并在下次启动时保留。</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="settings-panel__close"
            aria-label="关闭设置"
            title="关闭设置 (Esc)"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="settings-panel__content">
          <section className="settings-panel__section" aria-labelledby="settings-font-title">
            <div className="settings-panel__section-heading">
              <span className="settings-panel__section-icon" aria-hidden="true"><Type size={17} /></span>
              <div>
                <h3 id="settings-font-title">界面字体大小</h3>
                <p>同时调整菜单、工具栏和面板文字。</p>
              </div>
              <output className="settings-panel__value" htmlFor="settings-font-scale">{fontPercent}%</output>
            </div>
            <input
              id="settings-font-scale"
              className="settings-panel__slider"
              type="range"
              min="0.9"
              max="1.3"
              step="0.05"
              value={fontScale}
              aria-label={`界面字体大小 ${fontPercent}%`}
              onChange={(event) => onFontScale(Number(event.currentTarget.value))}
            />
            <div className="settings-panel__presets" aria-label="字体大小预设">
              {FONT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="settings-panel__preset"
                  data-active={Math.abs(fontScale - preset) < 0.01 || undefined}
                  aria-pressed={Math.abs(fontScale - preset) < 0.01}
                  onClick={() => onFontScale(preset)}
                >
                  {Math.round(preset * 100)}%
                </button>
              ))}
            </div>
          </section>

          <fieldset className="settings-panel__section">
            <legend className="settings-panel__legend">外观主题</legend>
            <div className="settings-panel__segments" role="group" aria-label="外观主题">
              <button
                type="button"
                className="settings-panel__segment"
                data-active={!dark || undefined}
                aria-pressed={!dark}
                onClick={() => onDark(false)}
              >
                <Sun size={16} aria-hidden="true" />
                亮色
                {!dark && <Check className="settings-panel__check" size={14} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="settings-panel__segment"
                data-active={dark || undefined}
                aria-pressed={dark}
                onClick={() => onDark(true)}
              >
                <Moon size={16} aria-hidden="true" />
                暗色
                {dark && <Check className="settings-panel__check" size={14} aria-hidden="true" />}
              </button>
            </div>
          </fieldset>

          <label className="settings-panel__section settings-panel__motion">
            <span>
              <strong id="settings-motion-title">界面动画</strong>
              <small id="settings-motion-description">显示书页起伏、书签展开等动效，不跟随 Windows 动画设置。</small>
            </span>
            <input type="checkbox" role="switch" checked={animations}
              aria-labelledby="settings-motion-title" aria-describedby="settings-motion-description"
              onChange={event => onAnimations(event.currentTarget.checked)} />
          </label>

          <fieldset className="settings-panel__section">
            <legend className="settings-panel__legend">PDF 显示质量</legend>
            <div className="settings-panel__quality-options">
              <button
                type="button"
                className="settings-panel__quality"
                data-active={renderQuality === 'sharp' || undefined}
                aria-pressed={renderQuality === 'sharp'}
                onClick={() => onRenderQuality('sharp')}
              >
                <span className="settings-panel__quality-icon"><Eye size={17} /></span>
                <span><strong>高清显示</strong><small>文字与线条更锐利，适合精细阅读</small></span>
                {renderQuality === 'sharp' && <Check className="settings-panel__check" size={15} />}
              </button>
              <button
                type="button"
                className="settings-panel__quality"
                data-active={renderQuality === 'smooth' || undefined}
                aria-pressed={renderQuality === 'smooth'}
                onClick={() => onRenderQuality('smooth')}
              >
                <span className="settings-panel__quality-icon"><Gauge size={17} /></span>
                <span><strong>流畅显示</strong><small>降低资源占用，适合大文件与分屏</small></span>
                {renderQuality === 'smooth' && <Check className="settings-panel__check" size={15} />}
              </button>
            </div>
          </fieldset>

          <section className="settings-panel__section" aria-labelledby="settings-author-title">
            <label className="settings-panel__field" htmlFor="settings-author">
              <span className="settings-panel__field-icon" aria-hidden="true"><UserRound size={16} /></span>
              <span>
                <strong id="settings-author-title">备注署名</strong>
                <small>用于新建备注与回复，不会修改已有备注。</small>
              </span>
            </label>
            <input
              id="settings-author"
              className="settings-panel__input"
              type="text"
              value={currentAuthor}
              maxLength={80}
              autoComplete="name"
              placeholder="当前用户"
              onChange={(event) => onCurrentAuthor(event.currentTarget.value)}
              onBlur={(event) => {
                if (!event.currentTarget.value.trim()) onCurrentAuthor('当前用户')
              }}
            />
          </section>

          <details className="settings-panel__section settings-panel__shortcuts">
            <summary className="settings-panel__ocr-summary">
              <span className="settings-panel__section-icon" aria-hidden="true"><Keyboard size={17} /></span>
              <span>
                <strong>快捷键</strong>
                <small>单击快捷键后直接按下新的组合键</small>
              </span>
              <ChevronDown className="settings-panel__ocr-chevron" size={16} aria-hidden="true" />
            </summary>
            <div className="settings-panel__shortcut-list">
              {SHORTCUT_ACTIONS.map((action) => {
                const binding = shortcutBindings[action]
                const capturing = capturingShortcut === action
                return (
                  <div className="settings-panel__shortcut-row" key={action}>
                    <span>
                      <strong>{SHORTCUT_LABELS[action].label}</strong>
                      <small>{SHORTCUT_LABELS[action].description}</small>
                    </span>
                    <button
                      type="button"
                      className="settings-panel__shortcut-capture"
                      data-capturing={capturing || undefined}
                      aria-label={`设置${SHORTCUT_LABELS[action].label}快捷键，当前为${formatShortcut(binding)}`}
                      onClick={() => {
                        setShortcutError('')
                        setCapturingShortcut(action)
                      }}
                      onBlur={() => setCapturingShortcut((current) => current === action ? undefined : current)}
                      onKeyDown={(event) => {
                        if (!capturing) return
                        event.preventDefault()
                        event.stopPropagation()
                        if (event.key === 'Escape') {
                          setCapturingShortcut(undefined)
                          return
                        }
                        if (event.key === 'Backspace' || event.key === 'Delete') {
                          const assignment = assignShortcutBinding(shortcutBindings, action, '')
                          onShortcutBindings(assignment.bindings)
                          setShortcutError('')
                          setCapturingShortcut(undefined)
                          return
                        }
                        const nextBinding = shortcutFromEvent(event.nativeEvent)
                        if (!nextBinding) return
                        const assignment = assignShortcutBinding(shortcutBindings, action, nextBinding)
                        if (assignment.error) {
                          setShortcutError(assignment.error)
                          setCapturingShortcut(undefined)
                          return
                        }
                        onShortcutBindings(assignment.bindings)
                        setShortcutError('')
                        setCapturingShortcut(undefined)
                      }}
                    >{capturing ? '请按组合键…' : formatShortcut(binding)}</button>
                  </div>
                )
              })}
              {shortcutError && (
                <p className="settings-panel__shortcut-error" role="alert">
                  <CircleAlert size={14} />
                  {shortcutError}
                </p>
              )}
              <button
                type="button"
                className="settings-panel__shortcut-reset"
                onClick={() => {
                  setShortcutError('')
                  onShortcutBindings({ ...DEFAULT_SHORTCUT_BINDINGS })
                }}
              ><RotateCcw size={14} />恢复默认快捷键</button>
            </div>
          </details>

          <details id="pdf-password-history" className="settings-panel__section settings-panel__passwords">
            <summary className="settings-panel__ocr-summary">
              <span className="settings-panel__section-icon" aria-hidden="true"><KeyRound size={17} /></span>
              <span>
                <strong>PDF 密码历史</strong>
                <small>{passwordHistory.length ? `${passwordHistory.length} 个安全存储的密码` : '暂无记录'}</small>
              </span>
              <ChevronDown className="settings-panel__ocr-chevron" size={16} aria-hidden="true" />
            </summary>
            <div className="settings-panel__password-list">
              {passwordHistory.length ? passwordHistory.map((entry) => {
                const revealed = revealedPasswords.has(entry.id)
                const lastUsed = new Date(entry.lastUsedAt)
                return (
                  <article key={entry.id} className="settings-panel__password-entry">
                    <div>
                      <strong title={entry.documents.join('、')}>{entry.documents[0] || '加密 PDF'}</strong>
                      <small>{Number.isNaN(lastUsed.getTime()) ? '' : lastUsed.toLocaleString()}</small>
                    </div>
                    <span className="settings-panel__password-value" aria-label={revealed ? '已显示密码' : '密码已隐藏'}>
                      {revealed ? entry.password : '•'.repeat(Math.max(8, Math.min(16, entry.password.length)))}
                    </span>
                    <button
                      type="button"
                      aria-label={revealed ? '隐藏密码' : '显示密码'}
                      title={revealed ? '隐藏密码' : '显示密码'}
                      onClick={() => setRevealedPasswords((current) => {
                        const next = new Set(current)
                        if (next.has(entry.id)) next.delete(entry.id)
                        else next.add(entry.id)
                        return next
                      })}
                    >{revealed ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                    <button
                      type="button"
                      aria-label={`删除 ${entry.documents[0] || 'PDF'} 的密码记录`}
                      title="删除记录"
                      onClick={() => void onRemovePasswordHistory?.(entry.id)}
                    ><Trash2 size={15} /></button>
                  </article>
                )
              }) : <p className="settings-panel__password-empty">成功打开加密 PDF 后会自动记录。</p>}
              {passwordHistory.length > 0 && (
                <button type="button" className="settings-panel__password-clear" onClick={() => void onClearPasswordHistory?.()}>
                  <Trash2 size={14} />清空全部
                </button>
              )}
            </div>
          </details>

          <details className="settings-panel__section settings-panel__ocr">
            <summary className="settings-panel__ocr-summary">
              <span className="settings-panel__section-icon" aria-hidden="true"><ScanText size={17} /></span>
              <span>
                <strong>OCR 识别方案</strong>
                <small>{windowsOcr ? '使用本机 Windows 语言包，文档不离开设备' : '按已安装模型自动分流 · 低置信度复核'}</small>
              </span>
              <span className="settings-panel__ocr-status" data-state={ocrConnections?.local?.state ?? 'unchecked'}>
                {(ocrConnections?.local?.state === 'connected') ? <Wifi size={13} /> : <WifiOff size={13} />}
                {ocrConnections?.local?.state === 'connected' ? '本地可用' : '查看配置'}
              </span>
              <ChevronDown className="settings-panel__ocr-chevron" size={16} aria-hidden="true" />
            </summary>

            <div className="settings-panel__ocr-body">
              {windowsOcr ? <>
                <ModelRouteCard role="本地印刷体识别" model="Windows OCR"
                  state={!ocrCapabilities ? 'checking' : ocrCapabilities.languages.length ? 'installed' : 'missing'}
                  detail={ocrCapabilities?.languages.length ? `已安装语言：${ocrCapabilities.languages.join('、')}` : '请在 Windows 设置 → 语言和区域安装相应语言的光学字符识别组件。'} />
                <p>支持印刷文字、可选文字层和复制；本版本不调用云服务，也不提供专用手写或公式模型。</p>
                <button type="button" className="settings-panel__ocr-test" disabled={!onTestOcrConnection || ocrConnections?.local?.state === 'checking'} onClick={() => void onTestOcrConnection?.('local')}><Network size={14} />检测系统 OCR</button>
              </> : <>
              <div className="settings-panel__ocr-pipeline" aria-label="OCR 模型安装与路由状态">
                <ModelRouteCard
                  role="普通印刷体"
                  model="PP-OCRv6 Medium"
                  state={!ocrCapabilities ? 'checking' : mediumAvailable ? 'installed' : smallAvailable ? 'fallback' : 'missing'}
                  detail={mediumAvailable ? '模型已安装' : smallAvailable ? '使用内置 Small 兼容回退' : '未找到可用本地模型'}
                />
                <ModelRouteCard
                  role="手写体"
                  model="PP-OCRv5 Server Rec"
                  state={!ocrCapabilities ? 'checking' : handwritingAvailable ? 'installed' : smallAvailable ? 'fallback' : 'missing'}
                  detail={handwritingAvailable ? '模型已安装' : smallAvailable ? '使用内置 Small 兼容回退' : '可改用腾讯或自定义端口'}
                />
                <ModelRouteCard
                  role="表格 / 公式 / 多栏"
                  model="PaddleOCR-VL 1.6"
                  state={!ocrCapabilities ? 'checking' : vlBundled ? 'installed' : vlEndpointIsLocal ? 'endpoint' : 'endpoint-required'}
                  detail={vlBundled ? '模型已安装' : vlEndpointIsLocal ? '已配置 localhost 本地端点' : '需配置 localhost 本地端点'}
                />
              </div>

              <button type="button" className="settings-panel__ocr-test settings-panel__ocr-test--local" disabled={!onTestOcrConnection || ocrConnections?.local?.state === 'checking'} onClick={() => void onTestOcrConnection?.('local')}>
                <Network size={14} />重新检测本地模型
              </button>

              <fieldset className="settings-panel__ocr-group">
                <legend>文档路由</legend>
                <div className="settings-panel__ocr-routing">
                  {([
                    ['automatic', '自动判断', '按文档类型选择模型'],
                    ['printed', '印刷体', '优先使用 v6 medium'],
                    ['handwriting', '手写体', '优先使用 v5 server'],
                    ['complex', '复杂文档', '需要 VL 本地端点'],
                  ] as const).map(([value, title, description]) => (
                    <button
                      key={value}
                      type="button"
                      className="settings-panel__ocr-route"
                      data-active={ocrSettings.routingMode === value || undefined}
                      aria-pressed={ocrSettings.routingMode === value}
                      onClick={() => updateOcrSettings({ routingMode: value })}
                    >
                      <strong>{title}</strong><small>{description}</small>
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="settings-panel__ocr-toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={ocrSettings.preprocess}
                    onChange={(event) => updateOcrSettings({ preprocess: event.currentTarget.checked })}
                  />
                  <span><strong>生产级图像预处理</strong><small>方向检测、透视矫正、去阴影、裁边与清晰化</small></span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={ocrSettings.contextualCorrection}
                    onChange={(event) => updateOcrSettings({ contextualCorrection: event.currentTarget.checked })}
                  />
                  <span><strong>局部上下文纠错</strong><small>仅判断低置信度字符及候选字，不改写完整 OCR 文本</small></span>
                </label>
              </div>

              <div className="settings-panel__ocr-grid">
                <label className="settings-panel__ocr-control">
                  <span>手写识别引擎</span>
                  <select
                    value={ocrSettings.handwritingProvider}
                    onChange={(event) => updateOcrSettings({ handwritingProvider: event.currentTarget.value as OcrProvider })}
                  >
                    <option value="local">{handwritingAvailable ? '本地 PP-OCRv5 Server Rec（已安装）' : smallAvailable ? '本地 PP-OCRv6 Small（兼容回退）' : '本地模型（当前不可用）'}</option>
                    <option value="tencent">腾讯云手写 OCR</option>
                    <option value="custom">自定义兼容端口</option>
                  </select>
                </label>
                <label className="settings-panel__ocr-control">
                  <span>低置信度第二引擎</span>
                  <select
                    value={ocrSettings.lowConfidenceProvider}
                    onChange={(event) => updateOcrSettings({ lowConfidenceProvider: event.currentTarget.value as OcrProvider })}
                  >
                    <option value="local">本地备用模型</option>
                    <option value="tencent">腾讯云 OCR</option>
                    <option value="custom">自定义兼容端口</option>
                  </select>
                </label>
              </div>

              <label className="settings-panel__ocr-threshold">
                <span><strong>人工复核阈值</strong><output>{Math.round(ocrSettings.lowConfidenceThreshold * 100)}%</output></span>
                <input
                  type="range"
                  min="0.5"
                  max="0.95"
                  step="0.01"
                  value={ocrSettings.lowConfidenceThreshold}
                  onChange={(event) => updateOcrSettings({ lowConfidenceThreshold: Number(event.currentTarget.value) })}
                />
                <small>低于此置信度的字符会保留原文、候选字和置信度，并进入人工复核。</small>
              </label>

              {(ocrSettings.handwritingProvider === 'tencent' || ocrSettings.lowConfidenceProvider === 'tencent') && (
                <section className="settings-panel__ocr-provider" aria-labelledby="settings-ocr-tencent">
                  <div className="settings-panel__ocr-provider-heading">
                    <span><CloudCog size={16} /></span>
                    <div><strong id="settings-ocr-tencent">腾讯云 OCR</strong><small>凭据仅保存于本机安全存储，不写入 PDF。</small></div>
                    <ConnectionBadge status={ocrConnections?.tencent} />
                  </div>
                  <div className="settings-panel__ocr-fields settings-panel__ocr-fields--three">
                    <label>SecretId<input type="text" autoComplete="off" value={ocrSettings.tencent.secretId} onChange={(event) => updateOcrSettings({ tencent: { ...ocrSettings.tencent, secretId: event.currentTarget.value } })} /></label>
                    <label>SecretKey<input type="password" autoComplete="new-password" value={ocrSettings.tencent.secretKey} onChange={(event) => updateOcrSettings({ tencent: { ...ocrSettings.tencent, secretKey: event.currentTarget.value } })} /></label>
                    <label>地域<select value={ocrSettings.tencent.region} onChange={(event) => updateOcrSettings({ tencent: { ...ocrSettings.tencent, region: event.currentTarget.value } })}><option value="ap-guangzhou">广州</option><option value="ap-shanghai">上海</option><option value="ap-beijing">北京</option></select></label>
                  </div>
                  <button type="button" className="settings-panel__ocr-test" disabled={!onTestOcrConnection || ocrConnections?.tencent?.state === 'checking'} onClick={() => void onTestOcrConnection?.('tencent')}><Network size={14} />测试腾讯云连接</button>
                </section>
              )}

              {(ocrSettings.handwritingProvider === 'custom' || ocrSettings.lowConfidenceProvider === 'custom' || ocrSettings.routingMode === 'automatic' || ocrSettings.routingMode === 'complex') && (
                <section className="settings-panel__ocr-provider" aria-labelledby="settings-ocr-custom">
                  <div className="settings-panel__ocr-provider-heading">
                    <span><KeyRound size={16} /></span>
                    <div><strong id="settings-ocr-custom">PaddleOCR-VL / 自定义 OCR 端口</strong><small>localhost 可连接本机 PaddleOCR-VL 1.6 服务；远程地址必须使用 HTTPS。</small></div>
                    <ConnectionBadge status={ocrConnections?.custom} />
                  </div>
                  <div className="settings-panel__ocr-fields">
                    <label>服务地址<input type="url" inputMode="url" placeholder="http://127.0.0.1:8000/v1/ocr" value={ocrSettings.custom.endpoint} onChange={(event) => updateOcrSettings({ custom: { ...ocrSettings.custom, endpoint: event.currentTarget.value } })} /></label>
                    <label>API Key<input type="password" autoComplete="new-password" value={ocrSettings.custom.apiKey} onChange={(event) => updateOcrSettings({ custom: { ...ocrSettings.custom, apiKey: event.currentTarget.value } })} /></label>
                  </div>
                  <button type="button" className="settings-panel__ocr-test" disabled={!onTestOcrConnection || ocrConnections?.custom?.state === 'checking'} onClick={() => void onTestOcrConnection?.('custom')}><Network size={14} />测试自定义端口</button>
                </section>
              )}

              <div className="settings-panel__ocr-safety">
                <ShieldCheck size={16} aria-hidden="true" />
                <p><strong>结果可追溯</strong><small>始终保留原始结果、纠错结果与置信度。启用云端时，仅发送待识别页面或低置信度局部内容。</small></p>
              </div>
              </>}
            </div>
          </details>
        </div>

        <footer className="settings-panel__footer">
          <button type="button" className="settings-panel__reset" onClick={restoreDefaults}>
            <RotateCcw size={15} aria-hidden="true" />
            恢复默认设置
          </button>
          <button type="button" className="settings-panel__done" onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

function ConnectionBadge({ status }: { status?: OcrConnectionStatus }) {
  const state = status?.state ?? 'unchecked'
  const copy = state === 'connected' ? '已连接' : state === 'checking' ? '检测中' : state === 'error' ? '连接失败' : '未检测'
  return (
    <span className="settings-panel__connection" data-state={state} title={status?.message}>
      {state === 'connected' ? <Wifi size={12} /> : state === 'error' ? <CircleAlert size={12} /> : <WifiOff size={12} />}
      {copy}
    </span>
  )
}

type ModelRouteState = 'checking' | 'installed' | 'fallback' | 'endpoint' | 'endpoint-required' | 'missing'

function ModelRouteCard({ role, model, state, detail }: {
  role: string
  model: string
  state: ModelRouteState
  detail: string
}) {
  const stateCopy: Record<ModelRouteState, string> = {
    checking: '检测中',
    installed: '已安装',
    fallback: '兼容回退',
    endpoint: '本地端点',
    'endpoint-required': '需配置端点',
    missing: '不可用',
  }
  return (
    <div data-state={state}>
      <span>{role}</span>
      <strong title={model}>{model}</strong>
      <small><i aria-hidden="true" />{stateCopy[state]} · {detail}</small>
    </div>
  )
}

function isLoopbackEndpoint(value: string) {
  try {
    const hostname = new URL(value.trim()).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}
