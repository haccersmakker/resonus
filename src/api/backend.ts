/**
 * Dispatch by server type. Exposes the same surface as `subsonic.ts`
 * but chooses the implementation based on the active profile: Jellyfin has its
 * own API (`jellyfin.ts`); Navidrome, OpenSubsonic, and Ampache speak Subsonic.
 *
 * Stores and screens that need to pass explicit `auth` import from
 * here (others use `data.ts`, which also handles offline mode).
 */
import * as Jellyfin from './jellyfin';
import * as Subsonic from './subsonic';
import {
  type AlbumListType,
  type SongListSort,
  type StarType,
  type SubsonicAuth,
} from './subsonic';

export type {
  Album,
  AlbumListType,
  Artist,
  ArtistInfo,
  FolderContents,
  FolderEntry,
  Genre,
  GuestAlbum,
  LyricLine,
  MusicFolder,
  Playlist,
  RadioStation,
  SavedQueue,
  ScanStatus,
  SearchResult,
  Song,
  SongListSort,
  SongLyrics,
  StarType,
  Starred,
  SubsonicAuth,
} from './subsonic';
export { normalizeUrl, SubsonicRequestError } from './subsonic';

/** Implementation matching the profile (same signature in both). */
function api(auth: SubsonicAuth) {
  return auth.serverType === 'jellyfin' ? Jellyfin : Subsonic;
}

export function makeAuth(
  serverUrl: string,
  username: string,
  password: string,
  serverType?: string,
  plainAuth?: boolean,
): Promise<SubsonicAuth> {
  if (serverType === 'jellyfin') return Jellyfin.makeAuth(serverUrl, username, password);
  return Subsonic.makeAuth(serverUrl, username, password, serverType, plainAuth);
}

export const ping = (auth: SubsonicAuth) => api(auth).ping(auth);

/**
 * Does the server at `serverUrl` respond with these credentials? Short probe
 * (to choose among several candidate URLs when switching networks). The internal
 * `ping` aborts after 15 s; here we cut earlier with a race against the
 * timeout to avoid waiting too long for an unreachable URL.
 */
