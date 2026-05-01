import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ─── Star Line Mode Command Constants ───
// The mC-Print3 with firmware 5.2, when served as application/vnd.star.starprnt,
// expects STAR LINE MODE commands — NOT Epson ESC/POS.
// Key differences from Epson:
//   Bold:      ESC E (on) / ESC F (off)  — NO parameter byte
//   Alignment: ESC GS a n               — 4 bytes (not ESC a n)
//   Sizing:    ESC i w h                 — (not GS !)
//   Cut:       ESC d n                   — (not GS V)
//   Barcode:   ESC b type w h hri data RS — (not GS k)

const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;
const RS  = 0x1E; // Record separator — terminates barcode data in Star mode

const CONTENT_TYPE = 'application/vnd.star.starprnt';

const MEDIA_TYPES = [
  'application/vnd.star.starprnt',
  'application/vnd.star.starprntcore',
  'application/vnd.star.line',
];

// Paper width in characters (Font A on 80mm paper, mC-Print3)
const PAPER_WIDTH = 48;

// ─── Star Markup XML → Star Line Mode Binary Converter ───

function markupToStarLineMode(xml: string): Uint8Array {
  const buf: number[] = [];

  const push = (...bytes: number[]) => { for (const b of bytes) buf.push(b); };
  const pushStr = (s: string) => {
    // Convert to bytes, replacing non-ASCII with safe equivalents
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x80) {
        buf.push(code);
      } else {
        // Map common Unicode to ASCII equivalents for thermal printer
        const ch = s[i];
        const mapped = UNICODE_MAP[ch];
        if (mapped) {
          for (let j = 0; j < mapped.length; j++) buf.push(mapped.charCodeAt(j));
        } else {
          buf.push(0x3F); // '?' for unknown
        }
      }
    }
  };

  // ── Initialize printer ──
  push(ESC, 0x40); // ESC @ — initialize

  // ── State tracking ──
  let currentSizeW = 1;
  let currentSizeH = 1;

  // Strip <document> wrapper
  xml = xml.replace(/<\/?document>/g, '').trim();

  // Tokenize
  const tokens = tokenizeXml(xml);

  // Walk tokens and emit Star Line Mode commands
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok.type === 'text') {
      const decoded = decodeXmlEntities(tok.text || '');
      if (decoded.trim()) {
        pushStr(decoded);
      }
      i++;
      continue;
    }

    const name = tok.name!;
    const attrs = tok.attrs || {};
    const closing = tok.closing;
    const selfClosing = tok.selfClosing;

    if (name === 'align' && !closing) {
      const mode = attrs['mode'] || 'left';
      const n = mode === 'center' ? 1 : mode === 'right' ? 2 : 0;
      push(ESC, GS, 0x61, n); // Star: ESC GS a n

    } else if (name === 'align' && closing) {
      push(ESC, GS, 0x61, 0); // Reset to left

    } else if (name === 'text-line' && !closing) {
      if (attrs['size']) {
        const parts = attrs['size'].split(':');
        currentSizeW = parseInt(parts[0]) || 1;
        currentSizeH = parseInt(parts[1]) || 1;
        // Star: ESC i width_expansion height_expansion
        // 0 = normal (1x), 1 = double (2x), 2 = triple (3x)
        push(ESC, 0x69, currentSizeW - 1, currentSizeH - 1);
      }

    } else if (name === 'text-line' && closing) {
      push(LF);
      if (currentSizeW !== 1 || currentSizeH !== 1) {
        currentSizeW = 1;
        currentSizeH = 1;
        push(ESC, 0x69, 0, 0); // Reset to normal size
      }

    } else if (name === 'bold' && !closing) {
      push(ESC, 0x45); // Star: ESC E — bold ON (no parameter!)

    } else if (name === 'bold' && closing) {
      push(ESC, 0x46); // Star: ESC F — bold OFF (no parameter!)

    } else if (name === 'ruled-line' && (selfClosing || !closing)) {
      const dashCount = currentSizeW > 1 ? Math.floor(PAPER_WIDTH / currentSizeW) : PAPER_WIDTH;
      pushStr('-'.repeat(dashCount));
      push(LF);

    } else if (name === 'feed' && (selfClosing || !closing)) {
      const mm = parseInt(attrs['quantity'] || '5');
      const lines = Math.max(1, Math.round(mm / 4));
      // Just send N line feeds
      for (let j = 0; j < lines; j++) push(LF);

    } else if (name === 'cut' && (selfClosing || !closing)) {
      const cutType = attrs['type'] || 'partial';
      // Star: ESC d n — 0=full, 1=partial, 2=full+feed, 3=partial+feed
      push(ESC, 0x64, cutType === 'full' ? 0 : 1);

    } else if (name === 'barcode' && !closing) {
      const height = parseInt(attrs['height'] || '50');
      const hri = attrs['hri'] || 'none';

      // Collect barcode data
      let barcodeData = '';
      i++;
      while (i < tokens.length) {
        if (tokens[i].type === 'text') {
          barcodeData += decodeXmlEntities(tokens[i].text || '');
        } else if (tokens[i].type === 'tag' && tokens[i].name === 'barcode' && tokens[i].closing) {
          break;
        }
        i++;
      }
      barcodeData = barcodeData.trim();

      if (barcodeData) {
        // Star: ESC b n1 n2 n3 n4 data RS
        // n1 = barcode type: 6 = Code128
        // n2 = module width: 2 (medium)
        // n3 = height in dots
        // n4 = HRI mode: 0=none, 1=below, 2=above, 3=both
        const hriMode = hri === 'above' ? 2 : hri === 'below' ? 1 : hri === 'both' ? 3 : 0;
        push(ESC, 0x62, 6, 2, Math.min(255, height), hriMode);
        pushStr(barcodeData);
        push(RS); // Terminate barcode data
      }
    }

    i++;
  }

  return new Uint8Array(buf);
}

