/**
 * Injects a one-click "analyze specs" button on matching listing pages.
 * Test feature, hardcoded to the monitor category — see manifest.json for
 * which URLs this loads on. Auto-injected (so the button appears without
 * opening the popup), but the actual model call only fires on click; nothing
 * here runs automatically or costs anything just from visiting a page.
 *
 * Reuses content.js's capture() via window.__captureListing — loaded first
 * in the same isolated world, see manifest.json content_scripts order.
 */

(function () {
  if (window.__marketplaceOverlayInjected) return;
  window.__marketplaceOverlayInjected = true;

  const ANALYZE_URL = 'http://localhost:7331/analyze';

  const btn = document.createElement('button');
  btn.textContent = '🔍 Analyze specs';
  btn.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
    'padding:10px 16px', 'background:#1877f2', 'color:#fff', 'border:none',
    'border-radius:8px', 'font:600 14px system-ui,sans-serif', 'cursor:pointer',
    'box-shadow:0 2px 10px rgba(0,0,0,.35)',
  ].join(';');
  document.documentElement.appendChild(btn);

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'bottom:70px', 'right:20px', 'z-index:2147483647',
    'width:380px', 'max-height:70vh', 'overflow:auto', 'background:#fff',
    'color:#111', 'border-radius:10px', 'box-shadow:0 6px 20px rgba(0,0,0,.35)',
    'padding:16px', 'font:13px/1.5 system-ui,sans-serif', 'display:none',
    'white-space:pre-wrap',
  ].join(';');
  document.documentElement.appendChild(panel);

  function showPanel(text) {
    panel.textContent = text;
    panel.style.display = 'block';
  }

  // "refresh_rate_hz" -> "Refresh rate". Strips a trailing unit token (it's
  // already implied by the value shown right next to it) and turns
  // snake_case into a normal-looking label.
  function formatKey(key) {
    const words = key.replace(/_(hz|ms|usd)$/i, '').split('_');
    return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  }

  // The taxonomy's mattersBecause is written to be thorough, not compact —
  // several sentences explaining the full reasoning. The overlay only has
  // room for the headline; showing all of it read as dense wall-of-text.
  function firstSentence(text) {
    const m = /^.*?[.!?](?=\s|$)/.exec(text.trim());
    return m ? m[0] : text;
  }

  function renderResult(data) {
    panel.innerHTML = '';
    panel.style.whiteSpace = 'normal';

    const id = data.identify;
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;margin-bottom:8px;font-size:14px;';
    title.textContent = id && !id.abstained
      ? `${id.brand ?? '?'} ${id.model ?? '?'}`
      : `Couldn't confidently identify this (${id?.family ?? 'not enough visible/stated detail'})`;
    panel.appendChild(title);

    if (data.discountFromNewPct !== null && data.discountFromNewPct !== undefined) {
      const badge = document.createElement('div');
      const isDiscount = data.discountFromNewPct > 0;
      badge.style.cssText = `font-weight:700;margin-bottom:10px;padding:6px 10px;border-radius:6px;background:${isDiscount ? '#e6f4ea' : '#fce8e6'};color:${isDiscount ? '#137333' : '#c5221f'};`;
      badge.textContent = isDiscount
        ? `🏷️ ${data.discountFromNewPct}% below current new price (~$${data.newPriceUsd})`
        : `⚠️ Asking price is ${Math.abs(data.discountFromNewPct)}% ABOVE current new price (~$${data.newPriceUsd})`;
      panel.appendChild(badge);
    }

    const candidates = data.candidates ?? [];
    if (id?.abstained && candidates.length > 0) {
      const note = document.createElement('div');
      note.style.cssText = 'color:#666;margin-bottom:6px;';
      note.textContent = 'Not confident enough to commit to one, but possibly:';
      panel.appendChild(note);

      const clist = document.createElement('ul');
      clist.style.cssText = 'margin:0 0 12px;padding-left:18px;';
      for (const c of candidates) {
        const li = document.createElement('li');
        li.style.marginBottom = '6px';
        const strong = document.createElement('strong');
        strong.textContent = `${c.brand} ${c.model} `;
        li.appendChild(strong);
        li.appendChild(document.createTextNode(`(${Math.round(c.confidence * 100)}% conf.)`));
        const reasoning = document.createElement('div');
        reasoning.style.cssText = 'color:#666;font-size:12px;margin-top:2px;';
        reasoning.textContent = c.reasoning;
        li.appendChild(reasoning);
        clist.appendChild(li);
      }
      panel.appendChild(clist);
    }

    const attrs = data.attributes ?? [];
    if (attrs.length === 0) {
      const none = document.createElement('div');
      none.style.color = '#666';
      none.textContent = candidates.length > 0
        ? 'No specs recovered for any candidate — none confident enough to look up.'
        : 'No specs recovered — try again with more listing text, or this may not be a monitor listing.';
      panel.appendChild(none);
      return;
    }

    const list = document.createElement('ul');
    list.style.cssText = 'margin:0;padding-left:18px;list-style:none;';
    for (const a of attrs) {
      const li = document.createElement('li');
      li.style.cssText = 'margin-bottom:10px;';

      const line = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${formatKey(a.key)}: `;
      line.appendChild(strong);
      line.appendChild(document.createTextNode(`${a.value}`));
      li.appendChild(line);

      const meta = document.createElement('div');
      meta.style.cssText = 'color:#999;font-size:11px;margin-top:1px;';
      meta.textContent = `${a.source}, ${Math.round(a.confidence * 100)}% confidence`;
      li.appendChild(meta);

      if (a.mattersBecause) {
        const why = document.createElement('div');
        why.style.cssText = 'color:#444;font-size:12.5px;margin-top:4px;line-height:1.5;';
        why.textContent = firstSentence(a.mattersBecause);
        li.appendChild(why);
      }

      list.appendChild(li);
    }
    panel.appendChild(list);
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    showPanel('Analyzing…');
    try {
      const snapshot = window.__captureListing ? window.__captureListing() : null;
      if (!snapshot) throw new Error('content.js did not load — capture unavailable');

      const res = await fetch(ANALYZE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...snapshot, category: 'monitor' }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}: ${await res.text()}`);

      renderResult(await res.json());
    } catch (err) {
      showPanel(`${err.message}\n\nIs the analyze server running? Start it with:\n  npm run sink`);
    } finally {
      btn.disabled = false;
    }
  });
})();
