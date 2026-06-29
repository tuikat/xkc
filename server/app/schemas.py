from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List, Any, Dict
from datetime import datetime


# Auth
class LoginRequest(BaseModel):
    username: str
    password: str
    device_label: Optional[str] = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


# Users
class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8)
    email: Optional[str] = None
    is_admin: bool = False
    permissions: Optional[Dict[str, bool]] = None


class UserUpdate(BaseModel):
    username: Optional[str] = None
    email: Optional[str] = None
    is_active: Optional[bool] = None
    is_admin: Optional[bool] = None
    permissions: Optional[Dict[str, bool]] = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


class UserOut(BaseModel):
    id: str
    username: str
    email: Optional[str]
    is_admin: bool
    is_active: bool
    permissions: Dict[str, bool]
    created_at: datetime
    last_login: Optional[datetime]
    model_config = {"from_attributes": True}


# Tracks
class TrackOut(BaseModel):
    id: str
    title: Optional[str]
    artist: Optional[str]
    album: Optional[str]
    album_artist: Optional[str]
    genre: Optional[str]
    label: Optional[str]
    remixer: Optional[str]
    year: Optional[int]
    bpm: Optional[float]
    key_camelot: Optional[str]
    key_musical: Optional[str]
    duration_ms: Optional[int]
    bitrate: Optional[int]
    file_format: Optional[str]
    rating: int
    play_count: int
    color: int
    analysis_state: str
    source_type: Optional[str]
    date_added: datetime
    artwork_path: Optional[str]
    comment: Optional[str]
    model_config = {"from_attributes": True}


class TrackUpdate(BaseModel):
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    genre: Optional[str] = None
    label: Optional[str] = None
    remixer: Optional[str] = None
    composer: Optional[str] = None
    year: Optional[int] = None
    bpm: Optional[float] = None
    key_camelot: Optional[str] = None
    rating: Optional[int] = None
    color: Optional[int] = None
    comment: Optional[str] = None


# Cues
class CueOut(BaseModel):
    id: str
    position_ms: int
    type: str
    color: int
    label: Optional[str]
    loop_length_ms: Optional[int]
    sort_order: int
    model_config = {"from_attributes": True}


class CueCreate(BaseModel):
    position_ms: int
    type: str = "hot"
    color: int = 0xCC0000
    label: Optional[str] = None
    loop_length_ms: Optional[int] = None
    sort_order: int = 0


# Tags
class TagGroupOut(BaseModel):
    id: str
    name: str
    sort_order: int
    tags: List["TagOut"] = []
    model_config = {"from_attributes": True}


class TagOut(BaseModel):
    id: str
    group_id: str
    name: str
    color: int
    sort_order: int
    model_config = {"from_attributes": True}


class TagGroupCreate(BaseModel):
    name: str
    sort_order: int = 0


class TagCreate(BaseModel):
    group_id: str
    name: str
    color: int = 0x4A90D9
    sort_order: int = 0


# Playlists
class PlaylistOut(BaseModel):
    id: str
    name: str
    owner_id: str
    parent_id: Optional[str]
    is_smart: bool
    smart_rules: Optional[Any]
    is_shared: bool
    sort_order: int
    cover_color: int
    created_at: datetime
    track_count: int = 0
    model_config = {"from_attributes": True}


class PlaylistCreate(BaseModel):
    name: str
    parent_id: Optional[str] = None
    is_smart: bool = False
    smart_rules: Optional[Any] = None
    cover_color: int = 0x4A90D9


class PlaylistUpdate(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[str] = None
    is_shared: Optional[bool] = None
    share_permission: Optional[str] = None
    sort_order: Optional[int] = None
    cover_color: Optional[int] = None


class AddTracksToPlaylist(BaseModel):
    track_ids: List[str]
    position: Optional[int] = None


# Stream Sources
class StreamSourceCreate(BaseModel):
    service: str
    display_name: str
    source_type: str
    source_url: str
    sync_mode: str = "master_only"
    auto_sync: bool = False
    sync_interval_hours: int = 24
    download_quality: str = "best"


class StreamSourceOut(BaseModel):
    id: str
    service: str
    display_name: str
    source_type: str
    source_url: str
    sync_mode: str
    auto_sync: bool
    sync_interval_hours: int
    last_synced_at: Optional[datetime]
    mirror_playlist_id: Optional[str]
    created_at: datetime
    model_config = {"from_attributes": True}


# Export
class ExportRequest(BaseModel):
    playlist_ids: List[str]
    format: str = "pioneer"  # pioneer / flat


# Rekordbox Import Preview
class RekordboxImportPreview(BaseModel):
    track_count: int
    playlist_count: int
    playlists: List[str]


class RekordboxImportConfirm(BaseModel):
    import_all: bool = True
    playlist_names: Optional[List[str]] = None
    playlist_prefix: str = "RB Import"
