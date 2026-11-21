export interface NamedWorkspace { id: string; name: string }

/** Display names are labels, not paths. Normalize only for collision checks. */
function nameKey(name: string) {
  return name.trim().normalize('NFKC').toLowerCase()
}

export function workspaceNameError(raw: string, projects: readonly NamedWorkspace[], exceptId?: string) {
  const name = raw.trim()
  if (!name) return '请输入工作区名称。'
  if (/[\u0000-\u001f\u007f]/u.test(name)) return '工作区名称不能包含换行或控制字符。'
  if (Array.from(name).length > 80) return '工作区名称最多 80 个字符。'
  if (projects.some(p => p.id !== exceptId && nameKey(p.name) === nameKey(name))) return '已有同名工作区，请换一个名称或直接选择已有工作区。'
  return ''
}

export function nextPrintProjectName(projects: readonly { name: string }[]) {
  const taken = new Set(projects.map(p => nameKey(p.name)))
  for (let i = 1; ; i++) if (!taken.has(`打印任务 ${i}`)) return `打印任务 ${i}`
}
