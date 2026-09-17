/* fl-content.js — shared by the website (server) and the customer/admin apps (browser).
 * Turns content text into safe HTML:
 *   • live tokens  {price:Wash & Fold} {retail:…} {commercial:…} {fee:Delivery Fee}
 *                  {plan:price|lbs|overage|name} {referral:friend|referrer}
 *                  {site:<key>} {zones:cities}
 *     filled from site_public_values(); an unknown token renders as nothing and is
 *     reported in `missing` so the admin editor can flag it.
 *   • light markdown: blank line = paragraph, "- " lines = bullets, **bold**,
 *     [text](https://… or /path or mailto:/tel:)
 * Everything is HTML-escaped first, so content can never inject markup.
 */
(function (root) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) {
    const v = Number(n);
    if (!isFinite(v)) return '';
    return '$' + (Math.round(v * 100) % 100 === 0 ? String(Math.round(v)) : v.toFixed(2));
  }
  function list(arr) {
    const a = (arr || []).filter(Boolean);
    if (a.length <= 1) return a.join('');
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }
  function priceText(p) {
    if (!p) return null;
    return money(p.amount) + (p.type === 'per_lb' ? '/lb' : '');
  }
  // Returns the plain-text value for one token, or null if unknown.
  function tokenValue(kind, arg, v) {
    v = v || {};
    switch (kind) {
      case 'price':    return priceText((v.price || {})[arg]);
      case 'retail':   return priceText((v.retail || {})[arg]);
      case 'commercial': return priceText((v.commercial || {})[arg]);
      case 'fee':      return (v.fee || {})[arg] != null ? money(v.fee[arg]) : null;
      case 'plan': {
        const p = v.plan || {};
        if (arg === 'price' || arg === 'overage') return p[arg] != null ? money(p[arg]) : null;
        if (arg === 'lbs') return p.lbs != null ? String(p.lbs) : null;
        if (arg === 'name') return p.name || null;
        return null;
      }
      case 'referral': {
        const r = v.referral || {};
        return (arg === 'friend' || arg === 'referrer') && r[arg] != null ? money(r[arg]) : null;
      }
      case 'site':     return (v.site || {})[arg] != null && (v.site || {})[arg] !== '' ? String(v.site[arg]) : null;
      case 'zones':    return arg === 'cities' ? list(v.cities) : null;
      default:         return null;
    }
  }
  const TOKEN_RE = /\{(price|retail|commercial|fee|plan|referral|site|zones):([^{}\n]{1,60})\}/g;

  // Fill tokens in already-escaped text. Returns { text, missing[] }.
  function fillTokens(escapedText, values) {
    const missing = [];
    const text = escapedText.replace(TOKEN_RE, (m, kind, arg) => {
      // arg arrived escaped (e.g. "Wash &amp; Fold"); look it up unescaped
      const raw = arg.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      const val = tokenValue(kind, raw, values);
      if (val == null) { missing.push(`{${kind}:${raw}}`); return ''; }
      return esc(val);
    });
    return { text, missing };
  }

  function safeUrl(u) {
    const url = u.replace(/&amp;/g, '&').trim();
    if (/^(https?:\/\/|\/(?!\/)|mailto:|tel:|#)/i.test(url)) return esc(url);
    return null;
  }
  function inline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
        const u = safeUrl(url);
        if (!u) return label;
        const ext = /^https?:/i.test(url) && !/familylaundry\.com/i.test(url);
        return `<a href="${u}"${ext ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
      });
  }

  // Full render: content text → HTML. Returns { html, missing }.
  function renderContent(text, values) {
    const filled = fillTokens(esc(String(text || '').replace(/\r\n/g, '\n')), values);
    const blocks = filled.text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    const html = blocks.map(b => {
      const lines = b.split('\n');
      if (lines.every(l => /^\s*-\s+/.test(l))) {
        return '<ul>' + lines.map(l => '<li>' + inline(l.replace(/^\s*-\s+/, '')) + '</li>').join('') + '</ul>';
      }
      return '<p>' + inline(lines.join('<br>')) + '</p>';
    }).join('');
    return { html, missing: filled.missing };
  }
  // Plain text (for search, SEO descriptions, JSON-LD).
  function renderPlain(text, values) {
    const f = fillTokens(esc(String(text || '')), values).text;
    return f.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
  }

  const api = { esc, money, list, tokenValue, fillTokens, renderContent, renderPlain, TOKEN_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FLContent = api;
})(typeof window !== 'undefined' ? window : globalThis);
