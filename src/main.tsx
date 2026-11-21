import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './readerDesk.css'
import './interactionDesk.css'
import './bookEdition.css'

async function start() {
  if ('__TAURI_INTERNALS__' in window) {
    const { installTauriDesktop } = await import('./desktop/tauri')
    await installTauriDesktop()
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>,
  )
}

void start().catch((error) => {
  console.error('Desktop startup failed', error)
  const root = document.getElementById('root')!
  root.setAttribute('role', 'alert')
  root.textContent = '无法连接本地工作台，请关闭并重新打开应用。原始文档未被更改。'
})
