"""Pioneer Device Library Plus / OneLibrary (exportLibrary.db) writer.

exportLibrary.db is a SQLCipher-encrypted SQLite database written to
PIONEER/rekordbox/exportLibrary.db, read by OPUS-QUAD, OMNIS-DUO, XDJ-AZ,
CDJ-3000X, and CDJ-3000 units on firmware that requires Device Library Plus.
Some CDJ-3000 firmware versions do not fall back to the legacy
PIONEER/rekordbox/export.pdb database when this file is absent, so both are
now written to the same export (see pdb_export.py).

Ground truth used here, and how confident each piece is:

- Encryption key: HIGH CONFIDENCE. Publicly documented as static/shared
  across all Device Library Plus databases, independently reverse-engineered
  by multiple open-source projects (pyrekordbox, rbox, onelibrary-connect).
  Verified directly here against a real, validly-encrypted database -- not
  just copied from a source. No special SQLCipher tuning (kdf_iter,
  cipher_page_size, etc) is needed beyond the key itself.

- Schema (table/column names, types, foreign keys below): HIGH CONFIDENCE
  for the shape of the data, MEDIUM for exact semantics of a few fields.
  Dumped directly from `sqlite_master` of a real, validly-encrypted
  OneLibrary database (not reconstructed from docs or guessed). That
  reference database was created by a third-party open-source tool though,
  not genuine rekordbox software, so it has not been cross-checked against
  an actual rekordbox export -- if you're ever able to get one (even a
  rekordbox trial export of a couple of tracks), diffing its schema against
  this one would be the single most valuable verification step available.

- `cue.kind` values (hot cue slot 1-8 vs memory cue vs loop): LOW
  CONFIDENCE. The `cue` table has no obviously-named "is this a hot cue"
  column, so `kind` is inferred to double as that discriminator by
  elimination, not confirmed. This is the most likely thing to need
  correction from real hot-cue testing.

- `content.fileType` / playlist `attribute` enum integers: MEDIUM
  CONFIDENCE. Inferred from declaration order in a third-party tool's
  public enum, not independently confirmed against real files.
"""
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Documented as static across all Device Library Plus databases -- not
# XKC-specific or license-specific.
DLP_KEY = "r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls"

# MEDIUM CONFIDENCE: inferred from declaration order of a third-party tool's
# FileType enum, not independently confirmed.
FILE_TYPE = {
    'mp3': 0, 'mp4': 2, 'alac': 3, 'flac': 4, 'm4a': 5,
    'wav': 6, 'aiff': 7, 'aif': 7, 'ogg': 0, 'opus': 0,
}
PLAYLIST_TYPE_LIST = 0
PLAYLIST_TYPE_FOLDER = 1

# LOW CONFIDENCE: see module docstring. cue.kind 0 = memory cue/loop,
# 1-8 = hot cue slots A-H. Loops are distinguished by beatLoopNumerator
# being set rather than a separate `kind` value.
CUE_KIND_MEMORY = 0

