import z from "schemastery";
import { Service } from "@deepseek-ai/cordis";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
/**
* Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
* per-namespace sections; plugins register a namespace schema and read the
* resolved value, which layers schema defaults, the registrant's composition
* `base`, and the user document section, in that order.
* @module @deepseek-ai/dsh-settings
*/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link SettingsNamespace}.
* @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
* @returns the branded namespace.
*/
function settingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}
Service.init;
//#endregion
//#region src/pairing.ts
/**
* Pairing state machine for dsh-tunnelmux-remote: one active one-time token,
* a device-session table, and presence tracking. Pure TypeScript with
* injected clock/randomness so the whole security semantics are unit-testable
* without cordis or a network.
*
* Security invariants:
* - One active token at a time; issue() replaces it, so a refreshed QR
*   immediately invalidates the previous link.
* - A token is consumed by the first successful accept() — reuse is refused
*   with 'used'.
* - Tokens expire; accept() on an expired token is refused like an unknown
*   one (no oracle for validity).
* - stop() revokes every device session and clears the token, so paired
*   devices are cut off on their next gated request.
*/
/** Thrown by issue() for an address outside the sampled LAN literals. */
var UnknownLanAddressError = class extends Error {
	constructor(address) {
		super(`tunnelmux-remote: unknown LAN address ${JSON.stringify(address)}`);
		this.name = "UnknownLanAddressError";
	}
};
/** Real clock/entropy: 32 random hex chars per token. */
const defaultClock = {
	now: () => Date.now(),
	randomToken: () => {
		const bytes = /* @__PURE__ */ new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	}
};
/**
* The pairing state machine. All mutations notify state listeners after the
* commit point that makes them true, and notification dedupes against the
* last emitted snapshot.
*/
var PairingService = class {
	config;
	clock;
	tokens = /* @__PURE__ */ new Map();
	devices = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	lastEmitted;
	stopped = false;
	tokenSerial = 0;
	/** LAN base URLs keyed by the advertised IP literal (interface order). */
	lanBases = /* @__PURE__ */ new Map();
	/** Public (tunneled) base URL, e.g. a TunnelMux quick URL. */
	publicBase;
	/** Auto-tunnel status frame while the auto-tunnel feature is active. */
	tunnelStatus;
	constructor(config, clock = defaultClock) {
		this.config = config;
		this.clock = clock;
	}
	/** The device cookie name from the active config. */
	get cookieName() {
		return this.config.cookieName;
	}
	/** The default LAN base URL (first interface; undefined when not reachable). */
	get lanBaseUrl() {
		return this.lanBases.values().next().value;
	}
	/** The LAN base URL for one specific literal. */
	lanBaseUrlFor(address) {
		return this.lanBases.get(address);
	}
	/** LAN IP literals QR links can be built from (interface order). */
	get lanAddresses() {
		return [...this.lanBases.keys()];
	}
	/** Configure the LAN base URLs once the server bind is known. */
	setLanBases(entries) {
		this.lanBases = new Map(entries.map((e) => [e.address, e.base]));
		this.notify();
	}
	get publicBaseUrl() {
		return this.publicBase;
	}
	setPublicBaseUrl(url) {
		this.publicBase = url;
		this.notify();
	}
	setTunnelStatus(status) {
		this.tunnelStatus = status;
		this.notify();
	}
	/**
	* Issue a fresh token, replacing (invalidating) any previous one. A stopped
	* service re-arms through this call.
	* @throws {Error} when no reachable base exists.
	*/
	issue(workspaceId, address) {
		if (this.lanBases.size === 0 && this.publicBase === void 0) throw new Error("tunnelmux-remote: pairing requires a reachable bind (--host 0.0.0.0 or publicBaseUrl)");
		if (address !== void 0 && !this.lanBases.has(address)) throw new UnknownLanAddressError(address);
		const now = this.clock.now();
		const token = this.clock.randomToken();
		this.tokens.clear();
		this.stopped = false;
		this.tokenSerial += 1;
		this.tokens.set(token, {
			id: `t${this.tokenSerial}`,
			issuedAt: now,
			expiresAt: now + this.config.tokenTtlMs,
			consumed: false,
			...workspaceId !== void 0 ? { workspaceId } : {},
			...address !== void 0 ? { address } : {}
		});
		this.notify();
		return {
			token,
			expiresAt: now + this.config.tokenTtlMs
		};
	}
	/**
	* Consume a token and bind a device session. One-time.
	* @returns the new device id, or a refusal code.
	*/
	accept(token) {
		const record = this.tokens.get(token);
		if (record === void 0 || record.consumed || this.stopped || this.clock.now() > record.expiresAt) return {
			ok: false,
			code: record?.consumed === true ? "used" : "invalid"
		};
		record.consumed = true;
		const deviceId = this.clock.randomToken();
		const now = this.clock.now();
		if (this.devices.size >= this.config.maxDevices) {
			let oldest;
			for (const [id, session] of this.devices) if (oldest === void 0 || session.createdAt < oldest.createdAt) oldest = {
				id,
				createdAt: session.createdAt
			};
			if (oldest !== void 0) this.devices.delete(oldest.id);
		}
		this.devices.set(deviceId, {
			createdAt: now,
			lastSeenAt: now
		});
		this.notify();
		return {
			ok: true,
			deviceId
		};
	}
	/** Stop remote control: revoke every session and clear the token. */
	stop() {
		this.tokens.clear();
		this.devices.clear();
		this.stopped = true;
		this.notify();
	}
	/** Record activity for a device id and report whether the request may proceed. */
	touchDevice(deviceId) {
		const session = this.devices.get(deviceId);
		if (session === void 0 || this.stopped) return false;
		session.lastSeenAt = this.clock.now();
		this.notify();
		return true;
	}
	/** Explicit presence heartbeat. */
	heartbeat(deviceId) {
		return this.touchDevice(deviceId);
	}
	/** Whether a cookie value names a currently live device session. */
	hasDevice(deviceId) {
		return this.devices.get(deviceId) !== void 0 && !this.stopped;
	}
	/** Periodic sweep: re-evaluate the derived snapshot (devices aging offline). */
	sweep() {
		this.notify();
	}
	/** The current snapshot (fresh object per call). */
	snapshot() {
		const now = this.clock.now();
		const onlineCount = [...this.devices.values()].filter((s) => this.isOnlineAt(s, now)).length;
		const token = this.activeToken();
		return {
			phase: this.derivePhase(onlineCount, token !== void 0),
			lanAvailable: this.lanBases.size > 0,
			lanAddresses: [...this.lanBases.keys()],
			...this.publicBase !== void 0 ? { publicUrl: this.publicBase } : {},
			...this.tunnelStatus !== void 0 ? { tunnel: this.tunnelStatus } : {},
			...token !== void 0 ? {
				tokenId: token.record.id,
				tokenExpiresAt: token.record.expiresAt
			} : {},
			deviceCount: this.devices.size,
			onlineCount
		};
	}
	/** Subscribe to snapshot changes (each emit passes a fresh snapshot). */
	onState(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	activeToken() {
		for (const [token, record] of this.tokens) {
			if (this.stopped) return void 0;
			if (this.clock.now() > record.expiresAt) continue;
			return {
				token,
				record
			};
		}
	}
	derivePhase(onlineCount, hasToken) {
		if (this.lanBases.size === 0 && this.publicBase === void 0) return "lan-required";
		if (this.stopped) return "stopped";
		if (onlineCount > 0) return "connected";
		if (this.devices.size > 0) return "disconnected";
		if (hasToken) return "waiting";
		return "stopped";
	}
	isOnlineAt(session, now) {
		return now - session.lastSeenAt <= this.config.offlineAfterMs;
	}
	notify() {
		const snapshot = this.snapshot();
		if (this.lastEmitted !== void 0 && snapshotsEqual(this.lastEmitted, snapshot)) return;
		this.lastEmitted = snapshot;
		for (const listener of this.listeners) try {
			listener(snapshot);
		} catch (error) {
			console.error("tunnelmux-remote: pairing state listener failed", error);
		}
	}
};
/** Structural equality over the JSON-safe snapshot fields. */
function snapshotsEqual(a, b) {
	if (a.phase !== b.phase || a.lanAvailable !== b.lanAvailable) return false;
	if (a.publicUrl !== b.publicUrl || a.tokenId !== b.tokenId || a.tokenExpiresAt !== b.tokenExpiresAt) return false;
	if (a.deviceCount !== b.deviceCount || a.onlineCount !== b.onlineCount) return false;
	if (a.lanAddresses.length !== b.lanAddresses.length) return false;
	for (let i = 0; i < a.lanAddresses.length; i += 1) if (a.lanAddresses[i] !== b.lanAddresses[i]) return false;
	if (a.tunnel?.state !== b.tunnel?.state || a.tunnel?.url !== b.tunnel?.url || a.tunnel?.error !== b.tunnel?.error) return false;
	return true;
}
//#endregion
//#region src/tunnelmux.ts
/** Real fetch-based client for the TunnelMux control API. */
function createTunnelMuxHttpClient(baseUrl, apiToken) {
	return { async request(path, init = {}) {
		const headers = {
			"content-type": "application/json",
			...init.headers
		};
		if (apiToken) headers.authorization = `Bearer ${apiToken}`;
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
			method: init.method ?? "GET",
			headers,
			body: init.body !== void 0 ? JSON.stringify(init.body) : void 0
		});
		return {
			ok: response.ok,
			status: response.status,
			json: () => response.json(),
			text: () => response.text()
		};
	} };
}
/**
* Owns the lifecycle of one TunnelMux-managed tunnel. All timers and the HTTP
* client are injectable for unit tests without a daemon.
*/
var TunnelMuxTunnelManager = class {
	client;
	tunnelId;
	provider;
	targetUrl;
	autoRestart;
	pollMs;
	startTimeoutMs;
	phase = "stopped";
	url;
	error;
	daemonOk;
	raw;
	pollTimer;
	disposed = false;
	listeners = /* @__PURE__ */ new Set();
	constructor(client, options = {}) {
		this.client = client;
		this.tunnelId = options.tunnelId ?? "dsh-remote";
		this.provider = options.provider ?? "cloudflared";
		this.targetUrl = options.targetUrl ?? "http://127.0.0.1:3080";
		this.autoRestart = options.autoRestart ?? true;
		this.pollMs = options.pollMs ?? 5e3;
		this.startTimeoutMs = options.startTimeoutMs ?? 3e4;
	}
	get info() {
		return {
			phase: this.phase,
			...this.url !== void 0 ? { url: this.url } : {},
			...this.error !== void 0 ? { error: this.error } : {},
			...this.daemonOk !== void 0 ? { daemonOk: this.daemonOk } : {},
			...this.raw !== void 0 ? { raw: this.raw } : {}
		};
	}
	/** Subscribe to status-frame changes. */
	onStatus(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** Start (or keep) the TunnelMux-managed tunnel toward the target URL. */
	async start() {
		if (this.phase === "starting" || this.phase === "running") return this.info;
		this.phase = "starting";
		this.error = void 0;
		this.emit();
		try {
			const health = await this.client.request("/v1/health");
			this.daemonOk = health.ok;
			if (!health.ok) {
				this.fail("tunnelmux daemon unreachable: check that tunnelmuxd is running on the control port");
				return this.info;
			}
			const response = await this.client.request("/v1/tunnel/start", {
				method: "POST",
				body: {
					tunnel_id: this.tunnelId,
					provider: this.provider,
					target_url: this.targetUrl,
					auto_restart: this.autoRestart
				}
			});
			if (!response.ok) {
				const text = await response.text();
				this.fail(`tunnel start failed (${response.status}): ${text}`);
				return this.info;
			}
			const payload = await response.json();
			const tunnel = payload.tunnel ?? payload;
			this.raw = tunnel;
			const publicUrl = typeof tunnel.public_base_url === "string" ? tunnel.public_base_url : void 0;
			const state = typeof tunnel.state === "string" ? tunnel.state : "running";
			if (publicUrl) {
				this.url = publicUrl;
				this.phase = "running";
			} else if (state === "error") this.fail(typeof tunnel.last_error === "string" ? tunnel.last_error : "tunnel start returned an error state");
			else {
				this.url = void 0;
				this.phase = "starting";
				await this.refreshStatusOnce();
				if (this.phase === "starting") this.fail("timed out waiting for a public tunnel URL");
			}
			this.emit();
		} catch (error) {
			this.daemonOk = false;
			this.fail(error instanceof Error ? `tunnelmux daemon unreachable: ${error.message}` : "tunnelmux daemon unreachable");
		}
		return this.info;
	}
	/** Stop the tunnel for good and clear state. */
	async stop() {
		this.disposePolling();
		try {
			await this.client.request("/v1/tunnel/stop", {
				method: "POST",
				body: { tunnel_id: this.tunnelId }
			});
		} catch {}
		this.phase = "stopped";
		this.url = void 0;
		this.error = void 0;
		this.emit();
	}
	/** Begin periodic status observation (panel presentation only). */
	startPolling() {
		if (this.pollTimer !== void 0) return;
		this.pollTimer = setInterval(() => {
			this.refreshStatusOnce();
		}, this.pollMs);
	}
	dispose() {
		this.disposed = true;
		this.disposePolling();
		this.stop();
	}
	async refreshStatusOnce() {
		if (this.disposed) return;
		try {
			const health = await this.client.request("/v1/health");
			this.daemonOk = health.ok;
			if (!health.ok) {
				this.fail("tunnelmux daemon unreachable");
				return;
			}
			const response = await this.client.request("/v1/tunnel/status");
			if (!response.ok) return;
			const payload = await response.json();
			const tunnel = payload.tunnel ?? payload;
			this.raw = tunnel;
			const state = typeof tunnel.state === "string" ? tunnel.state : void 0;
			const publicUrl = typeof tunnel.public_base_url === "string" ? tunnel.public_base_url : void 0;
			if (state === "running") {
				this.phase = "running";
				if (publicUrl) this.url = publicUrl;
				this.error = void 0;
			} else if (state === "stopped" || state === "idle") {
				this.phase = "stopped";
				this.url = void 0;
				this.error = void 0;
			} else if (state === "error") {
				this.phase = "failed";
				this.error = typeof tunnel.last_error === "string" ? tunnel.last_error : "tunnel in error state";
			} else if (state === "starting") this.phase = "starting";
			this.emit();
		} catch (error) {
			this.daemonOk = false;
			this.fail(error instanceof Error ? `tunnelmux daemon unreachable: ${error.message}` : "tunnelmux daemon unreachable");
		}
	}
	fail(message) {
		this.error = message;
		this.phase = "failed";
		this.emit();
	}
	disposePolling() {
		if (this.pollTimer !== void 0) {
			clearInterval(this.pollTimer);
			this.pollTimer = void 0;
		}
	}
	emit() {
		for (const listener of this.listeners) try {
			listener();
		} catch (error) {
			console.error("tunnelmux-remote: tunnel status listener failed", error);
		}
	}
};
//#endregion
//#region src/desktop-bridge.ts
/**
* Desktop pairing bridge for dsh-tunnelmux-remote.
*
* Port of the standalone `~/.dsh/bin/dsh-web-cookie serve` tool so the plugin
* owns the whole remote-access story: it mints DSH browser-session cookies
* offline (the HMAC secret in $DSH_HOME/.credentials.yaml is persistent, unlike
* the per-launch ?token=), serves a loopback-only pairing page that installs
* them, and upserts the TunnelMux routes that expose the page and the GUI.
*
* Security model (unchanged from the standalone tool): anyone who can reach the
* bridge can obtain a session cookie, so the listener binds 127.0.0.1 only and
* MUST sit behind an access-gated reverse-proxy route (TunnelMux access code).
*
* Cookie format authority: deepseek-harness/packages/client/connection/src/browser-auth.ts
*   name  = "dsh-auth-" + base64url(sha256(authority))
*   value = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
*         + "." + base64url(hmac_sha256(secret, body))
*/
const COOKIE_PREFIX = "dsh-auth-";
/** The credentials record holding the persistent browser-session HMAC secret. */
const BROWSER_SESSION_RECORD = "client-connection/browser-session";
const DAY_MILLISECONDS = 864e5;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
/** base64url without padding, matching browser-auth.ts encodeBase64Url. */
function base64UrlEncode(bytes) {
	return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodeBase64Url(value) {
	if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) throw new Error("malformed base64url value");
	const padding = "=".repeat((4 - value.length % 4) % 4);
	const decoded = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
	if (base64UrlEncode(decoded) !== value) throw new Error("malformed base64url value");
	return decoded;
}
/** The cookie name DSH expects for `authority` ("host:port" of what the server sees). */
function browserSessionCookieName(authority) {
	return COOKIE_PREFIX + base64UrlEncode(createHash("sha256").update(authority).digest());
}
/** Mint one DSH browser-session cookie. `days` must be <= dsh cookieMaxAgeDays (default 30). */
function mintSessionCookie(input) {
	const { secret, authority, nowMs = Date.now() } = input;
	const days = input.days ?? 30;
	if (!Number.isInteger(days) || days < 1) throw new Error("cookie lifetime must be an integer number of days >= 1");
	const body = base64UrlEncode(Buffer.from(JSON.stringify({
		version: 1,
		authority,
		issuedAt: nowMs,
		expiresAt: nowMs + days * DAY_MILLISECONDS
	})));
	const signature = base64UrlEncode(createHmac("sha256", secret).update(body).digest());
	return {
		name: browserSessionCookieName(authority),
		value: `v1.${body}.${signature}`
	};
}
/** One Set-Cookie value with DSH's own attributes (HttpOnly, SameSite=Strict). */
function sessionSetCookieHeader(minted, cookiePath, days) {
	const maxAge = days * 86400;
	const expires = new Date(Date.now() + maxAge).toUTCString();
	return `${minted.name}=${minted.value}; Max-Age=${String(maxAge)}; Path=${cookiePath}; Expires=${expires}; HttpOnly; SameSite=Strict`;
}
/**
* Extract the persistent browser-session HMAC secret from the credentials YAML.
* Scans by indentation so the file's other records (API keys, tokens) are never
* parsed — a direct port of the standalone tool's reader.
*/
function readBrowserSessionSecret(credentialsPath) {
	const lines = readFileSync(credentialsPath, "utf8").split(/\r?\n/);
	const recordPattern = new RegExp(`^(\\s*)${BROWSER_SESSION_RECORD.replace("/", "/")}:\\s*$`);
	let start = -1;
	let indent = 0;
	for (let index = 0; index < lines.length; index++) {
		const match = recordPattern.exec(lines[index]);
		if (match !== null) {
			start = index;
			indent = match[1].length;
			break;
		}
	}
	if (start === -1) throw new Error(`record ${BROWSER_SESSION_RECORD} not found in ${credentialsPath}`);
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "") continue;
		if (line.length - line.trimStart().length <= indent) break;
		const match = /^\s*secret:\s*(\S+)\s*$/.exec(line);
		if (match === null) continue;
		const raw = match[1].replace(/^['"]|['"]$/g, "");
		let secret;
		try {
			secret = decodeBase64Url(raw);
		} catch {
			throw new Error(`malformed secret in ${credentialsPath}`);
		}
		if (secret.byteLength !== 32) throw new Error(`unexpected secret length ${secret.byteLength} (want ${String(32)})`);
		return secret;
	}
	throw new Error(`no secret under record ${BROWSER_SESSION_RECORD} in ${credentialsPath}`);
}
/** Default credentials location ($DSH_HOME/.credentials.yaml with ~ expansion). */
function defaultCredentialsPath(dshHome = "~/.dsh") {
	return expandHome(`${dshHome.replace(/\/$/, "")}/.credentials.yaml`);
}
/** Expand a leading `~` to the user home directory. */
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}
/** "host:port" authority of a URL, as DSH's requestAuthority would compute it. */
function authorityOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return;
	}
}
function landingBody(redirect) {
	const escaped = redirect.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
	return `<!doctype html><meta charset="utf-8"><title>Paired</title><script>location.replace(${JSON.stringify(redirect)})<\/script><noscript><a href="${escaped}">Continue</a></noscript>`;
}
function plain(res, status, body) {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}
/**
* The bridge request listener, separable from the listener for tests.
* Every GET/HEAD installs fresh session cookies for the current authorities
* plus the gate cookies, then hands the browser to `redirect`.
*/
function bridgeRequestHandler(options) {
	const { authorities, secret, days = 30, cookiePath = "/", redirect = "/", gateCookies = [], httpRedirect = false } = options;
	return function bridgeHandler(req, res) {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405);
				res.end();
				return;
			}
			if ((req.url ?? "/").startsWith("/health")) {
				plain(res, 200, "ok\n");
				return;
			}
			const cookies = authorities().map((authority) => {
				return sessionSetCookieHeader(mintSessionCookie({
					secret,
					authority,
					days
				}), cookiePath, days);
			});
			for (const gate of gateCookies) cookies.push(`${gate}; Path=${cookiePath}; Max-Age=${String(days * 86400)}; HttpOnly; SameSite=Lax`);
			const status = httpRedirect ? 303 : 200;
			const headers = {
				"cache-control": "no-store",
				"referrer-policy": "no-referrer"
			};
			if (httpRedirect) headers.location = redirect;
			else headers["content-type"] = "text/html; charset=utf-8";
			const body = httpRedirect ? void 0 : Buffer.from(landingBody(redirect), "utf8");
			if (body !== void 0) headers["content-length"] = body.byteLength;
			if (cookies.length > 0) headers["set-cookie"] = cookies;
			res.writeHead(status, headers);
			res.end(body);
		} catch (error) {
			console.error("tunnelmux-remote: bridge request failed —", error instanceof Error ? error.message : error);
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end("internal error");
			} else res.end();
		}
	};
}
/**
* Start the loopback pairing bridge. Every GET/HEAD installs fresh session
* cookies for the current authorities plus the gate cookies, then hands the
* browser to `redirect`.
*/
function startDesktopBridge(options) {
	const handler = bridgeRequestHandler(options);
	const server = http.createServer(handler);
	server.listen(options.port, "127.0.0.1");
	return {
		get port() {
			const address = server.address();
			return typeof address === "object" && address !== null ? address.port : options.port;
		},
		close() {
			return new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			});
		},
		server
	};
}
/**
* Idempotently make the control API match `desired`: create missing routes,
* update drifted ones, leave everything else untouched. Best-effort: on 401
* (control plane locked) the caller should log and move on — routes persist
* in the daemon's state file, so a one-time registration survives restarts.
*/
async function ensureTunnelmuxRoutes(client, desired, tunnelId = "primary") {
	const summary = {
		ok: true,
		registered: [],
		updated: [],
		skipped: []
	};
	let response;
	try {
		response = await client.request("/v1/routes");
	} catch (error) {
		return {
			...summary,
			ok: false,
			reason: error instanceof Error ? error.message : "list failed"
		};
	}
	if (!response.ok) return {
		...summary,
		ok: false,
		reason: `list routes failed (${String(response.status)})`
	};
	let payload;
	try {
		payload = await response.json();
	} catch {
		return {
			...summary,
			ok: false,
			reason: "list routes returned invalid JSON"
		};
	}
	const rows = payload.routes;
	const existing = /* @__PURE__ */ new Map();
	if (Array.isArray(rows)) {
		for (const row of rows) if (typeof row === "object" && row !== null && typeof row.id === "string") existing.set(row.id, row);
	}
	for (const want of desired) {
		const row = existing.get(want.id);
		if (!(row === void 0 || row.match_path_prefix !== want.matchPathPrefix || row.strip_path_prefix !== want.stripPathPrefix || row.upstream_url !== want.upstreamUrl)) {
			summary.skipped.push(want.id);
			continue;
		}
		const body = {
			tunnel_id: tunnelId,
			id: want.id,
			match_host: null,
			match_path_prefix: want.matchPathPrefix,
			strip_path_prefix: want.stripPathPrefix,
			upstream_url: want.upstreamUrl,
			fallback_upstream_url: null,
			health_check_path: "/__disabled__",
			enabled: true,
			forward_host_header: false,
			rewrite_response_paths: false,
			...row !== void 0 ? row : {}
		};
		try {
			const write = row === void 0 ? await client.request("/v1/routes", {
				method: "POST",
				body
			}) : await client.request(`/v1/routes/${encodeURIComponent(want.id)}`, {
				method: "PUT",
				body
			});
			if (!write.ok) {
				const text = await write.text().catch(() => "");
				return {
					...summary,
					ok: false,
					reason: `${row === void 0 ? "create" : "update"} ${want.id} failed (${String(write.status)}) ${text.slice(0, 200)}`
				};
			}
		} catch (error) {
			return {
				...summary,
				ok: false,
				reason: error instanceof Error ? error.message : "write failed"
			};
		}
		if (row === void 0) summary.registered.push(want.id);
		else summary.updated.push(want.id);
	}
	return summary;
}
/**
* Gate cookies to install at pairing time. With no explicit override, read the
* daemon's default access code from its state file and derive one cookie per
* route id (`tunnelmux_access_<routeId>`), so one code entry unlocks both the
* pairing route and the root app route.
*/
function resolveGateCookies(stateFile, routeIds, explicit) {
	if (explicit.trim() !== "") return [explicit];
	try {
		const code = JSON.parse(readFileSync(expandHome(stateFile), "utf8")).default_route_access?.require_access_code;
		if (typeof code === "string" && code !== "") return routeIds.map((id) => `tunnelmux_access_${id}=${code}`);
	} catch {}
	return [];
}
//#endregion
//#region src/routes.ts
const PAIR_PATHS = {
	issue: "/api/pair/issue",
	accept: "/api/pair/accept",
	stop: "/api/pair/stop",
	heartbeat: "/api/pair/heartbeat",
	status: "/api/pair/status",
	events: "/api/pair/events"
};
const MAX_BODY_BYTES = 16384;
const COOKIE_MAX_AGE_SEC = 2592e3;
/** Per-source-IP accept rate limit (brute-force defense in depth). */
const ACCEPT_MAX_ATTEMPTS = 10;
const ACCEPT_WINDOW_MS = 3e4;
/** LAN address derivation: non-internal IPv4 interface addresses. */
function lanIPv4Addresses() {
	return Object.values(networkInterfaces()).flat().filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal).map((iface) => iface.address);
}
/** Whether the request source passes the given fence (loopback + allowed literals). */
function isTrustedRequest(req, allowedAddresses) {
	const remote = req.socket?.remoteAddress ?? "";
	if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") return true;
	const plain = remote.startsWith("::ffff:") ? remote.slice(7) : remote;
	return allowedAddresses.includes(plain);
}
/** The public host (no port) of a tunnel URL, for the phone fence. */
function publicHostOf(publicBaseUrl) {
	if (!publicBaseUrl) return void 0;
	try {
		return new URL(publicBaseUrl).hostname;
	} catch {
		return;
	}
}
function writeJson$1(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(JSON.stringify(body));
}
function requireMethod(req, res, method) {
	if (req.method === method) return true;
	res.writeHead(405);
	res.end();
	return false;
}
async function readJsonBody$1(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
function readCookie$1(header, name) {
	if (!header) return void 0;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=") || void 0;
	}
}
/** SSE fan-out for desktop panel status. */
var PairingEventsStream = class {
	streams = /* @__PURE__ */ new Set();
	service;
	constructor(service) {
		this.service = service;
		service.onState((snapshot) => this.push(snapshot));
	}
	open(req, res) {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		this.streams.add(res);
		const close = () => {
			this.streams.delete(res);
		};
		res.on("close", close);
		req.on("close", close);
	}
	push(snapshot) {
		const frame = `data: ${JSON.stringify({
			type: "state",
			...snapshot
		})}\n\n`;
		for (const res of this.streams) try {
			res.write(frame);
		} catch {
			this.streams.delete(res);
		}
	}
	get size() {
		return this.streams.size;
	}
};
/** Build the /api/pair route family. */
function makePairingRoutes(deps) {
	const { service, lanAddresses } = deps;
	const events = new PairingEventsStream(service);
	const acceptAttempts = /* @__PURE__ */ new Map();
	const lanFence = (req) => {
		if (isTrustedRequest(req, lanAddresses())) return true;
		const publicHost = publicHostOf(service.publicBaseUrl);
		if (publicHost === void 0) return false;
		const host = (req.headers.host ?? "").toLowerCase();
		return host === publicHost || host.startsWith(publicHost + ":");
	};
	const loopbackFence = (req) => isTrustedRequest(req, []);
	const rateLimited = (req) => {
		const ip = req.socket?.remoteAddress ?? "unknown";
		const now = Date.now();
		const entry = acceptAttempts.get(ip);
		if (entry === void 0 || now - entry.windowStart > ACCEPT_WINDOW_MS) {
			acceptAttempts.set(ip, {
				count: 1,
				windowStart: now
			});
			return false;
		}
		entry.count += 1;
		return entry.count > ACCEPT_MAX_ATTEMPTS;
	};
	const handleIssue = async (req, res) => {
		if (!requireMethod(req, res, "POST")) return;
		if (!loopbackFence(req)) {
			writeJson$1(res, 403, {
				ok: false,
				code: "forbidden"
			});
			return;
		}
		const body = await readJsonBody$1(req);
		if (body !== void 0 && (body.workspaceId !== void 0 && typeof body.workspaceId !== "string" || body.address !== void 0 && typeof body.address !== "string")) {
			writeJson$1(res, 400, {
				ok: false,
				code: "bad-payload"
			});
			return;
		}
		const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : void 0;
		const address = typeof body?.address === "string" ? body.address : void 0;
		try {
			const { token, expiresAt } = service.issue(workspaceId, address);
			const base = address === void 0 ? service.publicBaseUrl ?? service.lanBaseUrl : service.lanBaseUrlFor(address);
			if (base === void 0) throw new Error("base unavailable");
			writeJson$1(res, 200, {
				ok: true,
				url: `${base}/?pair=${token}${workspaceId === void 0 ? "" : `&workspace=${encodeURIComponent(workspaceId)}`}`,
				token,
				expiresAt,
				lanAddresses: service.lanAddresses,
				...service.publicBaseUrl !== void 0 ? { publicBaseUrl: service.publicBaseUrl } : {}
			});
		} catch (error) {
			const unknownAddress = error instanceof Error && error.name === "UnknownLanAddressError";
			writeJson$1(res, unknownAddress ? 400 : 409, {
				ok: false,
				code: unknownAddress ? "unknown-address" : "lan-required"
			});
		}
	};
	const handleAccept = async (req, res) => {
		if (!requireMethod(req, res, "POST")) return;
		if (!lanFence(req)) {
			writeJson$1(res, 403, {
				ok: false,
				code: "forbidden"
			});
			return;
		}
		if (rateLimited(req)) {
			writeJson$1(res, 429, {
				ok: false,
				code: "rate-limited"
			});
			return;
		}
		const body = await readJsonBody$1(req);
		const token = typeof body?.token === "string" ? body.token : "";
		const result = service.accept(token);
		if (!result.ok) {
			writeJson$1(res, result.code === "used" ? 409 : 404, {
				ok: false,
				code: result.code
			});
			return;
		}
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"set-cookie": [`${service.cookieName}=${result.deviceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(COOKIE_MAX_AGE_SEC)}`]
		});
		res.end(JSON.stringify({
			ok: true,
			deviceId: result.deviceId
		}));
	};
	const handleStop = async (req, res) => {
		if (!requireMethod(req, res, "POST")) return;
		if (!loopbackFence(req)) {
			writeJson$1(res, 403, {
				ok: false,
				code: "forbidden"
			});
			return;
		}
		await readJsonBody$1(req);
		service.stop();
		writeJson$1(res, 200, { ok: true });
	};
	const handleHeartbeat = async (req, res) => {
		if (!requireMethod(req, res, "POST")) return;
		if (!lanFence(req)) {
			writeJson$1(res, 403, {
				ok: false,
				code: "forbidden"
			});
			return;
		}
		await readJsonBody$1(req);
		const deviceId = readCookie$1(req.headers.cookie, service.cookieName);
		if (deviceId === void 0 || !service.heartbeat(deviceId)) {
			writeJson$1(res, 401, {
				ok: false,
				code: "unpaired"
			});
			return;
		}
		writeJson$1(res, 200, { ok: true });
	};
	const handleStatus = (req, res) => {
		if (!requireMethod(req, res, "GET")) return;
		if (!lanFence(req)) {
			writeJson$1(res, 403, {
				ok: false,
				code: "forbidden"
			});
			return;
		}
		const deviceId = readCookie$1(req.headers.cookie, service.cookieName);
		writeJson$1(res, 200, {
			ok: true,
			paired: deviceId !== void 0 && service.hasDevice(deviceId),
			...service.snapshot()
		});
	};
	const handleEvents = (req, res) => {
		if (!requireMethod(req, res, "GET")) return;
		if (!loopbackFence(req)) {
			writeJson$1(res, 403, {
				ok: false,
				code: "forbidden"
			});
			return;
		}
		events.open(req, res);
		events.push(service.snapshot());
	};
	return [
		{
			kind: "exact",
			path: PAIR_PATHS.issue,
			handler: handleIssue
		},
		{
			kind: "exact",
			path: PAIR_PATHS.accept,
			handler: handleAccept
		},
		{
			kind: "exact",
			path: PAIR_PATHS.stop,
			handler: handleStop
		},
		{
			kind: "exact",
			path: PAIR_PATHS.heartbeat,
			handler: handleHeartbeat
		},
		{
			kind: "exact",
			path: PAIR_PATHS.status,
			handler: handleStatus
		},
		{
			kind: "exact",
			path: PAIR_PATHS.events,
			handler: handleEvents
		}
	];
}
//#endregion
//#region src/mobile.ts
/** Methods the phone surface may call. Everything else is refused. */
const MOBILE_ALLOWLIST = /* @__PURE__ */ new Set([
	"workspace.list",
	"session.create",
	"session.list",
	"session.history",
	"session.search",
	"session.prompt",
	"session.models",
	"session.selectModel",
	"session.rename"
]);
/** Locally answered display-preference method (never proxied). */
const MOBILE_PREFERENCES_METHOD = "mobile.preferences";
/** One session.list page (thin phones load incrementally). */
const SESSION_PAGE_SIZE = 20;
/** SSE keep-alive ping cadence for the live mux stream. */
const DEFAULT_EVENTS_HEARTBEAT_MS = 15e3;
const MOBILE_API_PREFIX = "/m/api";
const MOBILE_API_PATHS = { events: "/m/api/events.mux" };
function sessionListCursor(updatedAt, sessionId) {
	return `${updatedAt}:${sessionId}`;
}
function parseSessionListCursor(cursor) {
	if (!cursor) return void 0;
	const separator = cursor.indexOf(":");
	if (separator < 0) return void 0;
	const updatedAt = Number(cursor.slice(0, separator));
	if (!Number.isFinite(updatedAt)) return void 0;
	return {
		updatedAt,
		sessionId: cursor.slice(separator + 1)
	};
}
function afterCursor(row, position) {
	return row.updatedAt < position.updatedAt || row.updatedAt === position.updatedAt && row.sessionId > position.sessionId;
}
function readCookie(header, name) {
	if (!header) return void 0;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=") || void 0;
	}
}
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 65536) throw new Error("body too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
function writeStatic(res, status, type, body) {
	res.writeHead(status, {
		"content-type": `${type}; charset=utf-8`,
		"cache-control": "no-cache",
		"referrer-policy": "no-referrer"
	});
	res.end(body);
}
function pageHtml(bundleUrl) {
	return [
		"<!doctype html>",
		"<html lang=\"zh-CN\">",
		"<head>",
		"<meta charset=\"utf-8\">",
		"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover\">",
		"<meta name=\"theme-color\" content=\"#f3f5f9\">",
		"<meta name=\"referrer\" content=\"no-referrer\">",
		"<link rel=\"apple-touch-icon\" href=\"/m/apple-touch-icon.png\">",
		"<title>移动端远程控制</title>",
		"</head>",
		"<body>",
		"<div id=\"root\"></div>",
		`<script type="module" src="${bundleUrl}"><\/script>`,
		"</body>",
		"</html>"
	].join("");
}
function defaultMobileBundlePath() {
	return fileURLToPath(new URL("../lib/mobile.js", import.meta.url));
}
/** Build the mobile page + API routes. */
function makeMobileRoutes(deps) {
	const { service, apiProxy, lanAddresses, mobileEnterToSend } = deps;
	const eventsHeartbeatMs = deps.eventsHeartbeatMs ?? DEFAULT_EVENTS_HEARTBEAT_MS;
	const bundlePath = deps.mobileBundlePath ?? defaultMobileBundlePath;
	const gateOk = (req) => {
		const deviceId = readCookie(req.headers.cookie, service.cookieName);
		return deviceId !== void 0 && service.touchDevice(deviceId);
	};
	const handlePage = (_req, res) => {
		writeStatic(res, 200, "text/html", pageHtml("/m/mobile.js"));
	};
	const handleBundle = async (_req, res) => {
		const path = bundlePath();
		if (!existsSync(path)) {
			writeStatic(res, 503, "text/plain", "mobile bundle not built: run pnpm --filter dsh-tunnelmux-remote build");
			return;
		}
		try {
			writeStatic(res, 200, "text/javascript", await readFile(path, "utf8"));
		} catch {
			writeStatic(res, 500, "text/plain", "failed to read the mobile bundle");
		}
	};
	const handleMethod = async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		if (!gateOk(req)) {
			writeJson(res, 403, {
				ok: false,
				error: {
					code: "unpaired",
					message: "mobile session is not paired"
				}
			});
			return;
		}
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		if (!pathname.startsWith("/m/api/")) {
			writeJson(res, 404, {
				ok: false,
				error: {
					code: "not-found",
					message: "unknown mobile api path"
				}
			});
			return;
		}
		const method = pathname.slice(7);
		const local = method === MOBILE_PREFERENCES_METHOD;
		if (!MOBILE_ALLOWLIST.has(method) && !local) {
			writeJson(res, 403, {
				ok: false,
				error: {
					code: "forbidden",
					message: `method ${method} is not exposed to the mobile surface`
				}
			});
			return;
		}
		let envelope = {};
		try {
			envelope = await readJsonBody(req) ?? {};
		} catch {
			writeJson(res, 400, {
				ok: false,
				error: {
					code: "bad-request",
					message: "invalid json body"
				}
			});
			return;
		}
		const rpcId = typeof envelope.rpcId === "string" ? envelope.rpcId : "";
		if (rpcId === "") {
			writeJson(res, 400, {
				ok: false,
				error: {
					code: "bad-request",
					message: "missing rpcId"
				}
			});
			return;
		}
		if (local) {
			writeJson(res, 200, {
				type: "server-response",
				rpcId,
				result: {
					ok: true,
					value: { mobileEnterToSend: mobileEnterToSend() }
				}
			});
			return;
		}
		try {
			writeJson(res, 200, await dispatch(apiProxy, method, envelope.payload, rpcId));
		} catch (error) {
			writeJson(res, 200, {
				type: "server-response",
				rpcId,
				result: {
					ok: false,
					error: {
						code: "internal",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			});
		}
	};
	const handleEvents = async (req, res) => {
		if (req.method !== "GET") {
			res.writeHead(405);
			res.end();
			return;
		}
		if (!gateOk(req)) {
			res.writeHead(403);
			res.end("forbidden");
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		const controller = new AbortController();
		let closed = false;
		const heartbeat = setInterval(() => {
			if (closed) return;
			const deviceId = readCookie(req.headers.cookie, service.cookieName);
			if (deviceId !== void 0) service.touchDevice(deviceId);
			try {
				res.write(": ping\n\n");
			} catch {}
		}, eventsHeartbeatMs);
		const onClose = () => {
			if (closed) return;
			closed = true;
			controller.abort();
			clearInterval(heartbeat);
		};
		res.on("close", onClose);
		req.on("close", onClose);
		try {
			const frames = apiProxy.events.mux({
				rpcId: `mobile-mux-${Date.now().toString(36)}`,
				payload: {}
			}, controller.signal);
			for await (const frame of frames) {
				if (closed) break;
				res.write(`data: ${JSON.stringify(frame)}\n\n`);
			}
		} catch {} finally {
			controller.abort();
			clearInterval(heartbeat);
		}
		if (!closed) res.end();
	};
	return [
		{
			kind: "exact",
			path: "/m",
			handler: handlePage
		},
		{
			kind: "exact",
			path: "/m/mobile.js",
			handler: handleBundle
		},
		{
			kind: "prefix",
			path: MOBILE_API_PREFIX,
			handler: handleMethod
		},
		{
			kind: "exact",
			path: MOBILE_API_PATHS.events,
			handler: handleEvents
		}
	];
}
/** Dispatch one allowlisted method through the host apiProxy. */
async function dispatch(apiProxy, method, payload, rpcId) {
	const request = {
		rpcId,
		payload
	};
	if (method === "session.list") {
		const full = await apiProxy.sessions.list(request);
		if (!full.result.ok) return full;
		const items = full.result.value.items;
		const cursor = payload?.cursor;
		items.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
		const position = parseSessionListCursor(cursor);
		const from = position === void 0 ? 0 : items.findIndex((row) => afterCursor(row, position));
		const start = from < 0 ? items.length : from;
		const page = items.slice(start, start + SESSION_PAGE_SIZE);
		const last = page[page.length - 1];
		const nextCursor = last !== void 0 && start + page.length < items.length ? sessionListCursor(last.updatedAt, last.sessionId) : void 0;
		return {
			type: "server-response",
			rpcId,
			result: {
				ok: true,
				value: {
					items: page,
					hasMore: nextCursor !== void 0,
					...nextCursor !== void 0 ? { nextCursor } : {}
				}
			}
		};
	}
	const wrap = (response) => ({
		type: "server-response",
		rpcId,
		result: response.result
	});
	if (method === "workspace.list") return wrap(await apiProxy.workspace.list(request));
	if (method === "session.create") return wrap(await apiProxy.sessions.create(request));
	if (method === "session.history") return wrap(await apiProxy.sessions.history(request));
	if (method === "session.search") return wrap(await apiProxy.sessions.search(request, new AbortController().signal));
	if (method === "session.prompt") return wrap(await apiProxy.sessions.prompt(request));
	if (method === "session.models") return wrap(await apiProxy.sessions.models(request));
	if (method === "session.selectModel") return wrap(await apiProxy.sessions.selectModel(request));
	if (method === "session.rename") return wrap(await apiProxy.sessions.rename(request));
	throw new Error(`unhandled allowlisted method ${method}`);
}
//#endregion
//#region src/index.ts
/**
* dsh-tunnelmux-remote host half: pairs phones to the DSH web GUI and drives
* a TunnelMux-managed tunnel as the public backend. Wires the pairing
* service, the TunnelMux adapter, the /api/pair route family, and the mobile
* surface into the DSH host. Config is declared with schemastery and applied
* by the loader; a settings namespace is registered when the settings
* service is present so the user can tune pairing without editing YAML.
*/
const name = "tunnelmux-remote";
/** Services required before the pairing surfaces can mount (apiProxy is probed at runtime). */
const inject = ["webServer"];
/** Settings namespace of the remote-control capability. */
const REMOTE_SETTINGS_NAMESPACE = "tunnelmux-remote";
const Config = z.object({
	enabled: z.boolean().default(true),
	tunnelmuxBaseUrl: z.string().default("http://127.0.0.1:4765"),
	tunnelmuxApiToken: z.string().default("").role("secret"),
	targetUrl: z.string().default("http://127.0.0.1:3080"),
	tunnelProvider: z.union([z.const("cloudflared"), z.const("ngrok")]).default("cloudflared"),
	autoTunnel: z.boolean().default(false),
	publicBaseUrl: z.string().default(""),
	tokenTtlMs: z.number().min(6e4).default(6e5),
	offlineAfterMs: z.number().min(5e3).default(25e3),
	maxDevices: z.number().min(1).max(64).default(4),
	cookieName: z.string().default("dsh_pair"),
	mobileEnterToSend: z.boolean().default(true),
	desktopBridge: z.boolean().default(true),
	bridgePort: z.number().min(1024).max(65535).default(3988),
	bridgeRedirect: z.string().default("/"),
	bridgeDays: z.number().min(1).max(30).default(30),
	registerRoutes: z.boolean().default(true),
	pairRouteId: z.string().default("deepseek"),
	pairRoutePrefix: z.string().default("/deepseek"),
	rootRouteId: z.string().default("dsh-root"),
	rootRoutePrefix: z.string().default("/"),
	gateCookie: z.string().default(""),
	dshHome: z.string().default("~/.dsh"),
	tunnelmuxStateFile: z.string().default("~/.tunnelmux/state.json")
});
/** Presence sweep cadence (a stale device flips to disconnected within two sweeps). */
const SWEEP_INTERVAL_MS = 1e4;
const DEFAULTS = {
	enabled: true,
	tunnelmuxBaseUrl: "http://127.0.0.1:4765",
	tunnelmuxApiToken: "",
	targetUrl: "http://127.0.0.1:3080",
	tunnelProvider: "cloudflared",
	autoTunnel: false,
	publicBaseUrl: "",
	tokenTtlMs: 6e5,
	offlineAfterMs: 25e3,
	maxDevices: 4,
	cookieName: "dsh_pair",
	mobileEnterToSend: true,
	desktopBridge: true,
	bridgePort: 3988,
	bridgeRedirect: "/",
	bridgeDays: 30,
	registerRoutes: true,
	pairRouteId: "deepseek",
	pairRoutePrefix: "/deepseek",
	rootRouteId: "dsh-root",
	rootRoutePrefix: "/",
	gateCookie: "",
	dshHome: "~/.dsh",
	tunnelmuxStateFile: "~/.tunnelmux/state.json"
};
/**
* Mount the pairing service, routes, tunnel adapter, and presence sweep.
* @param ctx - host plugin context carrying webServer and apiProxy.
* @param config - resolved plugin config (schema defaults applied by the loader).
*/
function apply(ctx, config = {}) {
	const resolved = {
		enabled: config.enabled ?? DEFAULTS.enabled,
		tunnelmuxBaseUrl: config.tunnelmuxBaseUrl ?? DEFAULTS.tunnelmuxBaseUrl,
		tunnelmuxApiToken: config.tunnelmuxApiToken ?? DEFAULTS.tunnelmuxApiToken,
		targetUrl: config.targetUrl ?? DEFAULTS.targetUrl,
		tunnelProvider: config.tunnelProvider ?? DEFAULTS.tunnelProvider,
		autoTunnel: config.autoTunnel ?? DEFAULTS.autoTunnel,
		publicBaseUrl: config.publicBaseUrl ?? DEFAULTS.publicBaseUrl,
		tokenTtlMs: config.tokenTtlMs ?? DEFAULTS.tokenTtlMs,
		offlineAfterMs: config.offlineAfterMs ?? DEFAULTS.offlineAfterMs,
		maxDevices: config.maxDevices ?? DEFAULTS.maxDevices,
		cookieName: config.cookieName ?? DEFAULTS.cookieName,
		mobileEnterToSend: config.mobileEnterToSend ?? DEFAULTS.mobileEnterToSend,
		desktopBridge: config.desktopBridge ?? DEFAULTS.desktopBridge,
		bridgePort: config.bridgePort ?? DEFAULTS.bridgePort,
		bridgeRedirect: config.bridgeRedirect ?? DEFAULTS.bridgeRedirect,
		bridgeDays: config.bridgeDays ?? DEFAULTS.bridgeDays,
		registerRoutes: config.registerRoutes ?? DEFAULTS.registerRoutes,
		pairRouteId: config.pairRouteId ?? DEFAULTS.pairRouteId,
		pairRoutePrefix: config.pairRoutePrefix ?? DEFAULTS.pairRoutePrefix,
		rootRouteId: config.rootRouteId ?? DEFAULTS.rootRouteId,
		rootRoutePrefix: config.rootRoutePrefix ?? DEFAULTS.rootRoutePrefix,
		gateCookie: config.gateCookie ?? DEFAULTS.gateCookie,
		dshHome: config.dshHome ?? DEFAULTS.dshHome,
		tunnelmuxStateFile: config.tunnelmuxStateFile ?? DEFAULTS.tunnelmuxStateFile
	};
	const service = new PairingService({
		tokenTtlMs: resolved.tokenTtlMs,
		offlineAfterMs: resolved.offlineAfterMs,
		maxDevices: resolved.maxDevices,
		cookieName: resolved.cookieName
	}, defaultClock);
	let lanPort = "3080";
	try {
		lanPort = new URL(resolved.targetUrl).port || "3080";
	} catch {}
	const lanEntries = lanIPv4Addresses().map((address) => ({
		address,
		base: `http://${address}:${lanPort}`
	}));
	service.setLanBases(lanEntries);
	if (resolved.publicBaseUrl.trim() !== "") service.setPublicBaseUrl(resolved.publicBaseUrl.trim());
	const tunnelmuxClient = createTunnelMuxHttpClient(resolved.tunnelmuxBaseUrl, resolved.tunnelmuxApiToken || void 0);
	const tunnel = new TunnelMuxTunnelManager(tunnelmuxClient, {
		tunnelId: "dsh-remote",
		provider: resolved.tunnelProvider,
		targetUrl: resolved.targetUrl,
		autoRestart: true
	});
	const lanAddresses = () => service.lanAddresses;
	const routes = [...makePairingRoutes({
		service,
		lanAddresses
	})];
	const applyRoutes = () => {
		for (const route of routes) ctx.webServer.register(route);
	};
	ctx.effect(() => {
		if (!resolved.enabled) return () => {};
		applyRoutes();
		const apiProxy = ctx.get("apiProxy");
		if (apiProxy !== void 0) for (const route of makeMobileRoutes({
			service,
			apiProxy,
			lanAddresses,
			mobileEnterToSend: () => resolved.mobileEnterToSend
		})) ctx.webServer.register(route);
		else console.info("tunnelmux-remote: apiProxy service not present — mobile surface (/m) disabled; desktop pairing bridge and QR panel stay active");
		const sweep = setInterval(() => service.sweep(), SWEEP_INTERVAL_MS);
		if (resolved.autoTunnel) {
			tunnel.onStatus(() => {
				service.setTunnelStatus({
					state: tunnel.info.phase,
					...tunnel.info.url !== void 0 ? { url: tunnel.info.url } : {},
					...tunnel.info.error !== void 0 ? { error: tunnel.info.error } : {}
				});
				if (tunnel.info.phase === "running" && tunnel.info.url !== void 0) service.setPublicBaseUrl(tunnel.info.url);
			});
			tunnel.start();
			tunnel.startPolling();
		} else if (resolved.publicBaseUrl.trim() === "") service.setTunnelStatus({ state: "stopped" });
		return () => {
			clearInterval(sweep);
			tunnel.dispose();
		};
	}, "tunnelmux-remote: pairing surface");
	ctx.effect(() => {
		if (!resolved.enabled || !resolved.desktopBridge) return () => {};
		let secret;
		try {
			secret = readBrowserSessionSecret(defaultCredentialsPath(resolved.dshHome));
		} catch (error) {
			console.error("tunnelmux-remote: desktop bridge disabled —", error instanceof Error ? error.message : error);
			return () => {};
		}
		const currentAuthorities = () => {
			const list = /* @__PURE__ */ new Set();
			const target = authorityOf(resolved.targetUrl);
			if (target !== void 0) list.add(target);
			const publicUrl = resolved.publicBaseUrl.trim() !== "" ? resolved.publicBaseUrl : tunnel.info.url;
			const publicAuthority = publicUrl === void 0 ? void 0 : authorityOf(publicUrl);
			if (publicAuthority !== void 0) list.add(publicAuthority);
			return [...list];
		};
		let bridge;
		try {
			bridge = startDesktopBridge({
				port: resolved.bridgePort,
				authorities: currentAuthorities,
				secret,
				days: resolved.bridgeDays,
				cookiePath: "/",
				redirect: resolved.bridgeRedirect,
				gateCookies: resolveGateCookies(resolved.tunnelmuxStateFile, [resolved.pairRouteId, resolved.rootRouteId], resolved.gateCookie)
			});
		} catch (error) {
			console.error("tunnelmux-remote: desktop bridge failed to start —", error instanceof Error ? error.message : error);
			return () => {};
		}
		console.info(`tunnelmux-remote: desktop bridge on http://127.0.0.1:${String(resolved.bridgePort)}/ -> ${resolved.bridgeRedirect}`);
		if (resolved.registerRoutes) ensureTunnelmuxRoutes(tunnelmuxClient, [{
			id: resolved.pairRouteId,
			matchPathPrefix: resolved.pairRoutePrefix,
			stripPathPrefix: resolved.pairRoutePrefix,
			upstreamUrl: `http://127.0.0.1:${String(resolved.bridgePort)}`
		}, {
			id: resolved.rootRouteId,
			matchPathPrefix: resolved.rootRoutePrefix,
			stripPathPrefix: null,
			upstreamUrl: resolved.targetUrl
		}]).then((result) => {
			if (result.ok) {
				const touched = [...result.registered.map((id) => `+${id}`), ...result.updated.map((id) => `~${id}`)];
				if (touched.length > 0) console.info(`tunnelmux-remote: routes synced (${touched.join(" ")})`);
			} else console.warn(`tunnelmux-remote: route sync deferred — ${result.reason ?? "unknown"} (routes persist in daemon state; they apply once the control plane is unlocked)`);
		});
		return () => {
			bridge.close();
		};
	}, "tunnelmux-remote: desktop bridge");
	ctx.inject(["settings"], (sctx) => {
		sctx.settings.register(settingsNamespace(REMOTE_SETTINGS_NAMESPACE), Config, { base: resolved });
	});
}
//#endregion
export { Config, REMOTE_SETTINGS_NAMESPACE, TunnelMuxTunnelManager, apply, createTunnelMuxHttpClient, inject, name };

//# sourceMappingURL=index.js.map