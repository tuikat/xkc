from sqlalchemy import (
    Column, String, Integer, Float, Boolean, Text, DateTime,
    ForeignKey, JSON, LargeBinary, UniqueConstraint, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base
import uuid


def new_uuid():
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"
    id = Column(String(36), primary_key=True, default=new_uuid)
    username = Column(String(64), unique=True, nullable=False)
    email = Column(String(256), unique=True, nullable=True)
    password_hash = Column(String(256), nullable=False)
    is_admin = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    permissions = Column(JSON, default=lambda: {
        "upload": True, "delete": False, "edit_metadata": True,
        "manage_playlists": True, "share_playlists": False,
        "manage_tags": False, "export": True,
        "stream_sync": False, "rekordbox_import": False,
    })
    created_at = Column(DateTime, server_default=func.now())
    last_login = Column(DateTime, nullable=True)
    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")
    tracks = relationship("Track", back_populates="uploaded_by_user")
    playlists = relationship("Playlist", back_populates="owner")
    stream_sources = relationship("StreamSource", back_populates="user", cascade="all, delete-orphan")


class UserSession(Base):
    __tablename__ = "user_sessions"
    id = Column(String(36), primary_key=True, default=new_uuid)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    refresh_token_hash = Column(String(256), nullable=False, unique=True)
    device_label = Column(String(128), nullable=True)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    user = relationship("User", back_populates="sessions")


class Track(Base):
    __tablename__ = "tracks"
    id = Column(String(36), primary_key=True, default=new_uuid)
    file_path = Column(String(1024), nullable=False, unique=True)
    file_hash = Column(String(64), nullable=True)
    file_size = Column(Integer, nullable=True)
    file_format = Column(String(16), nullable=True)
    bitrate = Column(Integer, nullable=True)
    duration_ms = Column(Integer, nullable=True)

    # Metadata
    title = Column(String(512), nullable=True)
    artist = Column(String(512), nullable=True)
    album = Column(String(512), nullable=True)
    album_artist = Column(String(512), nullable=True)
    genre = Column(String(256), nullable=True)
    label = Column(String(256), nullable=True)
    remixer = Column(String(256), nullable=True)
    composer = Column(String(256), nullable=True)
    year = Column(Integer, nullable=True)
    track_number = Column(Integer, nullable=True)
    comment = Column(Text, nullable=True)
    isrc = Column(String(32), nullable=True)

    # Analysis
    bpm = Column(Float, nullable=True)
    bpm_analysed = Column(Boolean, default=False)
    key_camelot = Column(String(8), nullable=True)
    key_musical = Column(String(8), nullable=True)
    energy = Column(Float, nullable=True)
    artwork_path = Column(String(1024), nullable=True)

    # Analysis state
    analysis_state = Column(String(32), default="pending")  # pending/analyzing/complete/failed
    analysis_error = Column(Text, nullable=True)
    anlz_path = Column(String(1024), nullable=True)

    # User data
    rating = Column(Integer, default=0)
    play_count = Column(Integer, default=0)
    color = Column(Integer, default=0)

    # Relations
    uploaded_by = Column(String(36), ForeignKey("users.id"), nullable=True)
    source_type = Column(String(32), nullable=True)  # manual/spotify/soundcloud/rekordbox
    source_id = Column(String(256), nullable=True)
    date_added = Column(DateTime, server_default=func.now())

    uploaded_by_user = relationship("User", back_populates="tracks")
    tags = relationship("Tag", secondary="track_tags", back_populates="tracks")
    cues = relationship("Cue", back_populates="track", cascade="all, delete-orphan")
    beats = relationship("Beat", back_populates="track", cascade="all, delete-orphan", uselist=False)
    playlist_entries = relationship("PlaylistTrack", back_populates="track", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_tracks_artist", "artist"),
        Index("ix_tracks_bpm", "bpm"),
        Index("ix_tracks_date_added", "date_added"),
    )


class Beat(Base):
    __tablename__ = "beats"
    id = Column(String(36), primary_key=True, default=new_uuid)
    track_id = Column(String(36), ForeignKey("tracks.id", ondelete="CASCADE"), unique=True)
    beat_positions_ms = Column(JSON)  # list of float ms values
    downbeats_ms = Column(JSON)       # list of float ms values
    waveform_overview = Column(LargeBinary, nullable=True)   # compressed waveform data
    waveform_detail = Column(LargeBinary, nullable=True)
    track = relationship("Track", back_populates="beats")


class UserTrackMeta(Base):
    """Per-user overrides for shared track fields: rating, color, play_count, genre, comment."""
    __tablename__ = "user_track_meta"
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    track_id = Column(String(36), ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    rating = Column(Integer, nullable=True)
    color = Column(Integer, nullable=True)
    play_count = Column(Integer, default=0)
    genre = Column(String(512), nullable=True)
    comment = Column(Text, nullable=True)
    user = relationship("User")
    track = relationship("Track")


class Cue(Base):
    __tablename__ = "cues"
    id = Column(String(36), primary_key=True, default=new_uuid)
    track_id = Column(String(36), ForeignKey("tracks.id", ondelete="CASCADE"))

    position_ms = Column(Integer, nullable=False)
    type = Column(String(16), default="hot")  # hot/memory/loop_in/loop_out
    color = Column(Integer, default=0xCC0000)
    label = Column(String(64), nullable=True)
    loop_length_ms = Column(Integer, nullable=True)
    sort_order = Column(Integer, default=0)
    track = relationship("Track", back_populates="cues")


class TagGroup(Base):
    __tablename__ = "tag_groups"
    id = Column(String(36), primary_key=True, default=new_uuid)
    name = Column(String(64), nullable=False)
    sort_order = Column(Integer, default=0)
    tags = relationship("Tag", back_populates="group", cascade="all, delete-orphan")


class Tag(Base):
    __tablename__ = "tags"
    id = Column(String(36), primary_key=True, default=new_uuid)
    group_id = Column(String(36), ForeignKey("tag_groups.id", ondelete="CASCADE"))
    name = Column(String(64), nullable=False)
    color = Column(Integer, default=0x4A90D9)
    sort_order = Column(Integer, default=0)
    group = relationship("TagGroup", back_populates="tags")
    tracks = relationship("Track", secondary="track_tags", back_populates="tags")


class TrackTag(Base):
    __tablename__ = "track_tags"
    track_id = Column(String(36), ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    tag_id = Column(String(36), ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)


class Playlist(Base):
    __tablename__ = "playlists"
    id = Column(String(36), primary_key=True, default=new_uuid)
    name = Column(String(256), nullable=False)
    owner_id = Column(String(36), ForeignKey("users.id"), nullable=False)
    parent_id = Column(String(36), ForeignKey("playlists.id"), nullable=True)
    is_smart = Column(Boolean, default=False)
    smart_rules = Column(JSON, nullable=True)
    is_shared = Column(Boolean, default=False)
    share_permission = Column(String(16), default="view")  # view/edit
    sort_order = Column(Integer, default=0)
    cover_color = Column(Integer, default=0x4A90D9)
    created_at = Column(DateTime, server_default=func.now())
    source_stream_id = Column(String(36), ForeignKey("stream_sources.id"), nullable=True)

    owner = relationship("User", back_populates="playlists")
    tracks = relationship("PlaylistTrack", back_populates="playlist", cascade="all, delete-orphan",
                          order_by="PlaylistTrack.position")
    children = relationship("Playlist", back_populates="parent", foreign_keys=[parent_id])
    parent = relationship("Playlist", back_populates="children", foreign_keys=[parent_id], remote_side="Playlist.id")


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"
    playlist_id = Column(String(36), ForeignKey("playlists.id", ondelete="CASCADE"), primary_key=True)
    track_id = Column(String(36), ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    position = Column(Integer, default=0)
    added_at = Column(DateTime, server_default=func.now())
    added_by = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    playlist = relationship("Playlist", back_populates="tracks")
    track = relationship("Track", back_populates="playlist_entries")
    added_by_user = relationship("User", foreign_keys=[added_by])


class StreamSource(Base):
    __tablename__ = "stream_sources"
    id = Column(String(36), primary_key=True, default=new_uuid)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    service = Column(String(32), nullable=False)  # spotify/soundcloud/youtube
    display_name = Column(String(256), nullable=False)
    source_type = Column(String(32), nullable=False)  # playlist/liked/profile
    source_url = Column(String(2048), nullable=False)
    source_id = Column(String(256), nullable=True)
    sync_mode = Column(String(32), default="master_only")  # master_only/mirror_playlist
    auto_sync = Column(Boolean, default=False)
    sync_interval_hours = Column(Integer, default=24)
    download_quality = Column(String(16), default="best")
    last_synced_at = Column(DateTime, nullable=True)
    credentials = Column(JSON, nullable=True)
    mirror_playlist_id = Column(String(36), ForeignKey("playlists.id"), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    user = relationship("User", back_populates="stream_sources")
    sync_logs = relationship("StreamSyncLog", back_populates="source", cascade="all, delete-orphan")


class StreamSyncLog(Base):
    __tablename__ = "stream_sync_logs"
    id = Column(String(36), primary_key=True, default=new_uuid)
    source_id = Column(String(36), ForeignKey("stream_sources.id", ondelete="CASCADE"))
    started_at = Column(DateTime, server_default=func.now())
    completed_at = Column(DateTime, nullable=True)
    tracks_found = Column(Integer, default=0)
    tracks_downloaded = Column(Integer, default=0)
    tracks_skipped = Column(Integer, default=0)
    status = Column(String(32), default="running")  # running/complete/failed
    error = Column(Text, nullable=True)
    source = relationship("StreamSource", back_populates="sync_logs")


class AppSetting(Base):
    __tablename__ = "app_settings"
    key = Column(String(128), primary_key=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
