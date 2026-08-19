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

// A completed document with no feed is different from a still-loading page:
// it usually points to a session/bootstrap problem rather than a slow network.
export function classifyStartupFailure(state = {}) {
  const pageState = classifyPageState(state)
  if (pageState !== 'loading') return pageState
  if (String(state.readyState || '').toLowerCase() === 'complete' && Number(state.feedCount) === 0) {
    return 'stalled'
  }
  return 'loading'
}

export function hasFailedChats(results = []) {
  return Array.isArray(results) && results.some((result) => result && result.status !== 'ok')
}

export function isRetryableChatStatus(status) {
  return status === 'openfail' || status === 'applink'
}
