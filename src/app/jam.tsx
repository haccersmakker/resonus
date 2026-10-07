import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { SettingsPage, settingsStyles } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { normalizeListeningSessionCode } from '@/lib/listeningSessions';
import { useAuthStore } from '@/store/auth';
import {
  listeningSessionServerMatches,
  type ListeningSessionJoinTarget,
  useListeningSession,
} from '@/store/listeningSession';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing } from '@/theme';

export default function JamScreen() {
  useSettings((state) => state.accentColor);
  const t = useT();
  const router = useRouter();
  const toast = useToast((state) => state.show);
  const params = useLocalSearchParams<{
    code?: string | string[];
    coordinator?: string | string[];
    libraryId?: string | string[];
    server?: string | string[];
  }>();
  const auth = useAuthStore((state) => state.auth);
  const offline = useAuthStore((state) => state.offline);
  const queueLength = usePlayerStore((state) => state.queue.length);
  const status = useListeningSession((state) => state.status);
  const supported = useListeningSession((state) => state.supported);
  const room = useListeningSession((state) => state.room);
  const error = useListeningSession((state) => state.error);
  const coordinatorUrl = useListeningSession((state) => state.coordinatorUrl);
  const coordinatorHydrated = useListeningSession((state) => state.coordinatorHydrated);
  const setCoordinatorUrl = useListeningSession((state) => state.setCoordinatorUrl);
  const checkSupport = useListeningSession((state) => state.checkSupport);
  const start = useListeningSession((state) => state.start);
  const join = useListeningSession((state) => state.join);
  const leave = useListeningSession((state) => state.leave);
  const end = useListeningSession((state) => state.end);
  const shareInvite = useListeningSession((state) => state.shareInvite);
  const deepLinkCode = normalizeListeningSessionCode(
    Array.isArray(params.code) ? params.code[0] : (params.code ?? ''),
  );
  const sharedServer = Array.isArray(params.server) ? params.server[0] : params.server;
  const sharedCoordinator = Array.isArray(params.coordinator)
    ? params.coordinator[0]
    : params.coordinator;
  const sharedLibraryId = Array.isArray(params.libraryId)
    ? params.libraryId[0]
    : params.libraryId;
  const deepLinkTarget: ListeningSessionJoinTarget | null = useMemo(
    () =>
      sharedCoordinator &&
      sharedServer &&
      sharedLibraryId &&
      /^sha256:[a-f0-9]{64}$/.test(sharedLibraryId)
        ? {
            coordinatorUrl: sharedCoordinator,
            serverUrl: sharedServer,
            libraryId: sharedLibraryId,
          }
        : null,
    [sharedCoordinator, sharedLibraryId, sharedServer],
  );
  const [code, setCode] = useState(deepLinkCode);
  const [coordinatorInput, setCoordinatorInput] = useState(coordinatorUrl);
  const [sharing, setSharing] = useState(false);
  const sharingRef = useRef(false);
  const shareUnlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptedDeepLink = useRef<string | null>(null);
  const serverMismatch =
    !room &&
    !!sharedServer &&
    !!auth &&
    !listeningSessionServerMatches(auth, sharedServer);
  const busy = status === 'checking' || status === 'connecting' || status === 'leaving';

  useEffect(() => {
    if (deepLinkCode) setCode(deepLinkCode);
  }, [deepLinkCode]);

  useEffect(() => {
    if (!coordinatorHydrated) return;
    setCoordinatorInput(sharedCoordinator ?? coordinatorUrl);
  }, [coordinatorHydrated, coordinatorUrl, sharedCoordinator]);

  useEffect(
    () => () => {
      if (shareUnlockTimer.current) clearTimeout(shareUnlockTimer.current);
    },
    [],
  );

  useEffect(() => {
    const coordinator = deepLinkTarget?.coordinatorUrl ?? coordinatorUrl;
    if (!auth || offline || room || !coordinatorHydrated || !coordinator) return;
    void checkSupport(coordinator);
  }, [auth, checkSupport, coordinatorHydrated, coordinatorUrl, deepLinkTarget?.coordinatorUrl, offline, room]);

  useEffect(() => {
    if (!deepLinkCode) {
      attemptedDeepLink.current = null;
      return;
    }
    const invite = `${sharedCoordinator ?? ''}\0${sharedServer ?? ''}\0${sharedLibraryId ?? ''}\0${deepLinkCode}`;
    if (room) {
      // Android can deliver the same invite again while this screen is already
      // connected. Remove its params now; otherwise they survive until the
      // room ends and then silently retry a stale code.
      attemptedDeepLink.current = invite;
      router.replace('/jam');
      return;
    }
    if (
      attemptedDeepLink.current === invite ||
      !deepLinkTarget ||
      serverMismatch ||
      supported !== true ||
      busy
    ) {
      return;
    }
    attemptedDeepLink.current = invite;
    void join(deepLinkCode, deepLinkTarget)
      .then(() => router.replace('/jam'))
      .catch(() => {});
  }, [busy, deepLinkCode, deepLinkTarget, join, room, router, serverMismatch, sharedCoordinator, sharedLibraryId, sharedServer, supported]);

  function saveCoordinator() {
    setCoordinatorUrl(coordinatorInput);
  }

  function startConfiguredJam() {
    saveCoordinator();
    return start();
  }

  function joinConfiguredJam() {
    if (!deepLinkTarget) saveCoordinator();
    return join(code, deepLinkTarget ?? undefined);
  }

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      toast(cause instanceof Error ? t(cause.message) : t("Couldn't complete the action"));
    }
  }

  async function share() {
    // React state does not update until the next render, so it cannot stop
    // multiple taps delivered in the same frame. Lock synchronously before
    // opening Android's chooser to prevent stacked share activities.
    if (sharingRef.current) return;
    const shared = shareInvite();
    if (!shared) return;
    sharingRef.current = true;
    setSharing(true);
    try {
      await Share.share({
        message: t('Join this Open Listening Session:\n{invite}\nOpen in Resonus: {url}', {
          invite: JSON.stringify(shared.invite),
          url: shared.appUrl,
        }),
      });
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t("Couldn't complete the action"));
    } finally {
      // Some Android chooser versions resolve Share.share() as soon as the
      // chooser launches. Keep the lock through the remaining queued taps.
      shareUnlockTimer.current = setTimeout(() => {
        shareUnlockTimer.current = null;
        sharingRef.current = false;
        setSharing(false);
      }, 1500);
    }
  }

  return (
    <SettingsPage title={t('Listening together')}>
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="people" size={34} color="#000" />
          </View>
          <Text style={styles.heroTitle}>{t('Jam')}</Text>
          <Text style={styles.heroText}>
            {t(
              'Everyone streams from this server. Only the queue and playback controls are synchronized.',
            )}
          </Text>
        </View>

        {offline || !auth ? (
          <Notice
            icon="cloud-offline-outline"
            text={t('Listening together requires an online OpenSubsonic server.')}
          />
        ) : serverMismatch ? (
          <Notice
            icon="server-outline"
            text={t('This Jam belongs to a different server. Switch to its Resonus profile first.')}
          />
        ) : room && (status === 'connected' || status === 'leaving') ? (
          <ConnectedRoom
            busy={busy}
            sharing={sharing}
            onShare={() => void share()}
            onLeave={() => void run(leave)}
            onEnd={() => void run(end)}
          />
        ) : (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('Group listening server')}</Text>
            <Text style={settingsStyles.sectionDescription}>
              {t(
                'This coordinator is separate from your music server and synchronizes controls only.',
              )}
            </Text>
            <TextInput
              value={coordinatorInput}
              onChangeText={setCoordinatorInput}
              onEndEditing={saveCoordinator}
              editable={!deepLinkTarget}
              style={styles.coordinatorInput}
              placeholder="https://sessions.example"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {status === 'checking' ? (
              <Loading label={t('Checking the group listening server…')} />
            ) : supported === false || status === 'unsupported' ? (
              <Notice
                icon="extension-puzzle-outline"
                text={t('This server does not support Open Listening Sessions version 1.')}
              />
            ) : (
              <>
                <Text style={settingsStyles.sectionTitle}>{t('Start a Jam')}</Text>
                <Text style={settingsStyles.sectionDescription}>
                  {t('You host the current queue and approve every playback change.')}
                </Text>
                <ActionButton
                  icon="radio-outline"
                  label={t('Start Jam')}
                  disabled={busy || queueLength === 0 || !coordinatorInput.trim()}
                  onPress={() => void run(startConfiguredJam)}
                />
                {queueLength === 0 ? (
                  <Text style={styles.hint}>{t('Play something before starting a Jam.')}</Text>
                ) : null}

                <Text style={settingsStyles.sectionTitle}>{t('Join a Jam')}</Text>
                <Text style={settingsStyles.sectionDescription}>
                  {t('Paste the short code, or open a Resonus Jam link.')}
                </Text>
                <View style={styles.codeRow}>
                  <TextInput
                    value={code}
                    onChangeText={(value) => setCode(normalizeListeningSessionCode(value))}
                    style={styles.codeInput}
                    placeholder={t('Jam code')}
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    selectTextOnFocus
                    maxLength={12}
                    returnKeyType="join"
                    onSubmitEditing={() => {
                      if (code.length >= 4 && !busy) void run(joinConfiguredJam);
                    }}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || code.length < 4 || !coordinatorInput.trim()}
                    style={({ pressed }) => [
                      styles.joinButton,
                      (busy || code.length < 4 || !coordinatorInput.trim()) && styles.disabled,
                      pressed && { opacity: 0.65 },
                    ]}
                    onPress={() => void run(joinConfiguredJam)}
                  >
                    {status === 'connecting' ? (
                      <ActivityIndicator color="#000" />
                    ) : (
                      <Text style={styles.primaryLabel}>{t('Join')}</Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </>
        )}

        {error ? <Text style={styles.error}>{t(error)}</Text> : null}
      </ScrollView>
    </SettingsPage>
  );
}

function ConnectedRoom({
  busy,
  sharing,
  onShare,
  onLeave,
  onEnd,
}: {
  busy: boolean;
  sharing: boolean;
  onShare: () => void;
  onLeave: () => void;
  onEnd: () => void;
}) {
  const t = useT();
  const room = useListeningSession((state) => state.room);
  if (!room) return null;
  const isHost = room.role === 'host';

  return (
    <>
      <View style={styles.codeCard}>
        <Text style={styles.codeLabel}>{t('Jam code')}</Text>
        <Text selectable style={styles.codeValue}>
          {room.code}
        </Text>
        <Text style={styles.role}>
          {isHost ? t('You are the host') : t('The host controls the queue')}
        </Text>
      </View>

      <Text style={settingsStyles.sectionTitle}>
        {t('{n} people connected', { n: room.participants.length })}
      </Text>
      <View style={settingsStyles.cardBox}>
        {room.participants.map((participant, index) => (
          <View
            key={participant.id}
            style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}
          >
            <Ionicons
              name={participant.role === 'host' ? 'radio' : 'person-outline'}
              size={20}
              color={participant.role === 'host' ? colors.accent : colors.textSecondary}
            />
            <Text style={[settingsStyles.rowLabel, { flex: 1 }]}>{participant.displayName}</Text>
            <Text style={settingsStyles.rowValue}>
              {participant.role === 'host' ? t('Host') : t('Guest')}
            </Text>
          </View>
        ))}
      </View>

      {isHost ? (
        <>
          <ActionButton
            icon="share-outline"
            label={t('Share Jam link')}
            disabled={busy || sharing}
            onPress={onShare}
          />
          <SecondaryButton label={t('End Jam')} destructive disabled={busy} onPress={onEnd} />
        </>
      ) : (
        <SecondaryButton label={t('Leave Jam')} disabled={busy} onPress={onLeave} />
      )}
    </>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.hint}>{label}</Text>
    </View>
  );
}

