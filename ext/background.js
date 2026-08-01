// The extension deliberately does almost nothing. Its entire job is
// snapshot -> localhost. All product logic lives in src/extractor so the eval
// exercises the same code an extension would eventually ship.
chrome.runtime.onInstalled.addListener(() => {
  console.log('Marketplace Eval Capture installed. Start the sink with: npm run sink');
});
