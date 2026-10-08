/**
 * Listening together: start a room, join one by its code or an invitation,
 * and see who is in it.
 *
 * An invitation link (`resonus://listen-together?…`) opens this screen with
 * the room filled in and waits for a tap: a link can come from anywhere, and
 * following one connects to a server its sender chose, so joining stays the
 * person's decision. The link's values are checked before anything is shown.
 */
import Icon from '@/components/Icon';
import { useLinkingURL } from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, Text, TextInput, View } from 'react-native';

import { Dialog } from '@/components/Dialog';
import { SettingsGroup, SettingsPage, settingsStyles } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import {
  OLS_MAX_NAME_CHARS,
  normalizeOlsCoordinatorUrl,
  olsInviteFromRoute,
  parseOlsInviteText,
  type OlsInvite,
} from '@/lib/listeningSessions';
import { useAuthStore } from '@/store/auth';
import { profileServesInvite, useListeningSession } from '@/store/listeningSession';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

/** The host part of an address, for showing where an invitation points. */
const hostOf = (url: string) => url.replace(/^https?:\/\//, '');

export default function ListenTogetherScreen() {
  // Repaints on a change of appearance or accent while the stack keeps it.
  const { accent } = useTheme();
  const t = useT();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams();
  const linkingUrl = useLinkingURL();
  const linkInvite = useMemo(() => olsInviteFromRoute(params, linkingUrl), [params, linkingUrl]);
  const linkBroken = !linkInvite && ['coordinator', 'server', 'libraryId', 'code'].some((k) => k in params);
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const status = useListeningSession((s) => s.status);
  const room = useListeningSession((s) => s.room);
  const error = useListeningSession((s) => s.error);
  const held = useListeningSession((s) => s.heldLocally);
  const lastJoin = useListeningSession((s) => s.lastJoin);
  const hydrated = useListeningSession((s) => s.hydrated);
  const savedCoordinator = useListeningSession((s) => s.coordinatorUrl);
  const savedName = useListeningSession((s) => s.displayName);
  const [coordinator, setCoordinator] = useState(savedCoordinator);
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  // A second tap lands before the status it set has re-rendered the button.
  const busyRef = useRef(false);

  // What was saved fills the fields once it has been read, in the render that
  // finds it read: normally that is the first one, since it is read at launch.
  const [filled, setFilled] = useState(hydrated);
  if (hydrated && !filled) {
    setFilled(true);
    setCoordinator(savedCoordinator);
    setName(savedName);
  }

  const available = !!auth && !offline && auth.serverType !== 'jellyfin';
  const inRoom = !!room && (status === 'connected' || status === 'leaving');
  const busy = status !== 'idle' && status !== 'connected';
  const coordinatorValid = !!normalizeOlsCoordinatorUrl(coordinator);
  const pasted = parseOlsInviteText(code);
  const pastedInvite = pasted && 'invite' in pasted ? pasted.invite : null;
  const invite: OlsInvite | null = linkInvite ?? pastedInvite;
  const wrongServer = !!invite && !profileServesInvite(invite);

  const run = (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    void action().finally(() => {
      busyRef.current = false;
    });
  };

  const save = () => {
    const s = useListeningSession.getState();
    s.setCoordinatorUrl(coordinator);
    s.setDisplayName(name.trim());
  };

  const start = () =>
    run(async () => {
      save();
      await useListeningSession.getState().start();
    });

  const join = (target: { code: string } | { invite: OlsInvite }) =>
    run(async () => {
      save();
      await useListeningSession.getState().join(target);
    });

  const leave = () => run(() => useListeningSession.getState().leave());

  const share = () =>
    run(async () => {
      const shared = useListeningSession.getState().invite();
      if (!shared) return;
      try {
        // Both forms: the link opens Resonus, and the JSON is the invitation
        // any other client that speaks the protocol can read.
        await Share.share({
          message: [
            t('Listen with me on Resonus: {link}', { link: shared.link }),
            t('Room code: {code}', { code: shared.invite.code }),
            JSON.stringify(shared.invite),
          ].join('\n\n'),
        });
      } catch {
        toast(t("Couldn't complete the action"));
      }
      // Android hands the chooser over and answers at once, so a quick second
      // tap would stack another one on top: the button stays taken a moment.
      await new Promise((r) => setTimeout(r, 1000));
    });

  return (
    <SettingsPage title={t('Listening together')}>
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          {t(
            'Play the same music at the same moment as other people on your server. Everyone streams from their own account; only the queue and the controls are shared.',
          )}
        </Text>

        {!available && !inRoom ? (
          <Notice icon="cloud-offline-outline" text={t('Listening together needs a Subsonic server and a connection.')} />
        ) : inRoom && room ? (
          <>
            <View style={[settingsStyles.cardBox, styles.codeCard]}>
              <Text style={styles.codeLabel}>{t('Room code')}</Text>
              <Text selectable style={styles.code} accessibilityLabel={room.code.split('').join(' ')}>
                {room.code}
              </Text>
              <Text style={styles.role}>
                {room.role === 'host'
                  ? t('You’re the host: your queue is the room’s.')
                  : t('The host chooses what plays. Your buttons ask the host.')}
              </Text>
            </View>
            {linkInvite && linkInvite.code !== room.code ? (
              <Notice icon="alert-circle-outline" text={t('Leave this room to join another one.')} />
            ) : null}
            {held ? (
              <Notice
                icon="pause-circle-outline"
                text={t('Paused on this phone. The room is still playing: press play to catch up.')}
              />
            ) : null}
            <Button
              icon="share-social-outline"
              label={t('Share invitation')}
              accent={accent}
              disabled={busy}
              onPress={share}
            />
            <Button
              label={room.role === 'host' ? t('End the room') : t('Leave the room')}
              destructive={room.role === 'host'}
              secondary
              accent={accent}
              busy={status === 'leaving'}
              disabled={status === 'leaving'}
              // Ending is for everybody, so it is asked once more; leaving is
              // only this phone's, and is not.
              onPress={room.role === 'host' ? () => setConfirmEnd(true) : leave}
            />
            <Text style={settingsStyles.sectionTitle}>
              {t('In the room ({n})', { n: room.participants.length })}
            </Text>
            <SettingsGroup>
              {room.participants.map((p) => (
                <View key={p.id} style={settingsStyles.row}>
                  <Icon
                    name={p.role === 'host' ? 'radio-outline' : 'person-outline'}
                    size={20}
                    color={p.role === 'host' ? accent : colors.textSecondary}
                  />
                  <Text style={[settingsStyles.rowLabel, styles.flex]} numberOfLines={1}>
                    {p.displayName || t('Listener')}
                    {p.id === room.selfParticipantId ? ` · ${t('You')}` : ''}
                  </Text>
                  <Text style={settingsStyles.rowValue}>
                    {p.role === 'host' ? t('Host') : t('Guest')}
                  </Text>
                </View>
              ))}
            </SettingsGroup>
          </>
        ) : (
          <>
            {invite ? (
              <View style={[settingsStyles.cardBox, styles.inviteCard]}>
                <Text style={styles.codeLabel}>{t('Invitation')}</Text>
                <Text style={styles.code}>{invite.code}</Text>
                <Text style={styles.role} numberOfLines={2}>
                  {t('Music from {server} · room on {coordinator}', {
                    server: hostOf(invite.mediaProfile.server),
                    coordinator: hostOf(invite.coordinator),
                  })}
                </Text>
                {wrongServer ? (
                  <Text style={styles.warning}>
                    {t('That room plays from another server. Switch to that server’s profile first.')}
                  </Text>
                ) : (
                  <Button
                    icon="enter-outline"
                    label={t('Join')}
                    accent={accent}
                    busy={status === 'joining'}
                    disabled={busy}
                    onPress={() => join({ invite })}
                  />
                )}
              </View>
            ) : linkBroken ? (
              <Notice icon="alert-circle-outline" text={t('That invitation isn’t valid.')} />
            ) : null}

            <Text style={settingsStyles.sectionTitle}>{t('Your name')}</Text>
            <TextInput
              style={settingsStyles.textInput}
              value={name}
              onChangeText={setName}
              onEndEditing={save}
              placeholder={t('Listener')}
              placeholderTextColor={colors.textMuted}
              maxLength={OLS_MAX_NAME_CHARS}
              autoCorrect={false}
              accessibilityLabel={t('Your name')}
            />
            <Text style={settingsStyles.sectionDescription}>
              {t('What the others in the room see. Your account name on the server is never shared.')}
            </Text>

            {/* A link replaces the form; a pasted invitation leaves it, so the
                field it was pasted into can still be cleared. */}
            {!linkInvite ? (
              <>
                <Text style={settingsStyles.sectionTitle}>{t('Listening server')}</Text>
                <TextInput
                  style={settingsStyles.textInput}
                  value={coordinator}
                  onChangeText={setCoordinator}
                  onEndEditing={save}
                  placeholder="https://sessions.example"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  accessibilityLabel={t('Listening server')}
                />
                <Text style={settingsStyles.sectionDescription}>
                  {coordinator.trim() && !coordinatorValid
                    ? t('Enter the address of a listening server.')
                    : t(
                        'An Open Listening Sessions server. It is not your music server, and it never sees your password or what the songs are.',
                      )}
                </Text>

                <Text style={settingsStyles.sectionTitle}>{t('Start a room')}</Text>
                <Text style={settingsStyles.sectionDescription}>
                  {t('You host: what you play, everyone hears.')}
                </Text>
                <Button
                  icon="radio-outline"
                  label={t('Start a room')}
                  accent={accent}
                  busy={status === 'starting'}
                  disabled={busy || !coordinatorValid}
                  onPress={start}
                />

                <Text style={settingsStyles.sectionTitle}>{t('Join a room')}</Text>
                <View style={styles.codeRow}>
                  <TextInput
                    style={[settingsStyles.textInput, styles.codeInput]}
                    value={code}
                    onChangeText={setCode}
                    placeholder={t('Room code')}
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="go"
                    accessibilityLabel={t('Room code')}
                    onSubmitEditing={() => {
                      if (pasted && 'code' in pasted && coordinatorValid) join(pasted);
                    }}
                  />
                  <Button
                    label={t('Join')}
                    accent={accent}
                    busy={status === 'joining'}
                    disabled={busy || !pasted || !('code' in pasted) || !coordinatorValid}
                    onPress={() => {
                      if (pasted && 'code' in pasted) join(pasted);
                    }}
                  />
                </View>
                <Text style={settingsStyles.sectionDescription}>
                  {t('The code the host shared, or their whole invitation pasted here.')}
                </Text>
                {lastJoin && error ? (
                  <Button
                    icon="refresh"
                    label={t('Join again')}
                    secondary
                    accent={accent}
                    disabled={busy}
                    onPress={() => join(lastJoin)}
                  />
                ) : null}
              </>
            ) : null}
          </>
        )}

        {error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {t(error)}
          </Text>
        ) : null}
      </ScrollView>
      <Dialog
        visible={confirmEnd}
        title={t('End the room')}
        message={t('The music stops being shared, and everybody in the room leaves it.')}
        confirmLabel={t('End the room')}
        destructive
        onCancel={() => setConfirmEnd(false)}
        onConfirm={() => {
          setConfirmEnd(false);
          leave();
        }}
      />
    </SettingsPage>
  );
}

