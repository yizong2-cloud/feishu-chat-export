// Pure startup-state classification so login failures can be tested without a browser.

export function classifyPageState({ url = '', title = '', feedCount = 0, feedStore = false, feedWindowStore = false } = {}) {
  const location = String(url || '')
  const pageTitle = String(title || '')
  if (/\/(?:accounts|passport|login|sign[-_]?in)(?:[/?#]|$)/i.test(location) || /登录|重新登录|验证码/.test(pageTitle)) {
    return 'login'
  }
  if (Number(feedCount) > 0 && feedStore && feedWindowStore) return 'ready'
  if (Number(feedCount) > 0) return 'incompatible'
  return 'loading'
}