_SCHEMA_STATEMENTS = [
    """CREATE TABLE `album`(
        `album_id` INTEGER PRIMARY KEY,
        `name` TEXT NOT NULL,
        `artist_id` INTEGER,
        `image_id` INTEGER,
        `isComplation` INTEGER NOT NULL,
        `nameForSearch` TEXT,
        FOREIGN KEY (`artist_id`) REFERENCES `artist`(`id`),
        FOREIGN KEY (`image_id`) REFERENCES `image`(`id`)
    )""",
    """CREATE TABLE `artist`(
        `artist_id` INTEGER PRIMARY KEY,
        `name` TEXT NOT NULL,
        `nameForSearch` TEXT
    )""",
    """CREATE TABLE `category`(
        `category_id` INTEGER PRIMARY KEY,
        `menuitem_id` INTEGER NOT NULL,
        `sequenceNo` INTEGER NOT NULL,
        `isVisible` INTEGER NOT NULL
    )""",
    """CREATE TABLE `color`(
        `color_id` INTEGER PRIMARY KEY,
        `name` TEXT NOT NULL
    )""",
    """CREATE TABLE `content`(
        `content_id` INTEGER PRIMARY KEY,
        `title` TEXT,
        `titleForSearch` TEXT,
        `subtitle` TEXT,
        `bpmx100` INTEGER,
        `length` INTEGER,
        `trackNo` INTEGER,
        `discNo` INTEGER,
        `artist_id_artist` INTEGER,
        `artist_id_remixer` INTEGER,
        `artist_id_originalArtist` INTEGER,
        `artist_id_composer` INTEGER,
        `artist_id_lyricist` INTEGER,
        `album_id` INTEGER,
        `genre_id` INTEGER,
        `label_id` INTEGER,
        `key_id` INTEGER,
        `color_id` INTEGER,
        `image_id` INTEGER,
        `djComment` TEXT,
        `rating` INTEGER,
        `releaseYear` INTEGER,
        `releaseDate` TEXT,
        `dateCreated` TEXT NOT NULL,
        `dateAdded` TEXT NOT NULL,
        `path` TEXT NOT NULL,
        `fileName` TEXT,
        `fileSize` INTEGER,
        `fileType` INTEGER,
        `bitrate` INTEGER,
        `bitDepth` INTEGER,
        `samplingRate` INTEGER,
        `isrc` TEXT,
        `isHotCueAutoLoadOn` INTEGER,
        `isKuvoDeliverStatusOn` INTEGER,
        `kuvoDeliveryComment` TEXT,
        `masterDbId` INTEGER,
        `masterContentId` INTEGER,
        `analysisDataFilePath` TEXT,
        `analysedBits` INTEGER,
        `contentLink` INTEGER,
        `hasModified` INTEGER,
        `cueUpdateCount` INTEGER,
        `analysisDataUpdateCount` INTEGER,
        `informationUpdateCount` INTEGER,
        FOREIGN KEY (`album_id`) REFERENCES `album`(`id`),
        FOREIGN KEY (`genre_id`) REFERENCES `genre`(`id`),
        FOREIGN KEY (`label_id`) REFERENCES `label`(`id`),
        FOREIGN KEY (`key_id`) REFERENCES `key`(`id`),
        FOREIGN KEY (`color_id`) REFERENCES `color`(`id`),
        FOREIGN KEY (`image_id`) REFERENCES `image`(`id`)
    )""",
    """CREATE TABLE `cue`(
        `cue_id` INTEGER PRIMARY KEY,
        `content_id` INTEGER NOT NULL,
        `kind` INTEGER,
        `colorTableIndex` INTEGER,
        `cueComment` TEXT,
        `isActiveLoop` INTEGER,
        `beatLoopNumerator` INTEGER,
        `beatLoopDenominator` INTEGER,
        `inUsec` INTEGER,
        `outUsec` INTEGER,
        `in150FramePerSec` INTEGER,
        `out150FramePerSec` INTEGER,
        `inMpegFrameNumber` INTEGER,
        `outMpegFrameNumber` INTEGER,
        `inMpegAbs` INTEGER,
        `outMpegAbs` INTEGER,
        `inDecodingStartFramePosition` INTEGER,
        `outDecodingStartFramePosition` INTEGER,
        `inFileOffsetInBlock` INTEGER,
        `outFileOffsetInBlock` INTEGER,
        `inNumberOfSampleInBlock` INTEGER,
        `outNumberOfSampleInBlock` INTEGER
    )""",
    """CREATE TABLE `genre`(
        `genre_id` INTEGER PRIMARY KEY,
        `name` TEXT NOT NULL
    )""",
    """CREATE TABLE `history`(
        `history_id` INTEGER PRIMARY KEY,
        `sequenceNo` INTEGER NOT NULL,
        `name` TEXT NOT NULL,
        `attribute` INTEGER NOT NULL,
        `history_id_parent` INTEGER NOT NULL
    )""",
    """CREATE TABLE `history_content`(
        `history_id` INTEGER NOT NULL,
        `content_id` INTEGER NOT NULL,
        `sequenceNo` INTEGER NOT NULL,
        PRIMARY KEY(`history_id`, `content_id`)
    )""",
    """CREATE TABLE `hotCueBankList`(
        `hotCueBankList_id` INTEGER PRIMARY KEY,
        `sequenceNo` INTEGER NOT NULL,
        `name` TEXT,
        `image_id` INTEGER,
        `attribute` INTEGER NOT NULL,
        `hotCueBankList_id_parent` INTEGER
    )""",
    """CREATE TABLE `hotCueBankList_cue`(
        `hotCueBankList_id` INTEGER NOT NULL,
        `cue_id` INTEGER NOT NULL,
        `sequenceNo` INTEGER NOT NULL,
        PRIMARY KEY(`hotCueBankList_id`, `cue_id`)
    )""",
    """CREATE TABLE `image`(
        `image_id` INTEGER PRIMARY KEY,
        `path` TEXT NOT NULL
    )""",
    """CREATE TABLE `key`(
        `key_id` INTEGER PRIMARY KEY,
        `name` TEXT NOT NULL
    )""",
    """CREATE TABLE `label`(
        `label_id` INTEGER PRIMARY KEY,
        `name` TEXT NOT NULL
    )""",
    """CREATE TABLE `menuItem`(
        `menuItem_id` INTEGER PRIMARY KEY,
        `kind` INTEGER NOT NULL,
        `name` TEXT NOT NULL
    )""",
    """CREATE TABLE `myTag`(
        `myTag_id` INTEGER PRIMARY KEY,
        `sequenceNo` INTEGER NOT NULL,
        `name` TEXT NOT NULL,
        `attribute` INTEGER NOT NULL,
        `myTag_id_parent` INTEGER NOT NULL
    )""",
    """CREATE TABLE `myTag_content`(
        `myTag_id` INTEGER NOT NULL,
        `content_id` INTEGER NOT NULL,
        PRIMARY KEY(`myTag_id`, `content_id`)
    )""",
    """CREATE TABLE `playlist`(
        `playlist_id` INTEGER PRIMARY KEY,
        `sequenceNo` INTEGER NOT NULL,
        `name` TEXT NOT NULL,
        `image_id` INTEGER,
        `attribute` INTEGER NOT NULL,
        `playlist_id_parent` INTEGER NOT NULL
    )""",
    """CREATE TABLE `playlist_content`(
        `playlist_id` INTEGER NOT NULL,
        `content_id` INTEGER NOT NULL,
        `sequenceNo` INTEGER NOT NULL,
        PRIMARY KEY(`playlist_id`, `content_id`)
    )""",
    """CREATE TABLE `property`(
        `deviceName` TEXT NOT NULL,
        `dbVersion` TEXT NOT NULL,
        `numberOfContents` INTEGER NOT NULL,
        `createdDate` TEXT NOT NULL,
        `backGroundColorType` INTEGER NOT NULL,
        `myTagMasterDBID` INTEGER NOT NULL
    )""",
    """CREATE TABLE `recommendedLike`(
        `content_id_1` INTEGER NOT NULL,
        `content_id_2` INTEGER NOT NULL,
        `rating` INTEGER NOT NULL,
        `createdDate` TEXT NOT NULL,
        PRIMARY KEY(`content_id_1`, `content_id_2`)
    )""",
    """CREATE TABLE `sort`(
        `sort_id` INTEGER PRIMARY KEY,
        `menuItem_id` INTEGER NOT NULL,
        `sequenceNo` INTEGER NOT NULL,
        `isVisible` INTEGER NOT NULL,
        `isSelectedAsSubColumn` INTEGER NOT NULL
    )""",
]

