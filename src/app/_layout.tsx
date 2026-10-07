/**
 * Root layout: global providers and session control. Routes are protected
 * depending on whether a session is active, using expo-router's Stack.Protected.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppStartupTab } from '@/components/AppStartupTab';
import { ArtistPickerSheet } from '@/components/ArtistPickerSheet';
import { CarAutoSync } from '@/components/CarAutoSync';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { GlobalMiniPlayer } from '@/components/GlobalMiniPlayer';
import { MediaMenuSheet } from '@/components/MediaMenuSheet';
import { GlobalPlaylistPicker } from '@/components/PlaylistPickerSheet';
import { GlobalShareSheet } from '@/components/ShareSheet';
import { BatteryWarning } from '@/components/BatteryWarning';
import { SongInfoSheet } from '@/components/SongInfoSheet';
import { SongMenuSheet } from '@/components/SongMenuSheet';
import { Toast } from '@/components/Toast';
import { installAppFont, setAppFont } from '@/lib/appFont';
import { startPerfLog } from '@/lib/perfLog';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/store/auth';
import { useAutoDownloads } from '@/store/autoDownloads';
import { useDownloads } from '@/store/downloads';
import { useEqualizer } from '@/store/equalizer';
import { useLastPlayed } from '@/store/lastPlayed';
import { useLibraries } from '@/store/libraries';
import { initListeningSessionIntegration } from '@/store/listeningSession';
import { useLibraryMirror } from '@/store/libraryMirror';
import { useOfflineQueue } from '@/store/offlineQueue';
import { checkAutoUrlNow, initAutoUrl } from '@/store/autoUrl';
import { initNetworkType } from '@/store/networkType';
import { removeLegacyRadioCovers } from '@/lib/legacyRadioCovers';
import { usePins } from '@/store/pins';
import { initRemoteIntegration, usePlayerStore } from '@/store/player';
import { usePlayCounts } from '@/store/playCounts';
import { usePlayHistory } from '@/store/playHistory';
import { useRecentSearches } from '@/store/recentSearches';
import { APP_FONT_FAMILY, useSettings } from '@/store/settings';
import { useSortPrefs } from '@/store/sortPrefs';
import { colors } from '@/theme';

// Patches Text/TextInput once, before the first render.
installAppFont();

/** How long the offline copy of the library waits before being read, when the
 *  app has a server and nothing is going to ask for it yet. */
const MIRROR_DELAY_MS = 15_000;

