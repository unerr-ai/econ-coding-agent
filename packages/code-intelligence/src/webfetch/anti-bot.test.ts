/**
 * Unit tests for bot-challenge / block-page detection — no network calls.
 * Fixtures cover the Cloudflare / hCaptcha / PerimeterX / generic-403
 * markers plus the negative cases (ordinary markup, a page that merely
 * mentions Cloudflare in body text).
 */

import { describe, it, expect } from "bun:test"
import { detectChallenge } from "./anti-bot.js"

describe("detectChallenge", () => {
  it("returns null for empty html", () => {
    expect(detectChallenge("")).toBeNull()
  })

  it("returns null for ordinary article markup", () => {
    const html = "<!doctype html><html><body><article><h1>Title</h1><p>Body text.</p></article></body></html>"
    expect(detectChallenge(html)).toBeNull()
  })

  it("detects the Cloudflare interstitial title", () => {
    const html = "<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>"
    const result = detectChallenge(html)
    expect(result?.kind).toBe("cloudflare")
    expect(result?.suggestion).toMatch(/ECON_WEBFETCH_BROWSER/i)
  })

  it("detects the Cloudflare cf_chl_opt token", () => {
    const html = "<html><script>window.cf_chl_opt = {};</script></html>"
    expect(detectChallenge(html)?.kind).toBe("cloudflare")
  })

  it("detects the Cloudflare browser-verification class", () => {
    const html = '<html><body class="cf-browser-verification"></body></html>'
    expect(detectChallenge(html)?.kind).toBe("cloudflare")
  })

  it("detects the Cloudflare 'Enable JavaScript and cookies' notice", () => {
    const html = "<html><body><p>Enable JavaScript and cookies to continue</p></body></html>"
    expect(detectChallenge(html)?.kind).toBe("cloudflare")
  })

  it("detects hCaptcha embeds", () => {
    const html = '<html><body><div class="h-captcha" data-sitekey="abc"></div></body></html>'
    expect(detectChallenge(html)?.kind).toBe("hcaptcha")
  })

  it("detects PerimeterX challenge markers", () => {
    const html = '<html><script>window._pxAppId = "PX123";</script></html>'
    expect(detectChallenge(html)?.kind).toBe("perimeterx")
  })

  it("does not flag pages that merely mention Cloudflare in body text", () => {
    const html = "<html><body><p>We use Cloudflare for our CDN.</p></body></html>"
    expect(detectChallenge(html)).toBeNull()
  })

  it("detects a generic 403 block page paired with block-page wording", () => {
    const html = "<html><body><h1>Access Denied</h1><p>You have been blocked.</p></body></html>"
    const result = detectChallenge(html, 403)
    expect(result?.kind).toBe("generic")
  })

  it("does not flag generic block wording without a 403 status", () => {
    const html = "<html><body><h1>Access Denied</h1></body></html>"
    expect(detectChallenge(html, 200)).toBeNull()
    expect(detectChallenge(html)).toBeNull()
  })
})
