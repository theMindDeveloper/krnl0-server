// Plain, unstyled pages (Decision S8): they work, and they are replaced by the
// designed pages once the owner has picked a draft. No scripts, no styles.

import { htmlEscape } from './util.js'

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${htmlEscape(title)} · KRNL0</title>
</head>
<body>
<main>
<h1>${htmlEscape(title)}</h1>
${body}
</main>
</body>
</html>
`
}

const err = (e?: string): string => (e ? `<p role="alert"><strong>${htmlEscape(e)}</strong></p>` : '')

export function setupPage(error?: string): string {
  return page('Set up your KRNL0 server', `${err(error)}
<p>Enter the setup code from the server's log or terminal, then choose a password (at least 12 characters).</p>
<form method="post" action="/setup">
<p><label>Setup code<br><input name="code" autocomplete="one-time-code" autocapitalize="characters" required></label></p>
<p><label>Password<br><input name="password" type="password" autocomplete="new-password" minlength="12" required></label></p>
<p><label>Repeat password<br><input name="password2" type="password" autocomplete="new-password" minlength="12" required></label></p>
<p><button type="submit">Create the owner account</button></p>
</form>`)
}

export function loginPage(error?: string): string {
  return page('Log in to KRNL0', `${err(error)}
<form method="post" action="/login">
<p><label>Password<br><input name="password" type="password" autocomplete="current-password" required></label></p>
<p><label>Two-factor code (only if you turned it on)<br><input name="code" inputmode="numeric" autocomplete="one-time-code"></label></p>
<p><button type="submit">Log in</button></p>
</form>`)
}

export function noticePage(title: string, text: string): string {
  return page(title, `<p>${htmlEscape(text)}</p>`)
}

export function homeWithoutWebBuild(): string {
  return page('KRNL0 server is running', `<p>You are logged in. The KRNL0 web app is not installed on this server yet.</p>
<p>The desktop app can already sync through this server (Settings, Sync).</p>
<form method="post" action="/logout"><p><button type="submit">Log out</button></p></form>`)
}
