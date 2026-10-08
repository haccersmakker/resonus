/**
 * "Suggested tracks": a short list of similar songs drawn beside a list -
 * a playlist's own, or a radio's - with a preview on tap and a button that
 * hands the song to wherever it is being shown.
 *
 * The suggestions come two seeds at a time (see `fetchSuggestions`), and the
 * preview is a shared, single player for every screen this is mounted on, so
 * two of them never play over each other.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

import { COVER, getSimilarSongs, songCoverUrl } from '@/api/data';
import { streamUrl } from '@/api/backend';
import type { Song } from '@/api/subsonic';
import { Cover } from './Cover';
import Icon from './Icon';
import { useT } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { pauseHere, resumeHere, usePlayerStore } from '@/store/player';
import { colors, fontSize, spacing, themed, tracking } from '@/theme';

/** How many of the list's own songs are drawn from, and how many songs each
 *  seed is asked for. */
const SEED_COUNT = 5;
const SIMILAR_PER_SEED = 3;
/** How many suggestions are shown at most. */
const SUGGESTION_MAX = 5;
const SEEDS_AT_ONCE = 2;

/** Stops the preview playing on whichever list screen started it, so a
 *  second screen never plays over the first. */
let activePreview: { player: AudioPlayer; stop: () => void } | null = null;

/**
 * Two seeds at a time, and only until there are enough.
 *
 * `getSimilarSongs2` can take seconds a call on a server that asks Last.fm, and
 * Android sends at most five requests to one host at once: the five seeds in
 * parallel took every slot, so the next list opened sat on its placeholder
 * behind suggestions nobody was looking at. Two usually bring enough and leave
 * the rest free. `stale` says the screen has gone or asked again.
 */
async function fetchSuggestions(
  songs: Song[],
  existingIds: Set<string>,
  stale: () => boolean,
): Promise<Song[]> {
  if (songs.length === 0) return [];
  const shuffled = songs.slice().sort(() => Math.random() - 0.5);
  const seeds = shuffled.slice(0, SEED_COUNT);
  const seen = new Set<string>();
  const out: Song[] = [];
  for (let i = 0; i < seeds.length; i += SEEDS_AT_ONCE) {
    if (stale()) return out;
    const lists = await Promise.all(
      seeds
        .slice(i, i + SEEDS_AT_ONCE)
        .map((seed) => getSimilarSongs(seed.id, SIMILAR_PER_SEED).catch(() => [] as Song[])),
    );
    for (const song of lists.flat()) {
      if (!seen.has(song.id) && !existingIds.has(song.id)) {
        seen.add(song.id);
        out.push(song);
        if (out.length >= SUGGESTION_MAX) return out;
      }
    }
  }
  return out;
}

