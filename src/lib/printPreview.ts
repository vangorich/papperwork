/** Preserve surviving thumbnail identities and append newly queued pages. */
export function reconcilePrintPageOrder(order: readonly string[], keys: readonly string[]): string[] {
  const valid = new Set(keys)
  const kept = order.filter((key) => valid.delete(key))
  return [...kept, ...valid]
}

/** Apply preview order after source-page range/subset selection, before reverse and n-up. */
export function orderPrintPageIndices(
  selected: readonly number[],
  order: readonly number[] | undefined,
  pageCount: number,
): number[] {
  if (!order) return [...selected]
  if (order.length !== pageCount || new Set(order).size !== pageCount
    || order.some((index) => !Number.isInteger(index) || index < 0 || index >= pageCount)) {
    throw new Error('打印页面顺序已失效，请重新打开打印设置。')
  }
  const included = new Set(selected)
  return order.filter((index) => included.has(index))
}