export default function RootLayout() {
  // The selected font is applied on every render (and after hydrating settings):
  // so everything that gets repainted picks up the current family.
  const appFont = useSettings((s) => s.appFont);
  setAppFont(APP_FONT_FAMILY[appFont]);

  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const offlineSource = useAuthStore((s) => s.offlineSource);
  const hydrating = useAuthStore((s) => s.hydrating);
  const hydrate = useAuthStore((s) => s.hydrate);
  // With downloads, the local profile works without having chosen a music source.
  const hasDownloads = useDownloads((s) => Object.keys(s.files).length > 0);
  const ready = !!auth || (offline && (!!offlineSource || hasDownloads));
  // Active profile identified to reload recent searches when switching.
  // Depends on the PRIMARY URL (not the active one): when switching networks the
  // active URL changes but we stay on the same profile, so it must not reinitialize.
  const activeProfile = auth
    ? `${auth.urls?.[0] ?? auth.serverUrl}|${auth.username}`
    : offline
      ? 'offline'
      : '';

  useEffect(() => {
    const authReady = hydrate();
    // Before anything else, so the first seconds count too.
    startPerfLog();
    useSettings.getState().hydrate();
    useRecentSearches.getState().hydrate();
    usePlayCounts.getState().hydrate();
    usePlayHistory.getState().hydrate();
    useSortPrefs.getState().hydrate();
    void useLastPlayed.getState().hydrate();
    void usePins.getState().hydrate();
    void removeLegacyRadioCovers();
    // After the session is restored, never before: the downloads store reads
    // the account's own catalog, and with no account yet it falls back to
    // reading every one of them, which is both slow and wrong (#50).
    const downloadsReady = authReady.then(() => useDownloads.getState().hydrate());
    void useAutoDownloads.getState().hydrate();
    // Mirror + outbox for offline. Offline it is the library, so it is read
    // right away: a query could otherwise resolve before it is in memory and
    // stay empty until manually reloaded. Online nothing reads it, only writes
    // to it, and reading it is a JSON parse of the whole file on the JS thread
    // — tens of MB on a heavy install, in the middle of the cold start, which
    // is where the app was left showing placeholders (#50). There it waits.
    const startMirror = () =>
      Promise.all([
        useLibraryMirror.getState().load(),
        useOfflineQueue.getState().load(),
      ]).then(() => {
        if (useAuthStore.getState().offline) {
          void queryClient.invalidateQueries({ queryKey: ['playlists'] });
          void queryClient.invalidateQueries({ queryKey: ['starred'] });
        }
      });
    const mirrorReady = useAuthStore.getState().offline
      ? startMirror()
      : new Promise<void>((resolve) => setTimeout(() => resolve(startMirror()), MIRROR_DELAY_MS));
    // Clearing out a mirror grown before there was a rule for what belongs in
    // it. After the downloads, never before: an album whose songs are on disk
    // is worth keeping, and until they're hydrated it doesn't look like it.
    void Promise.all([downloadsReady, mirrorReady]).then(() => {
      useLibraryMirror.getState().prune(useDownloads.getState());
    });
    // Equalizer: reads device capabilities and applies saved settings.
    void useEqualizer.getState().hydrate();
    initNetworkType();
    // Server URL switching on network change (profiles with multiple URLs);
    // re-probes on profile switch as well.
    initAutoUrl();
    checkAutoUrlNow();
    // Libraries: hydrates the saved filter and refreshes the server list.
    void useLibraries
      .getState()
      .hydrate()
      .then(() => {
        const current = useAuthStore.getState().auth;
        if (current) void useLibraries.getState().load(current);
      });
    initRemoteIntegration();
    initListeningSessionIntegration();
  }, [hydrate, activeProfile]);

  // On entering a profile (server or local), resumes the saved queue
  // (without playing): first the device copy, then the server copy if not.
  useEffect(() => {
    if (ready) void usePlayerStore.getState().restoreQueue();
  }, [ready, activeProfile]);

  // Keep screen awake (setting). The native flag only acts with the app in
  // the foreground, so it doesn't waste extra battery in the background.
  const keepScreenAwake = useSettings((s) => s.keepScreenAwake);
  useEffect(() => {
    if (!keepScreenAwake) return;
    void activateKeepAwakeAsync('setting');
    return () => {
      void deactivateKeepAwake('setting');
    };
  }, [keepScreenAwake]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        {hydrating ? (
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.background,
            }}
          >
            <ActivityIndicator color={colors.accent} size="large" />
          </View>
        ) : (
          <ErrorBoundary>
          <View style={{ flex: 1 }}>
            <Stack
              screenOptions={{
                headerShown: false,
                // Fast crossfade between screens: on Android native transition
                // durations can't be adjusted and lateral pushes
                // (slide/ios_from_right) felt sluggish.
                animation: 'fade',
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Protected guard={ready}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="album/[id]" />
                <Stack.Screen name="playlist/[id]" />
                <Stack.Screen name="artist/[id]" />
                <Stack.Screen name="artist/discography/[id]" />
                <Stack.Screen name="browse/albums" />
                <Stack.Screen name="browse/artists" />
                <Stack.Screen name="browse/folder/[id]" />
                <Stack.Screen name="genres" />
                <Stack.Screen name="genre/[name]" />
                <Stack.Screen name="radio" />
                <Stack.Screen name="jam" />
                <Stack.Screen name="favorites" />
                <Stack.Screen name="favorites-add" />
                <Stack.Screen name="history" />
                <Stack.Screen name="settings/index" />
                <Stack.Screen name="settings/downloads" />
                <Stack.Screen name="settings/library" />
                <Stack.Screen name="settings/playback" />
                <Stack.Screen name="settings/player" />
                <Stack.Screen name="settings/language" />
                <Stack.Screen name="settings/font" />
                <Stack.Screen name="settings/personalization" />
                <Stack.Screen name="settings/explore-chips" />
                <Stack.Screen name="settings/song-menu" />
                <Stack.Screen name="settings/home-sections" />
                <Stack.Screen name="settings/equalizer" />
                <Stack.Screen name="settings/theme" />
                <Stack.Screen name="settings/about" />
              </Stack.Protected>
              <Stack.Protected guard={offline && !offlineSource && !hasDownloads}>
                <Stack.Screen name="offline" />
              </Stack.Protected>
              <Stack.Protected guard={!auth && !offline}>
                <Stack.Screen name="login" />
              </Stack.Protected>
              {/* Modals shared by server and offline (require active song).
                  Open from the bottom but with the short variant
                  (fade_from_bottom): native slide_from_bottom takes ~350 ms
                  fixed and opening the player felt slow. */}
              {/* containedTransparentModal (not plain modal nor transparentModal)
                  so the screen behind stays composited within the same stack
                  container and shows through while dragging the player down to
                  dismiss (Spotify-style reveal). On Android a plain
                  transparentModal is a separate window and only black shows
                  behind. The custom drag lives in player.tsx and translates the
                  opaque surface over it. */}
              <Stack.Screen
                name="player"
                options={{
                  presentation: 'containedTransparentModal',
                  animation: 'fade_from_bottom',
                  // Override the global opaque contentStyle: without this the
                  // modal container itself is painted with colors.background and
                  // dragging the player only exposes that dark surface, never the
                  // screen behind.
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen
                name="queue"
                options={{ presentation: 'modal', animation: 'fade_from_bottom' }}
              />
              <Stack.Screen
                name="lyrics"
                options={{ presentation: 'modal', animation: 'fade_from_bottom' }}
              />
            </Stack>
            {auth || offline ? <AppStartupTab /> : null}
            {auth || offline ? <GlobalMiniPlayer /> : null}
            {auth || offline ? <SongMenuSheet /> : null}
            {auth || offline ? <SongInfoSheet /> : null}
            {auth || offline ? <ArtistPickerSheet /> : null}
            {auth || offline ? <MediaMenuSheet /> : null}
            {auth || offline ? <GlobalPlaylistPicker /> : null}
            {auth || offline ? <GlobalShareSheet /> : null}
            {auth || offline ? <CarAutoSync /> : null}
            {auth || offline ? <BatteryWarning /> : null}
            <Toast />
          </View>
          </ErrorBoundary>
        )}
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