export function SuggestedTracks({
  songs,
  subtitle,
  addLabel,
  onAdd,
}: {
  songs: Song[];
  /** Under the heading: what the suggestions are drawn from. */
  subtitle: string;
  /** Accessibility label on the add button, for where this is being shown. */
  addLabel: string;
  /** Hands the song to wherever this list is shown. Resolve `true` when it
   *  was taken - the row then leaves the suggestions. */
  onAdd: (song: Song) => Promise<boolean>;
}) {
  const t = useT();
  const auth = useAuthStore((s) => s.auth);
  const [suggestions, setSuggestions] = useState<Song[]>([]);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const previewPlayer = useRef<AudioPlayer | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPlayingRef = useRef(false);
  const existingIds = useMemo(() => new Set(songs.map((s) => s.id)), [songs]);
  // Read by `refresh` without being a dependency: adding a suggestion refetches
  // the list, and that must not throw away and redraw the other suggestions.
  const songsRef = useRef(songs);
  songsRef.current = songs;
  const existingRef = useRef(existingIds);
  existingRef.current = existingIds;
  // Only the latest request may land; an older one finishing late is dropped.
  const requestRef = useRef(0);
  const unmountedRef = useRef(false);

  /** Puts the music back the way the preview found it. Sets, never toggles:
   *  if the listener pressed play meanwhile, it is already playing. */
  const resumeMusic = useCallback(() => {
    if (!wasPlayingRef.current) return;
    wasPlayingRef.current = false;
    if (!usePlayerStore.getState().isPlaying) resumeHere();
  }, []);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      requestRef.current++;
    };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    const result = await fetchSuggestions(
      songsRef.current,
      existingRef.current,
      () => request !== requestRef.current,
    );
    if (request !== requestRef.current) return;
    setSuggestions(result);
  }, []);

  // Once, when the list's songs are first known. Refresh asks again.
  const hasSongs = songs.length > 0;
  useEffect(() => {
    if (hasSongs) void refresh();
  }, [hasSongs, refresh]);

  const addOne = useCallback(
    async (song: Song) => {
      try {
        if (await onAdd(song)) setSuggestions((prev) => prev.filter((s) => s.id !== song.id));
      } catch {
        // Wherever it is being added has already said what went wrong; the
        // row stays put so the try isn't spent.
      }
    },
    [onAdd],
  );

  // `remove()` alone leaves the native player sounding until it is collected.
  const stopPreview = useCallback(() => {
    if (previewTimer.current) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    const p = previewPlayer.current;
    previewPlayer.current = null;
    if (p && activePreview?.player === p) activePreview = null;
    if (!unmountedRef.current) setPreviewing(null);
    if (p) {
      try {
        p.pause();
        p.remove();
      } catch {}
    }
    resumeMusic();
  }, [resumeMusic]);

  // Leaving the screen, or the app, ends the preview.
  const focusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'background') stopPreview();
      });
      return () => {
        focusedRef.current = false;
        sub.remove();
        stopPreview();
      };
    }, [stopPreview]),
  );

  // The music starting some other way ends the preview, and it stays playing.
  useEffect(
    () =>
      usePlayerStore.subscribe((s, prev) => {
        if (s.isPlaying && !prev.isPlaying && previewPlayer.current) {
          wasPlayingRef.current = false;
          stopPreview();
        }
      }),
    [stopPreview],
  );

  const previewSong = useCallback(
    (song: Song) => {
      if (previewing === song.id) {
        stopPreview();
        return;
      }
      activePreview?.stop();
      stopPreview();
      if (!auth) return;
      const url = song.url || streamUrl(auth, song.id);
      if (!url) return;
      wasPlayingRef.current = usePlayerStore.getState().isPlaying;
      if (wasPlayingRef.current) pauseHere();
      // No precise timing: the preview only has to land near second 38, and on
      // iOS the exact seek scans the whole file first, which is the wait.
      const player = createAudioPlayer({ uri: url, preferPreciseTiming: false });
      previewPlayer.current = player;
      activePreview = { player, stop: stopPreview };
      player.play();
      const startSec = (song.duration ?? 0) > 38 ? 38 : 0;
      if (startSec > 0) player.seekTo(startSec);
      setPreviewing(song.id);
      previewTimer.current = setTimeout(stopPreview, 45_000);
    },
    [auth, previewing, stopPreview],
  );

  // What was added some other way meanwhile is no longer a suggestion.
  const visible = suggestions.filter((s) => !existingIds.has(s.id));
  if (visible.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('Suggested tracks')}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {visible.map((song) => (
        <Pressable key={song.id} style={styles.row} onPress={() => previewSong(song)}>
          <View style={styles.artwork}>
            <Cover uri={songCoverUrl(song, COVER.thumb)} size={48} />
          </View>
          <View style={styles.info}>
            <Text
              style={[styles.songTitle, previewing === song.id && { color: colors.accent }]}
              numberOfLines={1}
            >
              {song.title}
            </Text>
            {song.artist ? (
              <Text style={styles.artist} numberOfLines={1}>
                {song.artist}
              </Text>
            ) : null}
          </View>
          <Pressable
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={addLabel}
            onPress={() => void addOne(song)}
            style={({ pressed }) => [styles.addButton, pressed && { opacity: 0.6 }]}
          >
            <Icon name="add-circle-outline" size={26} color={colors.text} />
          </Pressable>
        </Pressable>
      ))}
      <Pressable
        onPress={() => void refresh()}
        style={({ pressed }) => [styles.refreshButton, pressed && { opacity: 0.6 }]}
      >
        <Text style={styles.refreshText}>{t('Refresh')}</Text>
      </Pressable>
    </View>
  );
}

const styles = themed((colors) => ({
  section: {
    marginTop: spacing.xl,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    letterSpacing: tracking.heading,
    fontWeight: '500',
    marginBottom: spacing.xs,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginBottom: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  artwork: {
    width: 48,
    height: 48,
  },
  info: { flex: 1 },
  songTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '500' },
  artist: { color: colors.textSecondary, fontSize: fontSize.xs },
  addButton: { padding: spacing.xs },
  refreshButton: {
    alignSelf: 'center',
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: 999,
    backgroundColor: colors.surfaceHighlight,
  },
  refreshText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '500' },
}));
