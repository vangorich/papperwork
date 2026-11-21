import { useContext, useRef, useState } from 'react'
import { AppMotion } from '../hooks/useAppMotion'
import { FilePlus2, FolderOpen, FolderPlus, Printer } from 'lucide-react'
import { FolioPlate } from './FolioPlate'
import { Button } from './ui'
import './documentDesk.css'

const desks = {
  editor: {
    title: '文档阅览台',
    description: '打开文档，在原页面上阅读、搜索和批注。',
    action: '打开文件',
    icon: FolderOpen,
  },
  merge: {
    title: '页面装订台',
    description: '将多份文档放在一起，调整页序，再合并导出。',
    action: '添加文件',
    icon: FolderPlus,
  },
  collector: {
    title: '整理打印清单',
    description: '添加待打印的文档，排好先后顺序，再统一输出。',
    action: '添加到清单',
    icon: Printer,
  },
} as const

export function DocumentDesk({
  mode,
  busy,
  printing,
  onOpen,
  onBlank,
}: {
  mode: keyof typeof desks
  busy: string
  printing: boolean
  onOpen: () => void
  onBlank: () => void
}) {
  const { title, description, action, icon: OpenIcon } = desks[mode],
    [dragging, setDragging] = useState(false),
    depth = useRef(0)
  const animate = useContext(AppMotion) && !busy && !dragging && !printing
  const end = () => {
    depth.current = 0
    setDragging(false)
  }
  return (
    <div
      className="document-desk"
      data-animated={animate || undefined}
      data-dragging={dragging || undefined}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files') && ++depth.current === 1) setDragging(true)
      }}
      onDragLeave={() => {
        if (--depth.current <= 0) end()
      }}
      onDrop={end}
      onDragEnd={end}
    >
      <div className="document-desk__sheet">
        <div className="document-desk__copy">
          <h1>{title}</h1>
          <p>
            {description}
            <br />
            也可以直接将文件拖入窗口。
          </p>
          <div className="document-desk__actions">
            <Button variant="primary" busy={Boolean(busy)} onClick={onOpen}>
              {!busy && <OpenIcon size={17} aria-hidden="true" />}
              {busy || action}
            </Button>
            <Button variant="ghost" disabled={Boolean(busy)} onClick={onBlank}>
              <FilePlus2 size={15} aria-hidden="true" />
              从空白页开始
            </Button>
          </div>
          <div className="document-desk__formats">
            <span>支持格式</span>
            <b>PDF</b>
            <b>OFD</b>
            {window.desktop?.parseOutlookMsg && <b>MSG</b>}
            <b>PNG</b>
            <b>JPEG</b>
          </div>
        </div>
        <FolioPlate enabled={animate} />
      </div>
      {dragging && (
        <div className="document-desk__drop" role="status">
          <FolderPlus size={22} />
          松开以添加文件
        </div>
      )}
    </div>
  )
}
