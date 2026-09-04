#!/usr/bin/env node
/**
 * Capture reusable speakasm UI screenshots into docs/screenshots.
 *
 * Usage:
 *   node capture.mjs [--url URL] [--out DIR] [--ready-ms N] [--no-demo]
 *
 * Env:
 *   SPEAKASM_URL       default http://127.0.0.1:8080
 *   SPEAKASM_SHOT_OUT  default <repo>/docs/screenshots
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const DEFAULT_URL = process.env.SPEAKASM_URL || 'http://127.0.0.1:8080'
const DEFAULT_OUT = process.env.SPEAKASM_SHOT_OUT || path.join(ROOT, 'docs/screenshots')
const DEMO_TEXT =
  'speakasm runs Kokoro offline in your browser. Paste a chapter, drop an EPUB, or open a DOCX. Nothing leaves the machine.'

/** @typedef {{ name: string, width: number, height: number, deviceScaleFactor?: number, isMobile?: boolean }} Shot */

/** @type {Shot[]} */
const SHOTS = [
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
]

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ url: string, out: string, readyMs: number, demo: boolean }} */
  const opts = {
    url: DEFAULT_URL,
    out: DEFAULT_OUT,
    readyMs: 90_000,
    demo: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') opts.url = argv[++i]
    else if (a === '--out') opts.out = path.resolve(argv[++i])
    else if (a === '--ready-ms') opts.readyMs = Number(argv[++i])
    else if (a === '--no-demo') opts.demo = false
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: node capture.mjs [--url URL] [--out DIR] [--ready-ms N] [--no-demo]
Defaults: url=${DEFAULT_URL} out=${DEFAULT_OUT}`)
      process.exit(0)
    } else {
      throw new Error(`unknown arg: ${a}`)
    }
  }
  if (!Number.isFinite(opts.readyMs) || opts.readyMs < 0) {
    throw new Error('--ready-ms must be a non-negative number')
  }
  return opts
}

/**
 * @param {import('playwright').Page} page
 * @param {number} readyMs
 */
async function waitForShell(page, readyMs) {
  await page.waitForSelector('.brand', { state: 'visible', timeout: 30_000 })
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready
  })
  try {
    await page.waitForFunction(
      () => {
        const status = document.getElementById('status')
        const text = status?.textContent || ''
        return /ready when you are/i.test(text) || /caching offline/i.test(text)
      },
      { timeout: readyMs },
    )
  } catch {
    console.warn('engine not ready within timeout, capturing shell UI anyway')
  }
}

/**
 * Freeze a calm ready line so mid-cache counters do not land in README shots.
 * @param {import('playwright').Page} page
 */
async function settleStatus(page) {
  await page.evaluate(() => {
    const status = document.getElementById('status')
    if (!status) return
    const freeze = 'Ready when you are.'
    status.textContent = freeze
    status.classList.add('is-ok')
    const spinner = document.getElementById('spinner')
    if (spinner) spinner.hidden = true
    const obs = new MutationObserver(() => {
      if (status.textContent !== freeze) status.textContent = freeze
      if (!status.classList.contains('is-ok')) status.classList.add('is-ok')
      if (spinner && !spinner.hidden) spinner.hidden = true
    })
    obs.observe(status, { childList: true, characterData: true, subtree: true, attributes: true })
  })
  await sleep(150)
}

/**
 * @param {import('playwright').Page} page
 * @param {string} text
 */
async function seedDemo(page, text) {
  await page.evaluate((demo) => {
    const input = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('input'))
    if (!input) return
    input.value = demo
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
  await sleep(200)
}

/**
 * @param {import('playwright').Browser} browser
 * @param {Shot} shot
 * @param {string} outDir
 * @param {{ demo: boolean, readyMs: number, url: string }} opts
 */
async function captureOne(browser, shot, outDir, opts) {
  const context = await browser.newContext({
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    deviceScaleFactor: shot.deviceScaleFactor ?? 2,
    locale: 'en-US',
    viewport: { width: shot.width, height: shot.height },
    isMobile: Boolean(shot.isMobile),
    hasTouch: Boolean(shot.isMobile),
  })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)

  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitForShell(page, opts.readyMs)
    if (opts.demo) await seedDemo(page, DEMO_TEXT)
    await settleStatus(page)

    const file = path.join(outDir, `${shot.name}.png`)
    await page.screenshot({
      path: file,
      type: 'png',
      fullPage: false,
      animations: 'disabled',
    })
    console.log(`wrote ${path.relative(ROOT, file)} (${shot.width}x${shot.height})`)
    return file
  } finally {
    await context.close()
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  await mkdir(opts.out, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    /** @type {string[]} */
    const written = []
    for (const shot of SHOTS) {
      written.push(await captureOne(browser, shot, opts.out, opts))
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      url: opts.url,
      files: written.map((f) => path.relative(ROOT, f)),
    }
    const manifestPath = path.join(opts.out, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`wrote ${path.relative(ROOT, manifestPath)}`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
