# Encryption and certificates

**Every connection to your KRNL0 server is encrypted.** The only choice is whether your browser already *recognises* the certificate. Nothing here is required; pick what fits and change it any time (`krnl0 setup`, or `krnl0 config set tls.mode <mode>` and restart).

| You want | Choose | Effort |
|---|---|---|
| To get going now | **Nothing** (`self-signed`, the default) | none |
| No browser warnings at home | Install the server's certificate on each device | 1–2 minutes per device |
| No warnings anywhere, also away from home | **Tailscale** (`files`) | install Tailscale on server and devices |
| Your own domain | Compose `domain` profile (Caddy) | a domain, ports 80/443 reachable from the internet |
| You already run a reverse proxy | `proxy` | point your proxy at KRNL0 |

## Nothing to set up (self-signed)

The server makes its own small certificate authority on first start.

- **Desktop app:** no warning at all. When you pair, it shows a fingerprint. Compare it once with `krnl0 fingerprint` on the server (Docker: `docker exec krnl0 krnl0 fingerprint`). From then on the app trusts only your server.
- **Browser:** the first visit on each device shows "Your connection is not private". Click **Advanced → Continue**. The connection is still encrypted; the browser just does not know who made the certificate.
- **Docker:** set `KRNL0_HOSTS` to the address you open (e.g. `192.168.1.20`), so the certificate names it.

What needs a recognised certificate: adding KRNL0 to a phone's home screen and reminders while the tab is closed. For those, use one of the options below.

## Install the server's certificate on a device

Open `https://<your server>:8443/ca.crt` on the device (click past the warning once) and:

- **Windows:** open the file → *Install Certificate* → *Current User* → *Place all certificates in the following store* → *Trusted Root Certification Authorities* → Finish.
- **macOS:** open the file → Keychain Access adds it → double-click "KRNL0 server CA" → *Trust* → *Always Trust*.
- **iPhone / iPad:** open the link in Safari → *Allow* → Settings → *Profile Downloaded* → Install. Then Settings → General → About → *Certificate Trust Settings* → switch on "KRNL0 server CA".
- **Android:** Settings → Security → *Encryption & credentials* → *Install a certificate* → *CA certificate* → pick the file.
- **Linux:** `sudo cp krnl0-server-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` (Firefox: Settings → Certificates → Import).

Check before installing: `krnl0 fingerprint` on the server must equal the certificate's SHA-256 fingerprint on the device. This certificate can only vouch for names your server chose; still, install it only on your own devices.

## Tailscale (recommended for phones)

1. Install Tailscale on the server and your devices, log in on each.
2. On the server: `tailscale cert <machine>.<tailnet>.ts.net` writes a `.crt` and a `.key`.
3. `krnl0 config set tls.mode files`, `krnl0 config set tls.certFile /path/<machine>.<tailnet>.ts.net.crt`, `krnl0 config set tls.keyFile /path/<…>.key`, restart.
4. Open `https://<machine>.<tailnet>.ts.net:8443` from any device in your tailnet: no warnings, works away from home, no router ports opened.

Renew with `tailscale cert` (e.g. a monthly timer); KRNL0 picks up new files within an hour. Privacy note: Tailscale's coordination service sees which devices you have, not your data (traffic is end-to-end encrypted between your devices).

Docker: mount the two files read-only and set `KRNL0_TLS=files`, `KRNL0_CERT_FILE`, `KRNL0_KEY_FILE`.

## Your own domain (Caddy)

With `KRNL0_DOMAIN=krnl0.example.com` in `.env` and the domain pointing at your server (ports 80 and 443 reachable):

```
docker compose --profile domain up -d
```

Caddy gets and renews a Let's Encrypt certificate and forwards to KRNL0 over HTTPS, trusting only KRNL0's own certificate authority. Also set `KRNL0_TRUST_PROXY=on` and `KRNL0_PUBLISH_PORT=127.0.0.1:8443` so only Caddy reaches KRNL0. Using Let's Encrypt means accepting its Subscriber Agreement.

## Your own reverse proxy

`krnl0 config set tls.mode proxy` and `krnl0 config set trustProxy on`. KRNL0 listens on plain HTTP on `127.0.0.1:8443`; your proxy must terminate HTTPS, keep the `Host` header, and set `X-Forwarded-For` / `X-Forwarded-Proto`. Do not expose that port to anything but the proxy.