export async function reachable(
  auth: SubsonicAuth,
  serverUrl: string,
  timeoutMs = 4000,
): Promise<boolean> {
  const candidate: SubsonicAuth = { ...auth, serverUrl };
  try {
    await Promise.race([
      ping(candidate),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

export const getMusicFolders = (auth: SubsonicAuth) => api(auth).getMusicFolders(auth);

// Folder navigation: Subsonic protocol only (Jellyfin doesn't use it; the UI
// hides the section for that backend), so it delegates directly to Subsonic.
export const getIndexes = (auth: SubsonicAuth, musicFolderId?: string) =>
  Subsonic.getIndexes(auth, musicFolderId);

export const getMusicDirectory = (auth: SubsonicAuth, id: string) =>
  Subsonic.getMusicDirectory(auth, id);

export const getAlbumList = (
  auth: SubsonicAuth,
  type?: AlbumListType,
  size?: number,
  offset?: number,
  musicFolderId?: string,
) => api(auth).getAlbumList(auth, type, size, offset, musicFolderId);

export const getGenres = (auth: SubsonicAuth) => api(auth).getGenres(auth);

export const getAlbumsByGenre = (
  auth: SubsonicAuth,
  genre: string,
  size?: number,
  offset?: number,
  musicFolderId?: string,
) => api(auth).getAlbumsByGenre(auth, genre, size, offset, musicFolderId);

export const getSongList = (
  auth: SubsonicAuth,
  sort?: SongListSort,
  count?: number,
  offset?: number,
  musicFolderId?: string,
) => api(auth).getSongList(auth, sort, count, offset, musicFolderId);

export const searchSongs = (
  auth: SubsonicAuth,
  query: string,
  count?: number,
  musicFolderId?: string,
) => api(auth).searchSongs(auth, query, count, musicFolderId);

export const getSongsByGenre = (
  auth: SubsonicAuth,
  genre: string,
  count?: number,
  offset?: number,
  musicFolderId?: string,
) => api(auth).getSongsByGenre(auth, genre, count, offset, musicFolderId);

export const getAlbum = (auth: SubsonicAuth, id: string) => api(auth).getAlbum(auth, id);

/** Jam v1 is OpenSubsonic-only; Jellyfin does not expose server-local rooms. */
export const getSong = (auth: SubsonicAuth, id: string) => Subsonic.getSong(auth, id);

export const getArtists = (auth: SubsonicAuth, musicFolderId?: string) =>
  api(auth).getArtists(auth, musicFolderId);

export const getArtist = (auth: SubsonicAuth, id: string) => api(auth).getArtist(auth, id);

export const getArtistInfo = (auth: SubsonicAuth, id: string) => api(auth).getArtistInfo(auth, id);

export const getAppearsOn = (
  auth: SubsonicAuth,
  artistId: string,
  artistName: string,
  musicFolderId?: string,
) => api(auth).getAppearsOn(auth, artistId, artistName, musicFolderId);

export const getTopSongs = (auth: SubsonicAuth, artist: string, count?: number) =>
  api(auth).getTopSongs(auth, artist, count);

export const getSimilarSongs = (auth: SubsonicAuth, id: string, count?: number) =>
  api(auth).getSimilarSongs(auth, id, count);

export const getMostPlayedSongs = (auth: SubsonicAuth, size?: number, musicFolderId?: string) =>
  api(auth).getMostPlayedSongs(auth, size, musicFolderId);

export const getRandomSongs = (
  auth: SubsonicAuth,
  size?: number,
  genre?: string,
  musicFolderId?: string,
) => api(auth).getRandomSongs(auth, size, genre, musicFolderId);

export const search = (auth: SubsonicAuth, query: string, musicFolderId?: string) =>
  api(auth).search(auth, query, musicFolderId);

export const searchAlbums = (
  auth: SubsonicAuth,
  query: string,
  count?: number,
  musicFolderId?: string,
) => api(auth).searchAlbums(auth, query, count, musicFolderId);

export const getStarred = (auth: SubsonicAuth, musicFolderId?: string) =>
  api(auth).getStarred(auth, musicFolderId);

export const star = (auth: SubsonicAuth, id: string, type?: StarType) =>
  api(auth).star(auth, id, type);

export const unstar = (auth: SubsonicAuth, id: string, type?: StarType) =>
  api(auth).unstar(auth, id, type);

export const setRating = (auth: SubsonicAuth, id: string, rating: number) =>
  api(auth).setRating(auth, id, rating);

export const getPlaylists = (auth: SubsonicAuth) => api(auth).getPlaylists(auth);

export const getPlaylist = (auth: SubsonicAuth, id: string) => api(auth).getPlaylist(auth, id);

export const addToPlaylist = (auth: SubsonicAuth, playlistId: string, songId: string) =>
  api(auth).addToPlaylist(auth, playlistId, songId);

export const createPlaylist = (auth: SubsonicAuth, name: string) =>
  api(auth).createPlaylist(auth, name);

export const deletePlaylist = (auth: SubsonicAuth, id: string) =>
  api(auth).deletePlaylist(auth, id);

export const updatePlaylist = (
  auth: SubsonicAuth,
  id: string,
  changes: { name?: string; comment?: string; public?: boolean },
) => api(auth).updatePlaylist(auth, id, changes);

export const removeFromPlaylist = (auth: SubsonicAuth, id: string, index: number) =>
  api(auth).removeFromPlaylist(auth, id, index);

// Reordering: Subsonic protocol only (Jellyfin uses different entry IDs and
// per-item moves; the UI hides the option for that backend).
export const reorderPlaylist = (auth: SubsonicAuth, id: string, songIds: string[]) =>
  Subsonic.reorderPlaylist(auth, id, songIds);

export const getScanStatus = (auth: SubsonicAuth) => api(auth).getScanStatus(auth);

export const startScan = (auth: SubsonicAuth) => api(auth).startScan(auth);

export const getLyrics = (auth: SubsonicAuth, artist: string, title: string) =>
  api(auth).getLyrics(auth, artist, title);

export const getLyricsBySongId = (auth: SubsonicAuth, id: string) =>
  api(auth).getLyricsBySongId(auth, id);

export const savePlayQueue = (
  auth: SubsonicAuth,
  ids: string[],
  currentId: string,
  positionMs: number,
) => api(auth).savePlayQueue(auth, ids, currentId, positionMs);

export const getPlayQueue = (auth: SubsonicAuth) => api(auth).getPlayQueue(auth);

export const scrobble = (auth: SubsonicAuth, id: string, submission?: boolean) =>
  api(auth).scrobble(auth, id, submission);

export const getRadioStations = (auth: SubsonicAuth) => api(auth).getRadioStations(auth);

export const createRadioStation = (
  auth: SubsonicAuth,
  name: string,
  streamUrl: string,
  homePageUrl?: string,
) => api(auth).createRadioStation(auth, name, streamUrl, homePageUrl);

export const updateRadioStation = (
  auth: SubsonicAuth,
  id: string,
  name: string,
  streamUrl: string,
  homePageUrl?: string,
) => api(auth).updateRadioStation(auth, id, name, streamUrl, homePageUrl);

export const deleteRadioStation = (auth: SubsonicAuth, id: string) =>
  api(auth).deleteRadioStation(auth, id);

export const coverArtUrl = (auth: SubsonicAuth, id: string | undefined, size?: number) =>
  api(auth).coverArtUrl(auth, id, size);

export const downloadUrl = (auth: SubsonicAuth, id: string) => api(auth).downloadUrl(auth, id);

export const streamUrl = (
  auth: SubsonicAuth,
  id: string,
  maxBitRate?: number,
  timeOffset?: number,
  format?: string,
) => api(auth).streamUrl(auth, id, maxBitRate, timeOffset, format);

/** Server OpenSubsonic extensions (Jellyfin doesn't have them: empty list). */
export const getOpenSubsonicExtensions = (auth: SubsonicAuth): Promise<string[]> =>
  auth.serverType === 'jellyfin'
    ? Promise.resolve([])
    : Subsonic.getOpenSubsonicExtensions(auth);
