export function GET() {
  return new Response(null, { headers: { 'Cache-Control': 'no-store' } });
}
