"""add users.role + system_configs table

Revision ID: b1c2d3e4f5a6
Revises: 9a787407d654
Create Date: 2026-08-11 12:00:00.000000
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5a6'
down_revision: str | None = '9a787407d654'
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # users.role：默认 'user'，非空（存量用户回填为普通用户）
    op.add_column(
        'users',
        sa.Column(
            'role',
            sa.String(length=20),
            server_default=sa.text("'user'"),
            nullable=False,
        ),
    )
    # system_configs：键值型系统配置
    op.create_table(
        'system_configs',
        sa.Column(
            'id',
            sa.String(length=36),
            server_default=sa.text('gen_random_uuid()'),
            nullable=False,
        ),
        sa.Column('key', sa.String(length=255), nullable=False),
        sa.Column('config_value', postgresql.JSONB(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('updated_by', sa.String(length=255), nullable=True),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key'),
    )


def downgrade() -> None:
    op.drop_table('system_configs')
    op.drop_column('users', 'role')