function Notice({ icon, text }: { icon: keyof typeof Icon.glyphMap; text: string }) {
  return (
    <View style={[settingsStyles.cardBox, styles.notice]}>
      <Icon name={icon} size={22} color={colors.textSecondary} />
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

function Button({
  label,
  icon,
  accent,
  secondary,
  destructive,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  icon?: keyof typeof Icon.glyphMap;
  accent: string;
  secondary?: boolean;
  destructive?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const fg = secondary ? (destructive ? colors.danger : colors.text) : colors.onAccent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.secondary : { backgroundColor: accent },
        disabled && styles.disabled,
        pressed && !disabled && { opacity: 0.7 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={20} color={fg} /> : null}
          <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = themed((colors) => ({
  flex: { flex: 1 },
  intro: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20, marginBottom: spacing.sm },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  noticeText: { color: colors.textSecondary, fontSize: fontSize.sm, flex: 1, lineHeight: 20 },
  codeCard: { alignItems: 'center', padding: spacing.xl, gap: spacing.xs },
  inviteCard: { alignItems: 'center', padding: spacing.lg, gap: spacing.sm },
  codeLabel: { color: colors.textSecondary, fontSize: fontSize.sm },
  code: { color: colors.text, fontSize: 34, fontWeight: '700', letterSpacing: 6 },
  role: { color: colors.textMuted, fontSize: fontSize.xs, textAlign: 'center' },
  warning: { color: colors.danger, fontSize: fontSize.sm, textAlign: 'center' },
  codeRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  codeInput: { flex: 1, letterSpacing: 2 },
  button: {
    minHeight: 48,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xs,
  },
  secondary: { backgroundColor: colors.surface },
  disabled: { opacity: 0.45 },
  buttonText: { fontSize: fontSize.md, fontWeight: '600' },
  error: { color: colors.danger, fontSize: fontSize.sm, textAlign: 'center', marginTop: spacing.md },
}));
