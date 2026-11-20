// The server's own pages (Decision S8): setup, login and notices, in the KRNL0
// look (designs "Setup" and "PhoneLogin"). Still no scripts at all: the CSP is
// script-src 'self' and these pages need none. Styles are inline (allowed);
// fonts and pictures come from the server itself (/_k0/, public before login).
// One responsive page: phone first, a side panel from 960 px.

import { htmlEscape } from './util.js'

/** What the side panel and the footer say about this server. */
export interface PageFacts {
  /** host[:port] the browser used. */
  host: string
  /** 'self-signed' | 'files' | 'proxy' … */
  encryption: string
  /** The CA fingerprint (self-signed), or null. */
  fingerprint: string | null
  website: boolean
  appSync: boolean
}

const NO_FACTS: PageFacts = { host: '', encryption: '', fingerprint: null, website: true, appSync: true }

const shortFp = (fp: string): string => {
  const p = fp.split(':')
  return p.length > 8 ? `${p.slice(0, 4).join(':')} … ${p.slice(-4).join(':')}` : fp
}

const ICON = {
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="stroke-width:3"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
}

const CSS = `
@font-face{font-family:'JetBrains Mono';font-weight:400;font-display:swap;src:url(/_k0/jbm-400.woff2) format('woff2')}
@font-face{font-family:'JetBrains Mono';font-weight:600;font-display:swap;src:url(/_k0/jbm-600.woff2) format('woff2')}
@font-face{font-family:'JetBrains Mono';font-weight:700;font-display:swap;src:url(/_k0/jbm-700.woff2) format('woff2')}
@font-face{font-family:'Instrument Serif';font-weight:400;font-display:swap;src:url(/_k0/serif-400.woff2) format('woff2')}
:root{--bg:#131210;--side:#0e0d0b;--win:#1a1915;--win-2:#211f1a;--edge:#2a2823;--edge-2:#36332c;--ink:#f4efe2;--ink-2:#ddd6c6;--ink-3:#b3aa94;--acid:#c9f158;--acid-ink:#0a0908;--rust:#ee8466;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--serif:'Instrument Serif',Georgia,serif;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font-family:var(--mono);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
body{min-height:100dvh;display:flex}
svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
::selection{background:var(--acid);color:var(--acid-ink)}
a{color:inherit}
.side{display:none}
.main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;padding:max(28px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(28px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}
.col{width:100%;max-width:460px;margin:0 auto;flex:1 1 auto;display:flex;flex-direction:column;gap:20px}
.cube{display:block;width:220px;height:220px;margin:-8px auto -18px;-webkit-mask-image:radial-gradient(closest-side,#000 62%,transparent 100%);mask-image:radial-gradient(closest-side,#000 62%,transparent 100%)}
.chip{align-self:flex-start;height:28px;padding:0 12px;border-radius:999px;background:var(--win-2);border:1px solid var(--edge);display:inline-flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink-2);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dot{width:7px;height:7px;border-radius:999px;background:var(--acid);flex-shrink:0}
h1{margin:0;font-family:var(--serif);font-weight:400;font-size:clamp(38px,9vw,52px);line-height:1;letter-spacing:-.01em}
.lead{margin:0;font-size:14px;line-height:1.6;color:var(--ink-3)}
.lead b{color:var(--ink-2);font-weight:600}
form{display:flex;flex-direction:column;gap:16px}
label{display:flex;flex-direction:column;gap:8px}
.cap{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.cap i{font-style:normal;text-transform:none;letter-spacing:0;font-weight:400}
input{width:100%;height:52px;padding:0 16px;border-radius:10px;border:1px solid var(--edge-2);background:var(--win);color:var(--ink);font:400 16px/1 var(--mono);outline:none;transition:border-color 140ms}
input:focus{border-color:var(--acid);box-shadow:0 0 0 3px rgba(201,241,88,.15)}
input.code{letter-spacing:.18em;text-transform:uppercase}
input.otp{letter-spacing:.32em}
.go{height:56px;border:0;border-radius:10px;background:var(--acid);color:var(--acid-ink);font:700 13px/1 var(--mono);letter-spacing:.14em;cursor:pointer;margin-top:4px}
.go:hover{background:#d8ff6e}
.go:active{transform:translateY(1px)}
.go:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--rust);outline-offset:2px}
.alert{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;border:1px solid var(--rust);background:rgba(238,132,102,.1);font-size:13px;line-height:1.5;color:var(--ink)}
.alert::before{content:'';width:8px;height:8px;margin-top:6px;border-radius:999px;background:var(--rust);flex-shrink:0}
.help{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
details{border:1px solid var(--edge-2);border-radius:10px;background:var(--win-2)}
details[open]{grid-column:1/-1}
summary{list-style:none;min-height:44px;padding:0 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;font-size:12.5px;color:var(--ink)}
summary::-webkit-details-marker{display:none}
details[open] summary svg{transform:rotate(90deg)}
details p{margin:0;padding:0 14px 14px;font-size:12.5px;line-height:1.6;color:var(--ink-3)}
code{font-family:var(--mono);color:var(--acid);background:var(--win);border:1px solid var(--edge);border-radius:6px;padding:1px 6px;white-space:nowrap}
.body{display:flex;flex-direction:column;gap:20px}
.foot{margin-top:auto;padding-top:16px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:11.5px;color:var(--ink-3);text-align:center}
.steps{list-style:none;margin:0;padding:0;display:flex;gap:8px}
.steps li{flex:1 1 0;display:flex;flex-direction:column;gap:8px;font-size:11px;color:var(--ink-3);min-width:0}
.steps li span{height:4px;border-radius:999px;background:var(--edge-2)}
.steps li.done{color:var(--ink-2)}.steps li.done span{background:var(--acid)}
.steps li.now{color:var(--ink)}.steps li.now span{background:linear-gradient(90deg,var(--acid) 50%,var(--edge-2) 50%)}
.steps em{font-style:normal;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.facts{display:grid;grid-template-columns:110px minmax(0,1fr);row-gap:8px;font-size:12px}
.facts dt{color:var(--ink-3)}.facts dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mark{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;letter-spacing:.04em}
.mark img{width:28px;height:28px;border-radius:7px}
.phone-mark{display:flex}
@media (min-width:960px){
  .side{display:flex;width:clamp(420px,39vw,560px);flex-shrink:0;flex-direction:column;justify-content:space-between;gap:24px;padding:40px 48px;background:var(--side);border-right:1px solid var(--edge)}
  .side .cube{width:min(340px,100%);height:auto;aspect-ratio:1;margin:0 auto}
  .side .tag{margin:0;font-family:var(--serif);font-size:36px;line-height:1.08;text-align:center}
  .main{padding:40px 64px}
  .col{max-width:520px}
  .body{flex:1 1 auto;justify-content:center;padding:24px 0}
  .main .cube,.phone-mark{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

function page(title: string, body: string, facts: PageFacts = NO_FACTS, opts: { steps?: string } = {}): string {
  const fp = facts.fingerprint ? shortFp(facts.fingerprint) : null
  const enc = facts.encryption ? `on · ${htmlEscape(facts.encryption)}` : 'on'
  const side = `<aside class="side" aria-hidden="true">
