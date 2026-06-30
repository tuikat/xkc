from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session
from sqlalchemy.pool import NullPool
from pathlib import Path
from .config import get_settings
import os


def get_db_url() -> str:
    settings = get_settings()
    db_path = Path(settings.data_dir) / "master.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path}"


engine = create_engine(
    get_db_url(),
    connect_args={"check_same_thread": False},
    poolclass=NullPool,
)


@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_conn, _):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    # Without this, concurrent writers (e.g. many simultaneous uploads each
    # committing a new track row) fail immediately with "database is locked"
    # instead of waiting briefly for the other writer to finish.
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
