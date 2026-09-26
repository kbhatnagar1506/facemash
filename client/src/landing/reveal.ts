// The copy's line-by-line reveal: masked words rise on a critically damped spring,
// one visual line at a time, blocks in sequence. Line breaks are measured, not
// authored, so the stagger follows the rag at every width.

/** Give every word its reveal delay: one line index per visual line, blocks in sequence.
 *  Returns when the last line starts (ms). */
export function layoutLines(copy: HTMLElement) {
  const blocks = copy.querySelectorAll<HTMLElement>('.rv')
  let base = 80
  let end = 0
  blocks.forEach((b) => {
    let line = -1
    let top = -1e9
    b.querySelectorAll<HTMLElement>('.w').forEach((el) => {
      const t = el.offsetTop
      if (t - top > el.offsetHeight * 0.5) {
        line++
        top = t
      }
      const d = base + line * 65
      el.style.setProperty('--d', `${d}ms`)
      end = Math.max(end, d)
    })
    base = Math.min(650, base + (line + 1) * 65 + 90)
  })
  copy.style.setProperty('--end', `${end}ms`)
  return end
}

/** Play a section's reveal once. */
export function reveal(copy: HTMLElement) {
  if (copy.classList.contains('in')) return
  const end = layoutLines(copy)
  copy.classList.add('in')
  window.setTimeout(() => copy.classList.add('done'), end + 1100)
}
