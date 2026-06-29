import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .database import Base, engine, SessionLocal
from . import models
from .auth import hash_password

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def init_db():
    Base.metadata.create_all(bind=engine)
    settings = get_settings()
    db = SessionLocal()
    try:
        # Create directories
        for subdir in ["tracks", "artwork", "anlz", "exports"]:
            (Path(settings.data_dir) / subdir).mkdir(parents=True, exist_ok=True)

        # Bootstrap admin user if none exists
        admin = db.query(models.User).filter(models.User.is_admin == True).first()
        if not admin:
            admin = models.User(
                username=settings.admin_username,
                password_hash=hash_password(settings.admin_password),
                is_admin=True,
                is_active=True,
                permissions={
                    "upload": True, "delete": True, "edit_metadata": True,
                    "manage_playlists": True, "share_playlists": True,
                    "manage_tags": True, "export": True,
                    "stream_sync": True, "rekordbox_import": True,
                },
            )
            db.add(admin)

        # Bootstrap default tag groups if none exist
        if db.query(models.TagGroup).count() == 0:
            for i, (name, tags) in enumerate([
                ("Genre", ["House", "Techno", "Drum & Bass", "Ambient", "Hip Hop"]),
                ("Energy", ["High", "Medium", "Low", "Build", "Drop"]),
                ("Vibe", ["Dark", "Euphoric", "Groovy", "Minimal", "Melodic"]),
                ("Situation", ["Opening", "Peak Hour", "After Hours", "Warm Up", "Cool Down"]),
            ]):
                group = models.TagGroup(name=name, sort_order=i)
                db.add(group)
                db.flush()
                for j, tag_name in enumerate(tags):
                    db.add(models.Tag(group_id=group.id, name=tag_name, sort_order=j))

        db.commit()
        logger.info("Database initialized")
    except Exception as e:
        logger.error(f"DB init failed: {e}")
        db.rollback()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("XKC server started")
    yield
    logger.info("XKC server stopping")


app = FastAPI(
    title="XKC",
    version="1.0.0",
    description="XKC DJ Library Management",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
)

settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routers — each router defines its own path prefix, we just add /api
from .routers import auth, users, tracks, playlists, tags, export, stream_sync, imports, settings as settings_router, sync

app.include_router(auth.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(tracks.router, prefix="/api")
app.include_router(playlists.router, prefix="/api")
app.include_router(tags.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(stream_sync.router, prefix="/api")
app.include_router(imports.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")
app.include_router(sync.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


# Serve React frontend (static files built into /app/static)
static_dir = Path(__file__).parent.parent / "static"
if static_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(static_dir / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        index = static_dir / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return {"error": "Frontend not built"}