function Notice({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.notice}>
      <Ionicons name={icon} size={24} color={colors.textSecondary} />
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled && styles.disabled,
        pressed && { opacity: 0.65 },
      ]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={20} color="#000" />
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  destructive,
  disabled,
  onPress,
}: {
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.secondaryButton,
        disabled && styles.disabled,
        pressed && { opacity: 0.65 },
      ]}
      onPress={onPress}
    >
      <Text style={[styles.secondaryLabel, destructive && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.sm },
  heroIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  heroTitle: { color: colors.text, fontSize: fontSize.xl, fontWeight: '800' },
  heroText: { color: colors.textSecondary, fontSize: fontSize.sm, textAlign: 'center' },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  noticeText: { color: colors.textSecondary, fontSize: fontSize.sm, flex: 1 },
  loading: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  hint: { color: colors.textMuted, fontSize: fontSize.xs },
  primaryButton: {
    minHeight: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  primaryLabel: { color: '#000', fontSize: fontSize.md, fontWeight: '800' },
  disabled: { opacity: 0.4 },
  codeRow: { flexDirection: 'row', gap: spacing.sm },
  codeInput: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.lg,
    fontWeight: '700',
    letterSpacing: 3,
  },
  coordinatorInput: {
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.sm,
  },
  joinButton: {
    minWidth: 88,
    minHeight: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  codeCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xl,
    gap: spacing.xs,
  },
  codeLabel: { color: colors.textSecondary, fontSize: fontSize.sm },
  codeValue: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 7,
  },
  role: { color: colors.textMuted, fontSize: fontSize.xs },
  secondaryButton: { alignItems: 'center', paddingVertical: spacing.lg },
  secondaryLabel: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  error: { color: colors.danger, fontSize: fontSize.sm, textAlign: 'center' },
});
