import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Star Document Markup is the native format for Star mC-Print3 (and TSP654II).
// The printer requests a media type it supports; we prefer text/vnd.star.markup
// so the printer handles fonts, barcodes, alignment, and encoding natively.
const MEDIA_TYPES = [
  'text/vnd.star.markup',
  'application/vnd.star.starprnt',
  'application/vnd.star.starprntcore',
  'application/vnd.star.line',
];

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Job completion (DELETE or GET with ?delete) ──
  if (req.method === 'DELETE' || (req.method === 'GET' && url.searchParams.has('delete'))) {
    const { data: job } = await db.from('print_jobs').select('id')
      .eq('status', 'claimed').order('claimed_at', { ascending: true }).limit(1).maybeSingle();
    if (job) {
      await db.from('print_jobs').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', job.id);
      console.log(`[CP] Done: ${job.id}`);
    }
    return new Response('', { status: 200 });
  }

  // ── Poll: does a job exist? ──
  if (req.method === 'GET') {
    const mediaType = url.searchParams.get('type') || url.searchParams.get('mediaType') || '';

    if (!mediaType) {
      // Printer is asking "any jobs for me?"
      const { data: job } = await db.from('print_jobs').select('id')
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(1).maybeSingle();
      return new Response(
        JSON.stringify(job ? { jobReady: true, mediaTypes: MEDIA_TYPES } : { jobReady: false }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Serve the job content ──
    const { data: job } = await db.from('print_jobs').select('id, content')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (!job) return new Response('', { status: 404 });

    // Mark claimed immediately
    await db.from('print_jobs').update({ status: 'claimed', claimed_at: new Date().toISOString() }).eq('id', job.id);
    console.log(`[CP] Serving job ${job.id} as ${mediaType}`);

    // Serve Star Document Markup as-is — the printer renders it natively
    // (fonts, barcodes, alignment, cut commands all handled by the printer firmware)
    return new Response(job.content, {
      headers: { 'Content-Type': 'text/vnd.star.markup' }
    });
  }

  // ── POST: some printers poll via POST ──
  if (req.method === 'POST') {
    const { data: job } = await db.from('print_jobs').select('id')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(1).maybeSingle();
    return new Response(
      JSON.stringify(job ? { jobReady: true, mediaTypes: MEDIA_TYPES } : { jobReady: false }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response('Method Not Allowed', { status: 405 });
});
