from pydantic_settings import BaseSettings
from functools import lru_cache
import secrets


class Settings(BaseSettings):
    # Server
    public_url: str = "http://localhost:3001"
    secret_key: str = secrets.token_hex(32)
    data_dir: str = "/data"
    max_upload_mb: int = 500
    analysis_workers: int = 2
    port: int = 3001

    # Auth
    access_token_expire_minutes: int = 60 * 24 * 7      # 7 days
    refresh_token_expire_days: int = 30

    # Spotify
    spotify_client_id: str = ""
    spotify_client_secret: str = ""

    # First-run admin password (set via env, hashed on first boot)
    admin_password: str = "changeme"
    admin_username: str = "admin"

    model_config = {"env_prefix": "XKC_", "env_file": ".env"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
