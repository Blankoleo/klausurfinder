#!/usr/bin/env node
/* Holt die Klausurtermine (Jg. 11–13) aus dem Klausurkalender der Voltaireschule
   und schreibt sie nach termine.json (im Hauptordner des Repos).

   Weg 1 (bevorzugt, 2 Seitenaufrufe, kein Browser nötig):
     Kalenderseite laden → nonce + data-args des Kalender-Plugins (ICS Calendar Pro) lesen →
     einmal admin-ajax.php (action=r34ics_ajax) abfragen. Die Antwort enthält alle Termine
     als JSON (FullCalendar), mit Feed-Nummer, Datum, Uhrzeit und Titel.
   Weg 2 (Ersatz, falls sich das Plugin ändert): Playwright/Chromium öffnet die
     Monatsansichten (?r34icsymd=JJJJMM01) und liest den Text aus `.ics-calendar` –
     genau wie scrapeMonth in index.html – mit derselben Funktion parseCalendarText.

   Die Parser-Logik (JG_RE, parseCalendarText) wird direkt aus index.html gelesen
   (Block zwischen den Markierungen <termine-parser> … </termine-parser>), damit es
   nur eine Stelle gibt, die man pflegen muss.

   Bei Fehlern oder leerem Ergebnis bleibt die alte termine.json unangetastet (Exitcode 1).
   Aufruf: node tools/update-termine.mjs [--nur-browser] [--trocken] [--ziel datei.json] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_URL = 'https://www.voltaireschule.de/jahrgang-11-bis-13-klausuren/';
const UA = 'Mozilla/5.0 (compatible; Klausur-Finder-Termine/1.0; +https://blankoleo.github.io/klausurfinder/)';
const FEED_LABEL = /11\s*[-–]\s*13\s*Klausuren/i;   // Name des Feeds in der Farblegende
const MIN_MONTHS_AHEAD = 6;
const TIMEOUT_MS = 60000;

const args = process.argv.slice(2);
const ONLY_BROWSER = args.includes('--nur-browser');
const DRY = args.includes('--trocken');
const OUT = args.includes('--ziel') ? path.resolve(args[args.indexOf('--ziel') + 1]) : path.join(ROOT, 'termine.json');

// ---------- Parser aus index.html übernehmen ----------
function loadParser() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = html.indexOf('/* <termine-parser>'), b = html.indexOf('/* </termine-parser>');
  if (a < 0 || b < a) throw new Error('Parser-Block <termine-parser> in index.html nicht gefunden');
  return new Function(`${html.slice(a, b)}\nreturn { pad2, isoOf, JG_RE, parseCalendarText };`)();
}
const P = loadParser();

// ---------- Zeitraum: Schuljahr (ab 1. August) bis Schuljahresende, mind. 6 Monate voraus ----------
function berlinNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, stand: `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}` };
}
function monthRange(now) {
  const syStart = now.m >= 7 ? now.y : now.y - 1;                // Schuljahr beginnt im August
  const first = { y: syStart, m: 7 };
  const syEnd = { y: syStart + 1, m: 6 };                         // Juli des Folgejahres
  const minEnd = { y: now.y + Math.floor((now.m + MIN_MONTHS_AHEAD) / 12), m: (now.m + MIN_MONTHS_AHEAD) % 12 };
  const last = (syEnd.y * 12 + syEnd.m) >= (minEnd.y * 12 + minEnd.m) ? syEnd : minEnd;
  const res = [];
  for (let k = first.y * 12 + first.m; k <= last.y * 12 + last.m; k++) res.push({ y: Math.floor(k / 12), m: k % 12 });
  return res;
}
const ym = x => `${x.y}-${P.pad2(x.m + 1)}`;

// ---------- Weg 1: admin-ajax (JSON) ----------
async function fetchText(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status} für ${url}`);
  return r.text();
}
const decodeAttr = s => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Das JSON-Array hinter „events:“ ausschneiden (Klammern zählen, Zeichenketten beachten)
function extractEventsArray(html) {
  const i = html.indexOf('[', html.search(/\bevents\s*:\s*\[/));
  if (html.search(/\bevents\s*:\s*\[/) < 0 || i < 0) throw new Error('Kein „events: [ … ]“ in der Kalender-Antwort');
  let depth = 0, inStr = false, k = i;
  for (; k < html.length; k++) {
    const c = html[k];
    if (inStr) { if (c === '\\') k++; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  return JSON.parse(html.slice(i, k + 1));
}
const hm = iso => { const m = iso && iso.match(/T(\d{2}):(\d{2})/); return m ? `${+m[1]}:${m[2]}` : null; };
async function viaAjax() {
  const page = await fetchText(PAGE_URL);
  const obj = page.match(/r34ics_ajax_obj\s*=\s*(\{[^;]*\})/);
  const cont = page.match(/<div[^>]*class="[^"]*r34ics-ajax-container[^"]*"[^>]*>/);
  if (!obj || !cont) throw new Error('Kalender-Plugin (r34ics) auf der Seite nicht gefunden');
  const { ajaxurl, r34ics_nonce } = JSON.parse(obj[1]);
  const attr = n => { const m = cont[0].match(new RegExp(`${n}="([^"]*)"`)); return m ? decodeAttr(m[1]) : ''; };
  const body = new URLSearchParams({ action: 'r34ics_ajax', r34ics_nonce, subaction: 'display_calendar', args: attr('data-args') });
  try { for (const [k, v] of Object.entries(JSON.parse(attr('data-js-args') || '{}'))) body.append(`js_args[${k}]`, v); } catch {}
  const html = await fetchText(ajaxurl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: PAGE_URL } });
  const all = extractEventsArray(html);
  // Feed „Jg. 11-13 Klausuren“ über die Farblegende bestimmen (sonst: alle Feeds, gefiltert über JG_RE wie auf der Seite)
  let feed = null;
  for (const m of html.matchAll(/data-feed-key="(\d+)"[^>]*>\s*<label[^>]*>([\s\S]*?)<\/label>/g))
    if (FEED_LABEL.test(m[2].replace(/<[^>]+>/g, ' '))) feed = m[1];
  const src = feed !== null && all.some(e => String(e.groupId) === feed) ? all.filter(e => String(e.groupId) === feed) : all;
  const events = [];
  for (const e of src) {
    const title = String(e.title || '').replace(/\s+/g, ' ').trim();
    const m = title.match(P.JG_RE); if (!m || !e.start) continue;
    events.push({ date: e.start.slice(0, 10), start: e.allDay ? null : hm(e.start), end: e.allDay ? null : hm(e.end), jg: +m[1], ...(m[2] ? { jgTo: +m[2] } : {}), text: m[3] });
  }
  return { events, how: `admin-ajax (Feed ${feed ?? 'alle'}, ${src.length} Einträge)` };
}

// ---------- Weg 2: Playwright, Monatsansichten ----------
async function viaBrowser(months) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: UA, viewport: { width: 1200, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    const events = [];
    for (const mo of months) {
      const ymd = `${mo.y}${P.pad2(mo.m + 1)}01`;
      await page.goto(`${PAGE_URL}?r34icsymd=${ymd}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
      // wie scrapeMonth: warten, bis Monatsname + Tageszahlen da sind und der Text 600 ms stabil bleibt
      let prev = null, since = Date.now(), txt = '';
      const t0 = Date.now();
      for (;;) {
        txt = await page.evaluate(() => { const c = document.querySelector('.ics-calendar'); return c ? c.innerText : ''; });
        const ready = /(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4}/.test(txt) && /\n\s*\d{1,2}\s*\n/.test(txt);
        if (ready && txt === prev) { if (Date.now() - since >= 600) break; } else { prev = txt; since = Date.now(); }
        if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`Zeitüberschreitung (${ymd})`);
        await page.waitForTimeout(250);
      }
      const r = P.parseCalendarText(txt);
      const want = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-01`;
      if (!r.from || r.from > want || r.to < want) throw new Error(`falscher Monat angezeigt (${ymd})`);
      const key = ym(mo);
      events.push(...r.events.filter(e => e.date.slice(0, 7) === key));   // nur Tage des Monats selbst (Ränder kommen im Nachbarmonat)
      console.log(`  ${key}: ${r.events.filter(e => e.date.slice(0, 7) === key).length} Termine`);
    }
    return { events, how: `Browser (${months.length} Monatsansichten)` };
  } finally { await browser.close(); }
}

// ---------- Hauptteil ----------
const dedupe = evs => { const seen = new Set(); return evs.filter(e => { const k = [e.date, e.start, e.jg, e.text].join('|'); if (seen.has(k)) return false; seen.add(k); return true; }); };
const tp = t => (t || '00:00').padStart(5, '0');
const valid = e => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isInteger(e.jg) && e.jg >= 5 && e.jg <= 13 && typeof e.text === 'string' && e.text.length > 0;

async function main() {
  const now = berlinNow();
  const months = monthRange(now);
  const from = `${ym(months[0])}-01`, to = `${ym(months.at(-1))}-31`;
  // Beim Browser-Weg nur aktuellen + folgende Monate laden (höflich: wenige Seitenaufrufe)
  const browserMonths = months.filter(x => x.y * 12 + x.m >= now.y * 12 + now.m);
  let res = null;
  if (!ONLY_BROWSER) {
    try { res = await viaAjax(); if (!res.events.length) throw new Error('keine Klausurtermine im JSON'); }
    catch (e) { console.warn(`Weg 1 (admin-ajax) fehlgeschlagen: ${e.message}`); res = null; }
  }
  let monate = months.map(ym);
  if (!res) {
    res = await viaBrowser(browserMonths);
    monate = browserMonths.map(ym);
  }
  const lo = `${monate[0]}-01`;
  const events = dedupe(res.events.filter(e => valid(e) && e.date >= (res.how.startsWith('Browser') ? lo : from) && e.date <= to))
    .sort((a, b) => (a.date + tp(a.start) + a.jg).localeCompare(b.date + tp(b.start) + b.jg));
  if (!events.length) throw new Error('Keine Klausurtermine gefunden – termine.json bleibt unverändert');
  const future = events.filter(e => e.date >= `${now.y}-${P.pad2(now.m + 1)}-01`).length;
  const out = { stand: now.stand, quelle: 'Klausurkalender', weg: res.how, monate, events };
  console.log(`${events.length} Klausurtermine (${future} ab diesem Monat) über ${res.how}, Monate ${monate[0]} … ${monate.at(-1)}`);
  if (DRY) { console.log(JSON.stringify(out, null, 1).slice(0, 1500)); return; }
  // Immer schreiben: „stand“ zeigt auf der Seite, wann zuletzt erfolgreich geprüft wurde. Dadurch entsteht
  // täglich ein kleiner Commit – das hält nebenbei die geplante Action aktiv (GitHub pausiert sie sonst nach 60 Tagen ohne Commits).
  const tmp = `${OUT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1) + '\n');
  fs.renameSync(tmp, OUT);
  console.log(`geschrieben: ${path.relative(process.cwd(), OUT) || OUT}`);
}

main().catch(e => { console.error(`FEHLER: ${e.message || e}`); process.exit(1); });