// ─── Common Unicode → ASCII map for thermal printers ───
const UNICODE_MAP: Record<string, string> = {
  '×': 'x',
  '·': '-',
  '—': '-',
  '–': '-',
  '\u2014': '-', // em dash
  '\u2013': '-', // en dash
  '\u2018': "'", // left single quote
  '\u2019': "'", // right single quote
  '\u201C': '"', // left double quote
  '\u201D': '"', // right double quote
  '\u2026': '...',// ellipsis
  '\u00A0': ' ', // non-breaking space
  '\u2022': '*', // bullet
};

// ─── XML Tokenizer ───
interface Token {
  type: 'tag' | 'text';
  closing?: boolean;
  selfClosing?: boolean;
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
}

function tokenizeXml(xml: string): Token[] {
  const tokens: Token[] = [];
  const tagPattern = /<(\/?)([\w][\w-]*)((?:\s+[\w-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = tagPattern.exec(xml)) !== null) {
    if (m.index > lastIndex) {
      const text = xml.substring(lastIndex, m.index);
      if (text.trim() || text.includes(' ')) {
        tokens.push({ type: 'text', text });
      }
    }
    const attrs: Record<string, string> = {};
    if (m[3]) {
      const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(m[3])) !== null) {
        attrs[am[1]] = am[2];
      }
    }
    tokens.push({
      type: 'tag',
      closing: m[1] === '/',
      name: m[2],
      attrs,
      selfClosing: m[4] === '/',
    });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < xml.length) {
    const text = xml.substring(lastIndex);
    if (text.trim()) tokens.push({ type: 'text', text });
  }
  return tokens;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec)));
}

// ─── Edge Function Handler ───

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // session 140: every print_job has a printer_token; each polling printer
  // identifies itself via ?mac=XX:XX:XX:XX:XX:XX. Filter by MAC so jobs are
  // routed to the correct printer when more than one printer is on the system.
  // Match is case-insensitive (DB tokens are uppercase, printers usually send
  // lowercase in the query string). If `mac` is missing (legacy callers,
  // browser tests), fall back to "any pending job" to preserve old behaviour.
  const mac = (url.searchParams.get('mac') || '').trim();
  const applyMacFilter = (q: any) => mac ? q.ilike('printer_token', mac) : q;

  // ── Job completion (DELETE or GET with ?delete) ──
  if (req.method === 'DELETE' || (req.method === 'GET' && url.searchParams.has('delete'))) {
    const { data: job } = await applyMacFilter(
      db.from('print_jobs').select('id')
        .eq('status', 'claimed')
        .order('claimed_at', { ascending: true })
        .limit(1)
    ).maybeSingle();
    if (job) {
      await db.from('print_jobs').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', job.id);
      console.log(`[CP] Done: ${job.id} (mac=${mac})`);
    }
    return new Response('', { status: 200 });
  }

  // ── Poll: does a job exist? ──
  if (req.method === 'GET') {
    const mediaType = url.searchParams.get('type') || url.searchParams.get('mediaType') || '';

    if (!mediaType) {
      const { data: job } = await applyMacFilter(
        db.from('print_jobs').select('id')
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(1)
      ).maybeSingle();
      return new Response(
        JSON.stringify(job ? { jobReady: true, mediaTypes: MEDIA_TYPES } : { jobReady: false }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Serve the job content as Star Line Mode binary ──
    const { data: job } = await applyMacFilter(
      db.from('print_jobs').select('id, content')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
    ).maybeSingle();
    if (!job) return new Response('', { status: 404 });

    await db.from('print_jobs').update({ status: 'claimed', claimed_at: new Date().toISOString() }).eq('id', job.id);

    const starBytes = markupToStarLineMode(job.content);
    console.log(`[CP] Serving job ${job.id} to mac=${mac} — ${starBytes.length} bytes Star Line Mode`);

    return new Response(starBytes, {
      headers: { 'Content-Type': CONTENT_TYPE }
    });
  }

  // ── POST: some printers poll via POST ──
  if (req.method === 'POST') {
    const { data: job } = await applyMacFilter(
      db.from('print_jobs').select('id')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
    ).maybeSingle();
    return new Response(
      JSON.stringify(job ? { jobReady: true, mediaTypes: MEDIA_TYPES } : { jobReady: false }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response('Method Not Allowed', { status: 405 });
});
