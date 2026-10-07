import * as Crypto from 'expo-crypto';

import {
  isListeningSessionAccess,
  isListeningSessionCapabilities,
  normalizeListeningSessionCoordinatorUrl,
  normalizeListeningSessionServerUrl,
  type ListeningSessionAccess,
  type ListeningSessionCapabilities,
  type ListeningSessionMediaProfile,
} from '@/lib/listeningSessions';

const REQUEST_TIMEOUT_MS = 15_000;

interface CoordinatorErrorBody {
  error?: { code?: unknown; message?: unknown };
}

function endpoint(coordinatorUrl: string, path: string): string {
  return `${normalizeListeningSessionCoordinatorUrl(coordinatorUrl)}${path}`;
}

async function coordinatorRequest(
  coordinatorUrl: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(coordinatorUrl, path), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('The Jam coordinator returned an invalid response');
    }
    if (!response.ok) {
      const error = payload as CoordinatorErrorBody;
      throw new Error(
        typeof error.error?.message === 'string'
          ? error.error.message
          : 'The Jam coordinator returned an error',
      );
    }
    return payload;
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new Error('The Jam coordinator did not respond');
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getListeningSessionCapabilities(
  coordinatorUrl: string,
): Promise<ListeningSessionCapabilities> {
  const payload = await coordinatorRequest(coordinatorUrl, '/v1/capabilities');
  if (!isListeningSessionCapabilities(payload)) {
    throw new Error('This server is not an Open Listening Sessions coordinator');
  }
  return payload;
}

function accessFrom(payload: unknown): ListeningSessionAccess {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('protocolVersion' in payload) ||
    payload.protocolVersion !== 1 ||
    !isListeningSessionAccess(payload)
  ) {
    throw new Error('The Jam coordinator returned an invalid response');
  }
  return payload;
}

export async function createListeningSession(
  coordinatorUrl: string,
  mediaProfile: ListeningSessionMediaProfile,
  displayName?: string,
): Promise<ListeningSessionAccess> {
  return accessFrom(
    await coordinatorRequest(coordinatorUrl, '/v1/rooms', {
      protocolVersion: 1,
      displayName,
      mediaProfile,
    }),
  );
}

export async function joinListeningSession(
  coordinatorUrl: string,
  code: string,
  mediaProfile: ListeningSessionMediaProfile,
  displayName?: string,
): Promise<ListeningSessionAccess> {
  return accessFrom(
    await coordinatorRequest(coordinatorUrl, '/v1/rooms/join', {
      protocolVersion: 1,
      code,
      displayName,
      mediaProfile,
    }),
  );
}

export async function createOpenSubsonicLibraryId(serverUrl: string): Promise<string> {
  const normalized = normalizeListeningSessionServerUrl(serverUrl);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normalized);
  return `sha256:${digest.toLowerCase()}`;
}
