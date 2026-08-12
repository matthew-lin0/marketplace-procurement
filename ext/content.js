/**
 * Runs in the page. Its ONLY job is to serialize what is already on screen and
 * hand it back — no product logic, no interpretation.
 *
 * Deliberately almost selector-free.
 *
 * Every marketplace is a different grocery store stocking the same products.
 * You always want "milk," but in one store it's aisle 3 back-left and in
 * another it's a cooler by the entrance. An adapter is that set of directions,
 * and it breaks whenever the store remodels. Craigslist never remodels
 * (stable ids like #titletextonly). Facebook Marketplace generates class names
 * fresh on every deploy (x1i10hfl x1qjc9v5 ...), so selector-based adapters rot
 * in weeks.
 *
 * The fix: hand the model the whole shelf. We grab rendered text, embedded
 * JSON-LD, and every plausible gallery image, and let the extractor do the
 * structuring. Per-site code shrinks to roughly one selector, and it fails
 * gracefully (a bit less text) instead of silently (wrong field).
 */

(function () {
  function marketplace() {
    const h = location.hostname;
    if (h.includes('facebook.')) return 'facebook';
    if (h.includes('craigslist.')) return 'craigslist';
    if (h.includes('ebay.')) return 'ebay';
    return 'other';
  }

  /** Some SPAs (Facebook Marketplace confirmed) render the listing you're
   *  actually viewing as a modal dialog on top of whatever page you navigated
   *  from — a search results page still full of OTHER listings' text and
   *  images. role="dialog" is a stable accessibility landmark (unlike
   *  generated class names) that scopes to just the listing being viewed,
   *  when one is present; falls back to the whole page otherwise, so this is
   *  a strict improvement with no new failure mode. */
  function contentRoot() {
    return document.querySelector('[role="dialog"]') || document.body;
  }

  function visibleText() {
    // Clone so removals don't disturb the live page.
    const body = contentRoot().cloneNode(true);
    for (const el of body.querySelectorAll('script, style, noscript, svg, nav, header, footer')) {
      el.remove();
    }
    return (body.innerText || body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function jsonLd() {
    const out = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        out.push(JSON.parse(el.textContent || ''));
      } catch {
        // Malformed JSON-LD is common; skip rather than fail the capture.
      }
    }
    return out;
  }

  /** Upgrades known CDN thumbnail URLs to full resolution where the pattern is
   *  well established. Listings get deleted within days, so a low-res capture
   *  cannot be redone later. */
  function fullResUrl(url) {
    return url
      .replace(/\/\d+x\d+\//, '/1200x1200/')
      .replace(/_\d+x\d+(\.\w+)$/, '_1200x1200$1')
      .replace(/([?&])(w|width)=\d+/g, '$1$2=1600');
  }

  function images() {
    const root = contentRoot();
    const seen = new Set();
    const out = [];

    for (const img of root.querySelectorAll('img')) {
      // Skip avatars, icons, and tracking pixels by rendered size.
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < 200 || h < 200) continue;

      // Prefer the largest srcset candidate over the src attribute.
      let best = img.currentSrc || img.src;
      if (img.srcset) {
        const candidates = img.srcset
          .split(',')
          .map((s) => s.trim().split(/\s+/))
          .map(([u, d]) => ({ url: u, width: parseInt(d ?? '0', 10) || 0 }))
          .sort((a, b) => b.width - a.width);
        if (candidates.length && candidates[0].url) best = candidates[0].url;
      }
      if (!best || best.startsWith('data:')) continue;

      const abs = new URL(best, location.href).href;
      const upgraded = fullResUrl(abs);
      if (seen.has(upgraded)) continue;
      seen.add(upgraded);
      out.push({ url: upgraded, width: w, height: h });
    }

    // Also catch CSS background images used by some galleries.
    for (const el of root.querySelectorAll('[style*="background-image"]')) {
      const m = /url\(["']?(.*?)["']?\)/.exec(el.getAttribute('style') || '');
      if (!m || !m[1] || m[1].startsWith('data:')) continue;
      // Not a listing photo: Facebook's "approximate location" widget renders
      // as a background-image static map tile inside the same dialog.
      if (/static_map\.php/i.test(m[1])) continue;
      const abs = new URL(m[1], location.href).href;
      const upgraded = fullResUrl(abs);
      if (seen.has(upgraded)) continue;
      seen.add(upgraded);
      out.push({ url: upgraded, width: null, height: null });
    }

    return out;
  }

  function price() {
    const text = contentRoot().innerText || contentRoot().textContent || '';
    const m = /\$\s?([\d,]+(?:\.\d{2})?)/.exec(text);
    return m ? Number.parseFloat(m[1].replace(/,/g, '')) : null;
  }

  // The one place per-site knowledge lives, and it is only a hint — the
  // extractor sees renderedText regardless, so a stale selector degrades the
  // capture instead of breaking it.
  function titleHint() {
    const cl = document.querySelector('#titletextonly');
    if (cl && cl.textContent) return cl.textContent.trim();
    // Facebook's og:title on marketplace item pages is a generic
    // "Marketplace" string, not the listing's own title — the dialog's own
    // <h1> (if a dialog is present at all) is the real one.
    const dialogH1 = document.querySelector('[role="dialog"] h1');
    if (dialogH1 && dialogH1.textContent) return dialogH1.textContent.trim();
    const og = document.querySelector('meta[property="og:title"]');
    if (og) return og.getAttribute('content') || document.title;
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent) return h1.textContent.trim();
    return document.title;
  }

  /** Facebook's dialog renders "...Details Condition{tier}{description}
   *  {city}, {state} · Location is approximate...", with NO separator between
   *  the description and the city name that follows it. The city is
   *  extracted first from an earlier, cleanly-delimited spot ("ago in {city}
   *  Message") and then used as a literal anchor to trim the description's
   *  tail — guessing that boundary with a character class instead silently
   *  eats part of the real description (validated against real captures
   *  before landing this). Returns null fields, not throws, if the shape
   *  doesn't match. */
  function dialogDetails() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { locationText: null, description: null };
    const text = dialog.textContent || '';

    const locMatch = /ago in (.+?)Message/.exec(text);
    const locationText = locMatch ? locMatch[1].trim() : null;

    const condMatch = /Condition(New|Used - Like new|Used - Good|Used - Fair)/.exec(text);
    if (!condMatch) return { locationText, description: null };

    let rest = text.slice(condMatch.index + condMatch[0].length);
    if (locationText) {
      const escaped = locationText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rest = rest.replace(new RegExp(`${escaped}\\s*·\\s*Location is approximate[\\s\\S]*$`), '');
    }
    const description = rest.trim();
    return { locationText, description: description || null };
  }

  function descriptionHint(details) {
    const cl = document.querySelector('#postingbody');
    if (cl && cl.innerText) return cl.innerText.trim();
    if (details.description) return details.description;
    const og = document.querySelector('meta[property="og:description"]');
    if (og) return og.getAttribute('content') || '';
    return '';
  }

  const details = dialogDetails();

  return {
    sourceUrl: location.href,
    marketplace: marketplace(),
    capturedAt: new Date().toISOString(),
    title: titleHint(),
    description: descriptionHint(details),
    priceUsd: price(),
    locationText: details.locationText,
    renderedText: visibleText(),
    jsonLd: jsonLd(),
    // Raw bytes, unmodified. Normalization is the thing under test, so it has
    // to be re-runnable against the original.
    html: document.documentElement.outerHTML,
    images: images(),
  };
})();