<div class="mark"><img src="/_k0/icon.webp" alt="">KRNL0 server</div>
<div style="display:flex;flex-direction:column;align-items:center;gap:28px"><img class="cube" src="/_k0/cube.webp" alt=""><p class="tag">Your board, on a machine you own.</p></div>
<dl class="facts" style="margin:0">${facts.host ? `<dt>Address</dt><dd>https://${htmlEscape(facts.host)}</dd>` : ''}<dt>Encryption</dt><dd>${enc}</dd>${fp ? `<dt>Fingerprint</dt><dd>${htmlEscape(fp)}</dd>` : ''}<dt>Serves</dt><dd>${[facts.website ? 'website' : '', facts.appSync ? 'app sync' : ''].filter(Boolean).join(' · ') || 'nothing yet'}</dd></dl>
</aside>`
  const foot = `<p class="foot">${ICON.lock}<span>Encrypted${fp ? ` · ${htmlEscape(fp)}` : ''}</span></p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#131210">
<link rel="icon" href="/_k0/icon.webp" type="image/webp">
<title>${htmlEscape(title)} · KRNL0</title>
<style>${CSS}</style>
</head>
<body>
${side}
<main class="main">
<div class="col">
${opts.steps ?? ''}
<div class="phone-mark mark"><img src="/_k0/icon.webp" alt="">KRNL0 server</div>
<div class="body">
${body}
</div>
${foot}
</div>
</main>
</body>
</html>
`
}

const err = (e?: string): string => (e ? `<div class="alert" role="alert">${htmlEscape(e)}</div>` : '')

const steps = (now: number): string => {
  const names = ['Server running', 'Owner account', 'Open your board']
  return `<ol class="steps" aria-label="Setup steps">${names.map((n, i) => {
    const cls = i < now ? 'done' : i === now ? 'now' : ''
    return `<li class="${cls}"${i === now ? ' aria-current="step"' : ''}><span></span><em>${i < now ? ICON.check : ''}${htmlEscape(n)}</em></li>`
  }).join('')}</ol>`
}

export function setupPage(error?: string, facts: PageFacts = NO_FACTS): string {
  return page('Set up your KRNL0 server', `<img class="cube" src="/_k0/cube.webp" alt="">
