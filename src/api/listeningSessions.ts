/**
 * The HTTP half of Open Listening Sessions: asking a coordinator what it
 * speaks, and opening or joining a room on it. Nothing here goes to the music
 * server, and nothing from the music server goes here except the fingerprint
 * of its address.
 */
import * as Crypto from 'expo-crypto';
import { fetch } from 'expo/fetch';

import { OlsConnectionError } from '@/lib/listeningSessionConnection';
import {
  OLS_MAX_MESSAGE_CHARS,
  OLS_MAX_NAME_CHARS,
  isOlsAccess,
  isOlsCapabilities,
  normalizeOlsCoordinatorUrl,
  normalizeOlsServerUrl,
  olsErrorCode,
  type OlsAccess,
  type OlsCapabilities,
  type OlsMediaProfile,
} from '@/lib/listeningSessions';

const TIMEOUT_MS = 15_000;

/**
 * The body as text, read no further than an answer can be long: a body with no
 * length given would otherwise be held whole, however big, before the check.
 */
async function boundedText(
  res: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  ctrl: AbortController,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > OLS_MAX_MESSAGE_CHARS) {
      ctrl.abort();
      throw new OlsConnectionError('invalid', 'Too large');
    }
  }
}

async function call(coordinatorUrl: string, path: string, body?: object): Promise<unknown> {
  const base = normalizeOlsCoordinatorUrl(coordinatorUrl);
  if (!base) throw new OlsConnectionError('address', 'Not a coordinator address');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof fetch>>;
  let text: string;
  try {
    res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'content-type': 'application/json', accept: 'application/json' }
        : { accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      // A coordinator has no business with this app's cookies.
      credentials: 'omit',
    });
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > OLS_MAX_MESSAGE_CHARS) throw new OlsConnectionError('invalid', 'Too large');
    text = await boundedText(res, ctrl);
  } catch (e) {
    if (e instanceof OlsConnectionError) throw e;
    throw ctrl.signal.aborted
      ? new OlsConnectionError('timeout', 'The coordinator did not answer')
      : new OlsConnectionError('unreachable', 'Could not reach the coordinator');
  } finally {
    clearTimeout(timer);
  }
  if (text.length > OLS_MAX_MESSAGE_CHARS) throw new OlsConnectionError('invalid', 'Too large');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new OlsConnectionError(res.ok ? 'invalid' : `http_${res.status}`, 'Not an OLS answer');
  }
  if (!res.ok) {
    throw new OlsConnectionError(olsErrorCode(payload) ?? `http_${res.status}`, 'Refused');
  }
  return payload;
}

export async function getOlsCapabilities(coordinatorUrl: string): Promise<OlsCapabilities> {
  let payload: unknown;
  try {
    payload = await call(coordinatorUrl, '/v1/capabilities');
  } catch (e) {
    // Something answered, and not as a coordinator: a music server's address
    // typed in here, most likely. That is not a missing room. A server that
    // is busy or down, though, is said to be.
    if (e instanceof OlsConnectionError && /^http_5\d\d$/.test(e.code)) {
      throw new OlsConnectionError('unreachable', 'The coordinator is not answering');
    }
    if (
      e instanceof OlsConnectionError &&
      ((e.code.startsWith('http_') && e.code !== 'http_429') || e.code === 'invalid')
    ) {
      throw new OlsConnectionError('unsupported', 'Not an OLS v1 coordinator');
    }
    throw e;
  }
  if (!isOlsCapabilities(payload)) throw new OlsConnectionError('unsupported', 'Not an OLS v1 coordinator');
  return payload;
}

function nameField(displayName: string): { displayName?: string } {
  const name = displayName.trim().slice(0, OLS_MAX_NAME_CHARS);
  return name ? { displayName: name } : {};
}

function access(payload: unknown): OlsAccess {
  if (!isOlsAccess(payload)) throw new OlsConnectionError('invalid', 'Not an OLS answer');
  return payload;
}

export async function createOlsRoom(
  coordinatorUrl: string,
  mediaProfile: OlsMediaProfile,
  displayName: string,
): Promise<OlsAccess> {
  return access(
    await call(coordinatorUrl, '/v1/rooms', {
      protocolVersion: 1,
      ...nameField(displayName),
      mediaProfile,
    }),
  );
}

export async function joinOlsRoom(
  coordinatorUrl: string,
  code: string,
  mediaProfile: OlsMediaProfile,
  displayName: string,
): Promise<OlsAccess> {
  return access(
    await call(coordinatorUrl, '/v1/rooms/join', {
      protocolVersion: 1,
      code,
      ...nameField(displayName),
      mediaProfile,
    }),
  );
}

/**
 * The library's fingerprint: SHA-256 of the server's normalised address. Two
 * people on the same server get the same one without the coordinator ever
 * learning which server that is.
 */
export async function olsLibraryId(serverUrl: string): Promise<string | null> {
  const normal = normalizeOlsServerUrl(serverUrl);
  if (!normal) return null;
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normal);
  return `sha256:${hex.toLowerCase()}`;
}