# Fixed reference/lookup data that a real rekordbox export seeds into every
# Device Library Plus database regardless of library content -- verified byte
# -for-byte against a real device's exportLibrary.db (small 2-track test
# export still had all of this populated). Without these, a CDJ has nothing
# to build its browse menu (menuItem/category/sort) or color-coding UI
# (color) from, and rekordbox's own validator may check for their presence.
# The ￺/￻ wrapper characters around menuItem names are Unicode
# "interlinear annotation" marks (U+FFFA/U+FFFB) that rekordbox/CDJ firmware
# uses to substitute the localized menu label at display time -- preserved
# byte-for-byte from the real device, not decorative.
_MENU_ITEMS = [
    (1, 128, "￺GENRE￻"), (2, 129, "￺ARTIST￻"),
    (3, 130, "￺ALBUM￻"), (4, 131, "￺TRACK￻"),
    (5, 133, "￺BPM￻"), (6, 134, "￺RATING￻"),
    (7, 135, "￺YEAR￻"), (8, 136, "￺REMIXER￻"),
    (9, 137, "￺LABEL￻"), (10, 138, "￺ORIGINAL ARTIST￻"),
    (11, 139, "￺KEY￻"), (12, 141, "￺CUE￻"),
    (13, 142, "￺COLOR￻"), (14, 146, "￺TIME￻"),
    (15, 147, "￺BITRATE￻"), (16, 148, "￺FILE NAME￻"),
    (17, 132, "￺PLAYLIST￻"), (18, 152, "￺HOT CUE BANK￻"),
    (19, 149, "￺HISTORY￻"), (20, 145, "￺SEARCH￻"),
    (21, 150, "￺COMMENTS￻"), (22, 140, "￺DATE ADDED￻"),
    (23, 151, "￺DJ PLAY COUNT￻"), (24, 144, "￺FOLDER￻"),
    (25, 161, "￺DEFAULT￻"), (26, 162, "￺ALPHABET￻"),
    (27, 170, "￺MATCHING￻"),
]
_CATEGORIES = [
    (1, 1, 0, 0), (2, 2, 1, 1), (3, 3, 2, 1), (4, 4, 3, 1), (5, 17, 5, 1),
    (6, 5, 0, 0), (7, 6, 0, 0), (8, 7, 0, 0), (9, 8, 0, 0), (10, 9, 0, 0),
    (11, 10, 0, 0), (12, 11, 4, 1), (15, 13, 0, 0), (17, 24, 9, 1),
    (18, 20, 7, 1), (19, 14, 0, 0), (20, 15, 0, 0), (21, 16, 0, 0),
    (22, 19, 6, 1), (23, 18, 0, 0), (26, 27, 8, 1), (27, 22, 10, 0),
]
_SORTS = [
    (0, 25, 1, 1, 0), (1, 26, 2, 1, 0), (2, 2, 3, 1, 0), (3, 3, 4, 1, 0),
    (4, 5, 5, 1, 0), (5, 6, 6, 1, 0), (6, 1, 0, 0, 0), (7, 21, 0, 0, 0),
    (8, 14, 0, 0, 0), (9, 8, 0, 0, 0), (10, 9, 0, 0, 0), (11, 10, 0, 0, 0),
    (12, 11, 7, 1, 0), (13, 15, 0, 0, 0), (15, 13, 0, 0, 0),
    (16, 23, 0, 0, 0), (17, 22, 0, 0, 0),
]
_COLORS = [
    (1, "Pink"), (2, "Red"), (3, "Orange"), (4, "Yellow"),
    (5, "Green"), (6, "Aqua"), (7, "Blue"), (8, "Purple"),
]
# Standard My Tag preset hierarchy (4 top-level categories, 24 child tags).
# IDs are opaque/large on the real device (not sequential) -- copied
# verbatim since they're a fixed preset library, not per-track generated.
_MY_TAGS = [
    (1, 0, "Genre", 1, 0), (2, 1, "Components", 1, 0), (3, 2, "Situation", 1, 0),
    (4, 3, "Untitled Column", 1, 0),
    (31119643, 6, "Trap", 0, 1), (233353604, 2, "Lounge", 0, 3),
    (307356157, 2, "Beat", 0, 2), (467736369, 3, "Mid Night", 0, 3),
    (577044029, 1, "Vocal", 0, 2), (683321797, 1, "Deep House", 0, 1),
    (1139528591, 5, "Build up", 0, 3), (1145691039, 3, "Sub Bass", 0, 2),
    (1260156560, 5, "Bass Music", 0, 1), (1551943846, 4, "Electro House", 0, 1),
    (1560894668, 4, "Percussion", 0, 2), (1748645585, 2, "Techno", 0, 1),
    (1783890014, 1, "Second Floor", 0, 3), (1819948694, 7, "Build down", 0, 3),
    (2565881963, 0, "Synth", 0, 2), (2662600583, 7, "Upper", 0, 2),
    (3035367868, 0, "Acid House", 0, 1), (3134770480, 4, "Morning", 0, 3),
    (3151014943, 0, "My Comment", 0, 4), (3413658105, 0, "Main Floor", 0, 3),
    (3691474187, 3, "Nu Disco", 0, 1), (3769730008, 5, "Piano", 0, 2),
    (4147545811, 6, "Dark", 0, 2), (4151666520, 6, "Peak Time", 0, 3),
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class DLPWriter:
    """Builds a fresh exportLibrary.db from scratch at `path`."""

    def __init__(self, path: str, device_name: str = "XKC"):
        from sqlcipher3 import dbapi2 as sqlite3
        Path(path).unlink(missing_ok=True)
        Path(path + "-wal").unlink(missing_ok=True)
        Path(path + "-shm").unlink(missing_ok=True)
        self._path = path
        self.con = sqlite3.connect(path)
        cur = self.con.cursor()
        cur.execute(f"PRAGMA key = '{DLP_KEY}';")
        # Real rekordbox-exported libraries are left in WAL journal mode (they ship
        # with exportLibrary.db-shm/-wal sidecar files). Match that on-disk shape --
        # some CDJ firmware may sanity-check the journal-mode byte in the SQLite
        # header and reject a plain rollback-journal file as "not a real export".
        cur.execute("PRAGMA journal_mode = WAL;")
        for stmt in _SCHEMA_STATEMENTS:
            cur.execute(stmt)
        cur.executemany("INSERT INTO `menuItem` VALUES (?,?,?)", _MENU_ITEMS)
        cur.executemany("INSERT INTO `category` VALUES (?,?,?,?)", _CATEGORIES)
        cur.executemany("INSERT INTO `sort` VALUES (?,?,?,?,?)", _SORTS)
        cur.executemany("INSERT INTO `color` VALUES (?,?)", _COLORS)
        cur.executemany("INSERT INTO `myTag` VALUES (?,?,?,?,?)", _MY_TAGS)
        self.con.commit()
        self.device_name = device_name
        self._artist_ids: dict = {}
        self._genre_ids: dict = {}
        self._label_ids: dict = {}
        self._key_ids: dict = {}
        self._color_ids: dict = {name: cid for cid, name in _COLORS}
        self._image_ids: dict = {}
        self._album_ids: dict = {}
        self._track_count = 0

    def _get_or_create(self, cache: dict, table: str, name: Optional[str]) -> Optional[int]:
        if not name:
            return None
        if name in cache:
            return cache[name]
        cur = self.con.cursor()
        cur.execute(f"INSERT INTO `{table}` (name) VALUES (?)", (name,))
        new_id = cur.lastrowid
        cache[name] = new_id
        return new_id

    def get_or_create_artist(self, name: Optional[str]) -> Optional[int]:
        return self._get_or_create(self._artist_ids, "artist", name)

    def get_or_create_genre(self, name: Optional[str]) -> Optional[int]:
        return self._get_or_create(self._genre_ids, "genre", name)

    def get_or_create_label(self, name: Optional[str]) -> Optional[int]:
        return self._get_or_create(self._label_ids, "label", name)

    def get_or_create_key(self, name: Optional[str]) -> Optional[int]:
        return self._get_or_create(self._key_ids, "key", name)

    def get_or_create_color(self, name: Optional[str]) -> Optional[int]:
        # color is a fixed 8-row reference table seeded at construction time
        # (matches the real device exactly) -- look up only, never insert.
        return self._color_ids.get(name) if name else None

    def get_or_create_image(self, path: Optional[str]) -> Optional[int]:
        if not path:
            return None
        if path in self._image_ids:
            return self._image_ids[path]
        cur = self.con.cursor()
        cur.execute("INSERT INTO `image` (path) VALUES (?)", (path,))
        new_id = cur.lastrowid
        self._image_ids[path] = new_id
        return new_id

    def get_or_create_album(self, name: Optional[str], artist_id: Optional[int] = None,
                             image_id: Optional[int] = None) -> Optional[int]:
        if not name:
            return None
        cache_key = (name, artist_id)
        if cache_key in self._album_ids:
            return self._album_ids[cache_key]
        cur = self.con.cursor()
        cur.execute(
            "INSERT INTO `album` (name, artist_id, image_id, isComplation, nameForSearch) VALUES (?,?,?,?,?)",
            (name, artist_id, image_id, 0, name),
        )
        new_id = cur.lastrowid
        self._album_ids[cache_key] = new_id
        return new_id

    def add_track(
        self, *, title: str, path: str, ext: str, date_added: str,
        artist_id: Optional[int] = None, remixer_id: Optional[int] = None,
        album_id: Optional[int] = None, genre_id: Optional[int] = None,
        label_id: Optional[int] = None, key_id: Optional[int] = None,
        color_id: Optional[int] = None, image_id: Optional[int] = None,
        bpm: Optional[float] = None, duration_s: Optional[int] = None,
        rating: int = 0, comment: Optional[str] = None, isrc: Optional[str] = None,
        file_size: Optional[int] = None, bitrate: Optional[int] = None,
        year: Optional[int] = None, file_name: Optional[str] = None,
        analysis_path: Optional[str] = None,
    ) -> int:
        cur = self.con.cursor()
        file_type = FILE_TYPE.get(ext.lstrip('.').lower(), 0)
        cur.execute(
            """INSERT INTO `content` (
                title, titleForSearch, artist_id_artist, artist_id_remixer, album_id, genre_id,
                label_id, key_id, color_id, image_id, djComment, rating, releaseYear,
                dateCreated, dateAdded, path, fileName, fileSize, fileType, bitrate,
                samplingRate, isrc, isHotCueAutoLoadOn, analysisDataFilePath, bpmx100, length
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                title, title, artist_id, remixer_id, album_id, genre_id,
                label_id, key_id, color_id, image_id, comment, rating, year,
                date_added, date_added, path, file_name, file_size, file_type, bitrate,
                44100, isrc, 0, analysis_path,
                int(round(bpm * 100)) if bpm else None, duration_s,
            ),
        )
        self._track_count += 1
        return cur.lastrowid

    def add_cue(
        self, content_id: int, *, position_ms: int, hot_cue_slot: Optional[int] = None,
        color_index: Optional[int] = None, comment: Optional[str] = None,
        loop_length_ms: Optional[int] = None,
    ) -> int:
        cur = self.con.cursor()
        kind = hot_cue_slot if hot_cue_slot else CUE_KIND_MEMORY
        in_usec = int(position_ms) * 1000
        out_usec = int(position_ms + loop_length_ms) * 1000 if loop_length_ms else None
        cur.execute(
            """INSERT INTO `cue` (
                content_id, kind, colorTableIndex, cueComment, isActiveLoop,
                beatLoopNumerator, beatLoopDenominator, inUsec, outUsec
            ) VALUES (?,?,?,?,?,?,?,?,?)""",
            (content_id, kind, color_index, comment, 0,
             1 if loop_length_ms else None, 1 if loop_length_ms else None,
             in_usec, out_usec),
        )
        return cur.lastrowid

    def add_playlist(self, name: str, parent_id: int = 0, sort_order: int = 0,
                      is_folder: bool = False) -> int:
        cur = self.con.cursor()
        cur.execute(
            "INSERT INTO `playlist` (sequenceNo, name, attribute, playlist_id_parent) VALUES (?,?,?,?)",
            (sort_order, name, PLAYLIST_TYPE_FOLDER if is_folder else PLAYLIST_TYPE_LIST, parent_id),
        )
        return cur.lastrowid

    def add_playlist_entry(self, playlist_id: int, content_id: int, sort_order: int):
        cur = self.con.cursor()
        cur.execute(
            "INSERT INTO `playlist_content` (playlist_id, content_id, sequenceNo) VALUES (?,?,?)",
            (playlist_id, content_id, sort_order),
        )

    def finalize(self, my_tag_master_dbid: int = 1):
        cur = self.con.cursor()
        cur.execute(
            """INSERT INTO `property` (
                deviceName, dbVersion, numberOfContents, createdDate, backGroundColorType, myTagMasterDBID
            ) VALUES (?,?,?,?,?,?)""",
            (self.device_name, "1000", self._track_count, _now_iso(), 0, my_tag_master_dbid),
        )
        self.con.commit()

        # sqlite3_close() runs an implicit final checkpoint that merges and
        # deletes the -wal/-shm sidecar files. Real rekordbox exports ship with
        # those files still present (rekordbox never cleanly checkpoints before
        # the USB is ejected) -- capture their bytes before close and restore
        # them afterward so the on-disk file set matches a real device exactly.
        wal_path = self._path + "-wal"
        shm_path = self._path + "-shm"
        wal_bytes = Path(wal_path).read_bytes() if Path(wal_path).exists() else None
        shm_bytes = Path(shm_path).read_bytes() if Path(shm_path).exists() else None

        self.con.close()

        if wal_bytes is not None:
            Path(wal_path).write_bytes(wal_bytes)
        if shm_bytes is not None:
            Path(shm_path).write_bytes(shm_bytes)
