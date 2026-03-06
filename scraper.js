#!/usr/bin/env node
/**
 * PortaPulse Phoenix Event Scraper
 * Scrapes Tier 1 public event sources for demand forecasting.
 * Runs inside OpenClaw container via Firecrawl.
 * Posts results to Google Sheets webhook.
 */

const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwCSBe5ZDioJj5gf75dAILric0p46vxq8MBOO7fvw6OZpDRQv1-53z8xw6qMbasYvYl/exec';

const SOURCES = [
  { name: 'Visit Phoenix', url: 'https://www.visitphoenix.com/events/', city: 'Phoenix' },
  { name: 'Downtown Phoenix', url: 'https://dtphx.org/events/calendar', city: 'Phoenix' },
  { name: 'Phoenix Open Data', url: 'https://www.phoenixopendata.com/showcase/planned-major-street-restrictions-and-closures', city: 'Phoenix' },
  { name: 'Maricopa County Parks', url: 'https://www.maricopacountyparks.net/events/', city: 'Maricopa County' },
  { name: 'Glendale Events', url: 'https://www.glendaleaz.gov/Play/Special-Events/Events', city: 'Glendale' },
  { name: 'Tempe Tourism', url: 'https://www.tempetourism.com/events/', city: 'Tempe' },
  { name: 'Downtown Tempe', url: 'https://www.downtowntempe.com/events', city: 'Tempe' },
  { name: 'Scottsdale Events', url: 'https://www.scottsdaleaz.gov/special-events', city: 'Scottsdale' },
  { name: 'Eventbrite Phoenix', url: 'https://www.eventbrite.com/d/az--phoenix/events/', city: 'Phoenix' },
];

const { execSync } = require('child_process');

async function scrapeSource(source) {
  try {
    const raw = execSync(
      `firecrawl scrape "${source.url}" -f markdown --only-main-content`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 5 * 1024 * 1024 }
    );
    return { source, content: raw, error: null };
  } catch (err) {
    console.error(`[FAIL] ${source.name}: ${err.message.split('\n')[0]}`);
    return { source, content: null, error: err.message.split('\n')[0] };
  }
}

function extractEvents(content, source) {
  if (!content) return [];
  const events = [];
  const lines = content.split('\n');
  const now = new Date().toISOString();
  const datePattern = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s.,]+\d{1,2}(?:[\s,–-]+\d{2,4})?|(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi;

  let currentEvent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 5 || line.length > 200) continue;
    if (/^(menu|nav|footer|copyright|privacy|terms|cookie|sign up|log in|subscribe)/i.test(line)) continue;

    const dateMatch = line.match(datePattern);
    const isHeader = /^#{1,3}\s/.test(line) || /^\*\*[^*]+\*\*/.test(line);
    const isListItem = /^[-•*]\s/.test(line);

    if (isHeader || isListItem) {
      const name = line.replace(/^#{1,3}\s/, '').replace(/^\*\*|\*\*$/g, '').replace(/^[-•*]\s/, '').trim();
      if (name.length > 3 && name.length < 150) {
        currentEvent = { name, date: null, location: null };
      }
    }

    if (dateMatch && dateMatch[0]) {
      if (currentEvent) {
        currentEvent.date = dateMatch[0];
        events.push({
          event_name: currentEvent.name,
          date: currentEvent.date,
          location: currentEvent.location || '',
          city: source.city,
          source: source.name,
          source_url: source.url,
          scraped_at: now
        });
        currentEvent = null;
      } else {
        const eventName = line.replace(dateMatch[0], '').replace(/[|,–-]/g, ' ').trim();
        if (eventName.length > 3) {
          events.push({
            event_name: eventName,
            date: dateMatch[0],
            location: '',
            city: source.city,
            source: source.name,
            source_url: source.url,
            scraped_at: now
          });
        }
      }
    }
  }
  return events;
}

async function postEvent(event) {
  try {
    const payload = JSON.stringify({ type: 'event', ...event });
    const url = new URL(WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    await new Promise((resolve, reject) => {
      const req = require('https').request(options, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
  } catch (err) {
    // Silent fail per event
  }
}

async function main() {
  console.log(`\n=== PortaPulse Scraper — ${new Date().toISOString()} ===\n`);
  let totalEvents = 0;
  const summary = [];

  for (const source of SOURCES) {
    console.log(`[SCRAPING] ${source.name}...`);
    const result = await scrapeSource(source);
    if (result.error) {
      summary.push({ source: source.name, count: 0, status: 'FAILED' });
      continue;
    }
    const events = extractEvents(result.content, source);
    console.log(`  → Found ${events.length} events`);
    for (const event of events) { await postEvent(event); }
    totalEvents += events.length;
    summary.push({ source: source.name, count: events.length, status: 'OK' });
  }

  console.log('\n--- SUMMARY ---');
  summary.forEach(s => console.log(`  ${s.status === 'OK' ? '✓' : '✗'} ${s.source}: ${s.count} events`));
  console.log(`\nTOTAL: ${totalEvents} events scraped and posted.`);
  console.log('=== DONE ===\n');
}

main().catch(err => { console.error('Fatal scraper error:', err); process.exit(1); });
