from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.schemas import TagGroupCreate, TagCreate, TagGroupOut, TagOut
from app.dependencies import get_current_user, require_permission
from app import models

router = APIRouter(prefix="/tags", tags=["tags"])

MAX_TAG_GROUPS = 4


@router.get("/", response_model=List[TagGroupOut])
def list_tag_groups(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    return db.query(models.TagGroup).order_by(models.TagGroup.sort_order).all()


@router.post("/groups", status_code=status.HTTP_201_CREATED)
def create_tag_group(
    body: TagGroupCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_tags")),
):
    count = db.query(models.TagGroup).count()
    if count >= MAX_TAG_GROUPS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Maximum of {MAX_TAG_GROUPS} tag groups allowed (Rekordbox limit)",
        )
    group = models.TagGroup(name=body.name, sort_order=body.sort_order)
    db.add(group)
    db.commit()
    db.refresh(group)
    return group


@router.patch("/groups/{group_id}")
def update_tag_group(
    group_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_tags")),
):
    group = db.query(models.TagGroup).filter(models.TagGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Tag group not found")
    if "name" in body:
        group.name = body["name"]
    if "sort_order" in body:
        group.sort_order = body["sort_order"]
    db.commit()
    db.refresh(group)
    return group


@router.delete("/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag_group(
    group_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_tags")),
):
    group = db.query(models.TagGroup).filter(models.TagGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Tag group not found")
    db.delete(group)
    db.commit()


@router.post("/", response_model=TagOut, status_code=status.HTTP_201_CREATED)
def create_tag(
    body: TagCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_tags")),
):
    group = db.query(models.TagGroup).filter(models.TagGroup.id == body.group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Tag group not found")
    tag = models.Tag(
        group_id=body.group_id,
        name=body.name,
        color=body.color,
        sort_order=body.sort_order,
    )
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return tag


@router.patch("/{tag_id}", response_model=TagOut)
def update_tag(
    tag_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_tags")),
):
    tag = db.query(models.Tag).filter(models.Tag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    if "name" in body:
        tag.name = body["name"]
    if "color" in body:
        tag.color = body["color"]
    if "sort_order" in body:
        tag.sort_order = body["sort_order"]
    db.commit()
    db.refresh(tag)
    return tag


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag(
    tag_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_tags")),
):
    tag = db.query(models.Tag).filter(models.Tag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    db.delete(tag)
    db.commit()
