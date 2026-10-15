export const TRUSTED_OKX_EXTENSION_ID = 'mcohilncbfahbmgdjkbpemcciiolgcge';

// Accept flat CDP target descriptors ({type, url}); return the ORIGINAL array
// index, or -1 when no uniquely authoritative trusted target can be established.
// Notification pages outrank other pages; pages outrank non-page mirrors.
// Counts are intentional: never deduplicate by transaction amount/stage or ID.
export function selectAuthoritativeOkxTargetIndex(candidates) {
  if (!Array.isArray(candidates)) return -1;
  const trusted = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate || typeof candidate.url !== 'string') continue;
    let url;
    try {url = new URL(candidate.url);} catch {continue;}
    // URL.origin is "null" for extension URLs in Node, so compare its parsed
    // protocol and authority explicitly instead of using URL.origin.
    if (url.protocol !== 'chrome-extension:' || url.hostname !== TRUSTED_OKX_EXTENSION_ID
      || url.username || url.password || url.port) continue;
    trusted.push({index, isPage: candidate.type === 'page', isNotification: url.pathname === '/notification.html', isSidepanel: url.pathname === '/sidepanel.html' && ['page', 'other'].includes(candidate.type)});
  }
  const notifications = trusted.filter(candidate => candidate.isPage && candidate.isNotification);
  if (notifications.length) return notifications.length === 1 ? notifications[0].index : -1;
  const pages = trusted.filter(candidate => candidate.isPage);
  if (pages.length) return pages.length === 1 ? pages[0].index : -1;
  // Chromium exposes the side panel as `other`; its SES iframe is only a mirror.
  const sidepanels = trusted.filter(candidate => candidate.isSidepanel);
  if (sidepanels.length) return sidepanels.length === 1 ? sidepanels[0].index : -1;
  return trusted.length === 1 ? trusted[0].index : -1;
}
