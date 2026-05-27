// Intercept PDFs served over HTTP/HTTPS via Content-Type header
chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    const isPDF = details.responseHeaders.some(
      h => h.name.toLowerCase() === 'content-type' &&
           h.value.toLowerCase().includes('application/pdf')
    );
    if (isPDF) {
      const viewerUrl = chrome.extension.getURL('viewer.html') +
                        '?file=' + encodeURIComponent(details.url);
      return { redirectUrl: viewerUrl };
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders', 'blocking']
);

// Intercept local file:// PDFs and web URLs ending in .pdf
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  const url = changeInfo.url || (tab && tab.url) || '';
  if (
    url.match(/\.pdf(\?.*)?$/i) &&
    !url.includes(chrome.extension.getURL(''))
  ) {
    const viewerUrl = chrome.extension.getURL('viewer.html') +
                      '?file=' + encodeURIComponent(url);
    chrome.tabs.update(tabId, { url: viewerUrl });
  }
});
