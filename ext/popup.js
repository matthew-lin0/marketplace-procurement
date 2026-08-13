const SINK = 'http://localhost:7331/snapshot';

// Matches the split assignment in src/schema. Dev categories are where prompts
// get iterated; holdout is never looked at until the final run.
const SPLITS = {
  home_gym: 'dev',
  bicycle: 'dev',
  power_tool: 'dev',
  monitor: 'dev',
  sofa: 'holdout',
  laptop: 'holdout',
  co2_incubator: 'holdout',
};

const statusEl = document.getElementById('status');

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || '';
}

document.getElementById('capture').addEventListener('click', async () => {
  const category = document.getElementById('category').value;
  const statedModel = document.getElementById('statedModel').value.trim();
  setStatus('Capturing...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });

    if (!result) throw new Error('Content script returned nothing');

    const payload = {
      ...result,
      category,
      split: SPLITS[category],
      statedModel: statedModel || null,
    };

    setStatus(`Sending ${result.images.length} image(s)...`);

    const res = await fetch(SINK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Sink returned ${res.status}: ${await res.text()}`);

    const body = await res.json();
    setStatus(
      `Saved ${body.id}\n${body.imagesSaved}/${body.imagesAttempted} images on disk` +
        (body.warnings?.length ? `\n\n${body.warnings.join('\n')}` : ''),
      'ok',
    );
  } catch (err) {
    setStatus(
      `${err.message}\n\nIs the sink running? Start it with:\n  npm run sink`,
      'err',
    );
  }
});
