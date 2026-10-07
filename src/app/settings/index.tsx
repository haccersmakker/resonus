/**
 * Spotify-style Settings: the account at the top as a profile row (avatar +
 * name + server), categories as flat rows, restore settings, the sign out
 * pill button and a footer with the repo link.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Dialog } from '@/components/Dialog';
import { ScreenHeader, settingsStyles } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { useDownloads } from '@/store/downloads';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing } from '@/theme';

export default function SettingsScreen() {
  const router = useRouter();
  const t = useT();
  const auth = useAuthStore((s) => s.auth);
  // The avatar ring reads the store's accent to recolor when changed.
  const accentColor = useSettings((s) => s.accentColor);
  useSettings((s) => s.appFont); // re-render when font changes
  const resetToDefaults = useSettings((s) => s.resetToDefaults);
  const logout = useAuthStore((s) => s.logout);
  const goOnline = useAuthStore((s) => s.goOnline);
  const goOffline = useAuthStore((s) => s.goOffline);
  const offline = useAuthStore((s) => s.offline);
  // Only offer "go offline" manually if there's something downloaded to listen to.
  // Until the catalog has been read, an empty map means "not known yet", not
  // "nothing downloaded". Hiding the switch on that basis is what made it
  // disappear for the first seconds on a large library, which is exactly the
  // library that needs it.
  const hasDownloads = useDownloads((s) => !s.hydrated || Object.keys(s.files).length > 0);
  const toast = useToast((s) => s.show);
  // Restore defaults: affects all settings, that's why it lives here (in the
  // index) and not inside a specific category.
  const [confirmReset, setConfirmReset] = useState(false);

  // Server account in offline mode (auth intact) vs local profile (no auth).
  const serverOffline = offline && !!auth;
  const initial = serverOffline
    ? (auth?.username ?? '?').charAt(0).toUpperCase()
    : offline
      ? 'O'
      : (auth?.username ?? '?').charAt(0).toUpperCase();
  const name = offline && !auth ? t('Local profile') : auth?.username ?? '—';
  const detail = serverOffline
    ? t('Offline · your downloads')
    : offline
      ? t('Music on your device')
      : auth?.serverUrl.replace(/^https?:\/\//, '') ?? '';

  // In offline, Playback also appears: the screen itself hides what's server-
  // side (bitrates, autoplay) and leaves what applies locally (crossfade,
  // online lyrics). "Library" becomes the local music.
  const sections: {
    key: string;
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    href?: string;
  }[] = [
    { key: 'playback', title: 'Quality & playback', icon: 'musical-notes-outline' as const },
    { key: 'player', title: 'Player', icon: 'play-circle-outline' as const },
    ...(!offline
      ? [
          {
            key: 'jam',
            title: 'Listening together',
            icon: 'people-outline' as const,
            href: '/jam',
          },
        ]
      : []),
    // Downloads: in server-offline it reduces to used space and delete (no
    // server means no downloading, but freeing space is still useful). In the
    // local profile (no account) there are NO server downloads, so it's skipped.
    ...(offline && !auth
      ? []
      : [{ key: 'downloads', title: 'Downloads', icon: 'download-outline' as const }]),
    // Library: online is the server's; in local profile, the device's music.
    // In server-offline it's hidden: its content is server-side (scanning,
    // libraries) which doesn't apply offline, and download management already
    // lives in the "Downloads" section above (avoid duplication).
    ...(serverOffline
      ? []
      : [
          {
            key: 'library',
            title: offline ? 'Local music' : 'Library',
            icon: offline
              ? ('phone-portrait-outline' as const)
              : ('server-outline' as const),
          },
        ]),
    // Network: multiple server URLs and automatic switching. Server only.
    ...(offline
      ? []
      : [{ key: 'network', title: 'Network', icon: 'git-network-outline' as const }]),
    // Theme lives inside Appearance (row with chevron, like Language).
    { key: 'personalization', title: 'Appearance', icon: 'color-palette-outline' as const },
    { key: 'about', title: 'About::app', icon: 'information-circle-outline' as const },
  ];

  return (
    <SafeAreaView style={settingsStyles.safe} edges={['top']}>
      <ScreenHeader title={t('Settings')} />
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <View style={styles.profileRow}>
          <View style={[styles.avatar, { borderColor: accentColor }]}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <View style={settingsStyles.rowLabelBox}>
            <Text style={styles.profileName}>{name}</Text>
            <Text style={settingsStyles.rowDescription} numberOfLines={1}>
              {detail}
            </Text>
          </View>
        </View>

        {sections.map((s) => (
          <Pressable
            key={s.key}
            style={({ pressed }) => [styles.sectionRow, pressed && { opacity: 0.6 }]}
            onPress={() => router.push(s.href ?? `/settings/${s.key}`)}
          >
            <Ionicons name={s.icon} size={24} color={colors.text} />
            <Text style={styles.sectionRowTitle}>{t(s.title)}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </Pressable>
        ))}

        <Pressable
          style={({ pressed }) => [styles.sectionRow, pressed && { opacity: 0.6 }]}
          onPress={() => setConfirmReset(true)}
        >
          <Ionicons name="arrow-undo-outline" size={24} color={colors.textSecondary} />
          <Text style={[styles.sectionRowTitle, { color: colors.textSecondary }]}>
            {t('Restore default settings')}
          </Text>
        </Pressable>

        <View style={styles.sessionRow}>
          {/* MODE action (outline pill, left): same placement online and offline.
              Online with downloads: go offline manually; server offline: go back
              online. Both reload the library, so they navigate to Home. */}
          {!offline && auth && hasDownloads ? (
            <Pressable
              style={({ pressed }) => [styles.offlinePill, pressed && { opacity: 0.6 }]}
              onPress={() => {
                void goOffline(false);
                toast(t('Offline'));
                router.replace('/(tabs)');
              }}
            >
              <Ionicons name="cloud-offline-outline" size={18} color="#000" />
              <Text style={styles.offlinePillText}>{t('Offline mode')}</Text>
            </Pressable>
          ) : serverOffline ? (
            <Pressable
              style={({ pressed }) => [styles.offlinePill, pressed && { opacity: 0.6 }]}
              onPress={() => {
                void goOnline();
                router.replace('/(tabs)');
              }}
            >
              <Ionicons name="cloud-outline" size={18} color="#000" />
              <Text style={styles.offlinePillText}>{t('Back online')}</Text>
            </Pressable>
          ) : null}

          {/* Sign out (dark outline pill + icon): same style and position online
              and offline. In local profile it's "Exit local mode". logout()
              doesn't need network, so it works offline. */}
          <Pressable
            style={({ pressed }) => [styles.offlinePill, pressed && { opacity: 0.6 }]}
            onPress={() => logout()}
          >
            <Ionicons name="log-out-outline" size={18} color="#000" />
            <Text style={styles.offlinePillText}>
              {offline && !auth ? t('Exit local mode') : t('Sign out')}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      <Dialog
        visible={confirmReset}
        title={t('Restore default settings')}
        message={t('Your preferences will go back to their defaults. Your language stays.')}
        confirmLabel={t('Restore')}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          resetToDefaults();
          toast(t('Settings restored'));
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  // Same avatar as the Home header (accent ring) for consistency.
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceHighlight,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700' },
  profileName: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md + 2,
  },
  sectionRowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', flex: 1 },
  // Row with session actions (manual offline + exit), centered.
  sessionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  // Light solid pill for session actions (mode toggle and sign out): white
  // background with black text and icons, so they stand out.
  offlinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: '#fff',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  offlinePillText: { color: '#000', fontSize: fontSize.sm, fontWeight: '600' },
});