<div style="display:flex;flex-direction:column;gap:12px">
<h1>Create the owner account</h1>
<p class="lead">Type the <b>setup code</b> the server printed when it started, then choose a password of at least 12 characters. Lost the code? Run <code>krnl0 setup</code> on the server.</p>
</div>
${err(error)}
<form method="post" action="/setup">
<label><span class="cap">Setup code</span><input class="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XX" required></label>
<label><span class="cap">Password <i>· 12 characters or more</i></span><input name="password" type="password" autocomplete="new-password" minlength="12" required></label>
<label><span class="cap">Repeat password</span><input name="password2" type="password" autocomplete="new-password" minlength="12" required></label>
<button class="go" type="submit">CREATE ACCOUNT</button>
</form>`, facts, { steps: steps(1) })
}

export function loginPage(error?: string, facts: PageFacts = NO_FACTS): string {
  return page('Log in to KRNL0', `<img class="cube" src="/_k0/cube.webp" alt="">
<div style="display:flex;flex-direction:column;gap:10px">
${facts.host ? `<span class="chip"><span class="dot"></span>${htmlEscape(facts.host)}</span>` : ''}
<h1>Welcome back.</h1>
<p class="lead">Log in to open your board.</p>
</div>
${err(error)}
<form method="post" action="/login">
<label><span class="cap">Password</span><input name="password" type="password" autocomplete="current-password" required autofocus></label>
<label><span class="cap">Code from your authenticator <i>· only if 2FA is on</i></span><input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" spellcheck="false"></label>
<button class="go" type="submit">LOG IN</button>
</form>
<div class="help">
<details><summary>Recovery code${ICON.chevron}</summary><p>No phone at hand? Type one of your recovery codes in the code field instead of the six digits. Each code works once.</p></details>
<details><summary>Forgot password${ICON.chevron}</summary><p>On the server, run <code>krnl0 reset-password</code> and choose a new one. Your boards stay as they are.</p></details>
</div>`, facts)
}

export function noticePage(title: string, text: string, facts: PageFacts = NO_FACTS): string {
  return page(title, `<img class="cube" src="/_k0/cube.webp" alt="">
<div style="display:flex;flex-direction:column;gap:12px"><h1>${htmlEscape(title)}</h1><p class="lead">${htmlEscape(text)}</p></div>`, facts)
}

export function homeWithoutWebBuild(facts: PageFacts = NO_FACTS): string {
  return page('KRNL0 server is running', `<img class="cube" src="/_k0/cube.webp" alt="">
<div style="display:flex;flex-direction:column;gap:12px">
<h1>The server is running</h1>
<p class="lead">You are logged in. The KRNL0 web app is not installed on this server yet; the Docker image and the Linux bundle include it.</p>
<p class="lead">The desktop app can already sync through this server: click <b>connect server</b> in its top bar.</p>
</div>
<form method="post" action="/logout"><button class="go" type="submit">LOG OUT</button></form>`, facts)
}
