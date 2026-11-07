export * as QuotaLedger from "./quota-ledger.js"

// Local, advisory-only ledger of provider daily-limit responses. The upstream
// (OpenCode Console/Zen) quota is enforced server-side and only the service can
// raise or clear it; this file records what the server told this client, so the
// session can show a real reset time and `opencode quota --reset` can clear the
// local view when the recorded horizon has passed.

import fs from "node:fs"
import path from "node:path"
import { Path } from "./global.js"

export interface Bucket {
  used: number
  limit: number | null
  blockedUntil: number | null
  resetRaw: string | null
  lastStatus: number | null
  lastError: string | null
  updatedAt: number
}

export interface Ledger {
  version: 1
  day: string
  buckets: Record<string, Bucket>
}

const FILE = path.join(Path.state, "quota-ledger.json")

/** Blocks longer than this gate requests before they are sent; shorter windows stay with the retry schedule. */
const GATE_MINIMUM_MS = 10 * 60_000

function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

function empty(): Ledger {
  return { version: 1, day: today(), buckets: {} }
}

export function read(): Ledger {
  let state: Ledger | undefined
  try {
    state = JSON.parse(fs.readFileSync(FILE, "utf8")) as Ledger
  } catch {
    return empty()
  }
  // A new local day rolls the counters; unknown versions are ignored wholesale.
  if (state.version !== 1 || state.day !== today()) return empty()
  return state
}

function write(state: Ledger) {
  // The ledger must never break a model call, so every failure is swallowed.
  try {
    fs.mkdirSync(Path.state, { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, FILE)
  } catch {}
}

function slot(state: Ledger, key: string): Bucket {
  state.buckets[key] ??= {
    used: 0,
    limit: null,
    blockedUntil: null,
    resetRaw: null,
    lastStatus: null,
    lastError: null,
    updatedAt: 0,
  }
  return state.buckets[key]
}

export function bump(key: string) {
  const state = read()
  const bucket = slot(state, key)
  bucket.used++
  bucket.updatedAt = Date.now()
  write(state)
}

export function block(
  key: string,
  input: { until: number | null; raw: string | null; status: number; error: string },
): Bucket {
  const state = read()
  const bucket = slot(state, key)
  bucket.blockedUntil = input.until
  bucket.resetRaw = input.raw
  bucket.lastStatus = input.status
  bucket.lastError = input.error
  bucket.updatedAt = Date.now()
  // The server refused for quota with a known horizon, so today's allowance is spent.
  if (input.until !== null && input.until > Date.now()) bucket.limit = bucket.used
  write(state)
  return bucket
}

/** The bucket's block, if it is still active and long enough to gate a request. */
export function blocked(key: string): Bucket | undefined {
  const bucket = read().buckets[key]
  if (!bucket?.blockedUntil) return undefined
  if (bucket.blockedUntil <= Date.now() + GATE_MINIMUM_MS) return undefined
  return bucket
}

export function reset(key?: string): Ledger {
  const state = read()
  state.buckets =
    key === undefined ? {} : Object.fromEntries(Object.entries(state.buckets).filter(([name]) => name !== key))
  write(state)
  return state
}

/** The most recent 429-quota block recorded for any key, for messages that cannot know the model key. */
export function recentBlocked(): { key: string; bucket: Bucket } | undefined {
  const entries = Object.entries(read().buckets).filter(([, bucket]) => bucket.lastStatus === 429)
  if (entries.length === 0) return undefined
  return entries.reduce((a, b) => (b[1].updatedAt > a[1].updatedAt ? b : a))
}

export function recentBlockedNote(): string {
  const recent = recentBlocked()
  if (!recent) return ""
  const when = recent.bucket.blockedUntil ? humanize(recent.bucket.blockedUntil) : "at an unknown time"
  return `(ledger: ${recent.key} used ${recent.bucket.used} today, resets ${when}; clear locally with "opencode quota --reset")`
}

export function humanize(ms: number): string {
  const delta = ms - Date.now()
  if (delta <= 0) return "now"
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// ---------- reset-time extraction from provider responses ----------

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]

// Time-zone abbreviations the Console is known to print, mapped to fixed offsets. Anything else
// falls back to local time, which can be off by hours for zones with daylight saving.
const TZ_OFFSET_MINUTES: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  IST: 330,
  BST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
}

export function parseReset(body: string | undefined, headers: Headers): { at: number | null; raw: string | null } {
  const retryAfter = headers.get("retry-after")
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter.trim()))
      return { at: Date.now() + Number(retryAfter) * 1000, raw: `retry-after: ${retryAfter}` }
    const parsed = Date.parse(retryAfter)
    if (!Number.isNaN(parsed)) return { at: parsed, raw: `retry-after: ${retryAfter}` }
  }

  const text = body ?? ""

  const epoch = /"(?:resets?_?at|resetAt|retryAt)"\s*:\s*(\d{10,13})\b/.exec(text)
  if (epoch) {
    const value = Number(epoch[1])
    return { at: epoch[1].length >= 13 ? value : value * 1000, raw: epoch[0] }
  }

  const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text)
  if (iso) {
    const parsed = Date.parse(iso[0].replace(" ", "T"))
    if (!Number.isNaN(parsed)) return { at: parsed, raw: iso[0] }
  }

  // "resets on October 29, 2026, at 5:30 AM IST" / "wait until October 30, 2026, at 5:30 AM"
  const absolute =
    /reset[s]?\s*(?:at|on|in)?\s*([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})?,?\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*(AM|PM)?\s*([A-Za-z]{2,5})?/i.exec(
      text,
    )
  if (absolute) {
    const month = MONTHS.indexOf(absolute[1].toLowerCase())
    if (month >= 0) {
      const year = absolute[3] ? Number(absolute[3]) : new Date().getFullYear()
      let hours = Number(absolute[4])
      const meridiem = absolute[6]?.toUpperCase()
      if (meridiem === "PM" && hours < 12) hours += 12
      if (meridiem === "AM" && hours === 12) hours = 0
      const offset = absolute[7] ? TZ_OFFSET_MINUTES[absolute[7].toUpperCase()] : undefined
      const at =
        offset === undefined
          ? new Date(year, month, Number(absolute[2]), hours, Number(absolute[5])).getTime()
          : Date.UTC(year, month, Number(absolute[2]), hours, Number(absolute[5])) - offset * 60_000
      if (!Number.isNaN(at)) return { at, raw: absolute[0] }
    }
  }

  const relative =
    /(?:reset[s]?|try again|retry)\s+(?:in|after)\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(
      text,
    )
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const ms =
      Number(relative[1] ?? 0) * 86_400_000 + Number(relative[2] ?? 0) * 3_600_000 + Number(relative[3] ?? 0) * 60_000
    if (ms > 0) return { at: Date.now() + ms, raw: relative[0] }
  }

  return { at: null, raw: null }
}

/**
 * Inspect a provider response after it comes back from the wire: bump the daily counter on
 * success, record the block with its parsed reset horizon on 429/403. The response itself is
 * returned untouched, so the caller's handling (retry schedule, error mapping) is unchanged.
 */
export async function observe(key: string, res: Response): Promise<Response> {
  if (res.ok) {
    bump(key)
    return res
  }
  const status = res.status
  if (status !== 429 && status !== 403) return res
  let text: string | undefined
  try {
    text = await res.clone().text()
  } catch {
    text = undefined
  }
  const parsed = parseReset(text, res.headers)
  block(key, { until: parsed.at, raw: parsed.raw, status, error: (text ?? "").slice(0, 400) })
  return res
}
