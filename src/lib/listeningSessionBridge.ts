/**
 * Where the player asks whether a listening room has a say in what it is about
 * to do. The room's store registers itself here instead of the player
 * importing it, since the room's store drives the player and a cycle between
 * the two would load one of them half made.
 *
 * Every rule is asked at the action itself, not at the buttons: the queue
 * screen, the player, the notification, the car, the widget and the home
 * screen shortcut all end up in the same few store actions, and a guard on a
 * button is one that the next control to be added forgets.
 */
import type { OlsControl, OlsRole } from './listeningSessions';

export interface OlsPlayerHooks {
  role(): OlsRole | null;
  /** A guest pressed something only the host may do: ask the host. */
  request(control: OlsControl): void;
  /** A guest pressed play or pause in the app. */
  toggle(): void;
  /**
   * This device stopped or started on its own: the system (headphones out, a
   * call, the notification's button) or the sleep timer. Only the guest's own
   * playback, never the room's.
   */
  local(playing: boolean): void;
  /** The player reported a status, kept or not. */
  status(): void;
  /** Out of the room at once: this device is leaving its profile. */
  quit(): void;
}

let hooks: OlsPlayerHooks | null = null;

export function registerOlsPlayerHooks(h: OlsPlayerHooks): void {
  hooks = h;
}

export function olsRole(): OlsRole | null {
  return hooks?.role() ?? null;
}

/** True when this device is a guest, and the control went to the host instead. */
export function olsGuestControl(control: OlsControl): boolean {
  if (!hooks || hooks.role() !== 'guest') return false;
  hooks.request(control);
  return true;
}

/** True when this device is a guest and play/pause went to the room instead. */
export function olsGuestToggle(): boolean {
  if (!hooks || hooks.role() !== 'guest') return false;
  hooks.toggle();
  return true;
}

/** Tells the room this device paused or played without being asked to by it. */
export function olsLocalTransport(playing: boolean): void {
  if (hooks?.role() === 'guest') hooks.local(playing);
}

/**
 * Every status the player reports, including the ones it drops as routine: a
 * guest waiting for its player to be ready is woken by them, since timers do
 * not run with the screen off and a dropped status writes nothing to wake it.
 */
export function olsPlayerStatus(): void {
  if (hooks?.role() === 'guest') hooks.status();
}

/** This device is leaving its profile: out of any room, before the queue goes. */
export function olsQuit(): void {
  hooks?.quit();
}
